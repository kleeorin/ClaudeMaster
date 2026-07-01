import { execFile } from 'child_process'
import { app } from 'electron'
import { join } from 'path'
import type { RemoteConfig } from '../shared/types'

// OpenSSH connection multiplexing. fs/git polling (directory reads, `git status`)
// fires often, so a fresh TCP+auth handshake per call would be unusably slow.
// ControlMaster keeps one connection alive and routes every later ssh call over
// it; ControlPersist keeps it warm briefly after the last use.
function controlArgs(): string[] {
  const cm = join(app.getPath('userData'), 'ssh-cm-%r@%h:%p')
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${cm}`,
    '-o', 'ControlPersist=120',
  ]
}

// Base ssh argv up to (and including) the destination. `batch` = non-interactive:
// BatchMode makes a call fail fast instead of blocking on a password/host-key
// prompt — right for fs/git/test. The interactive pty path passes batch=false so
// key/agent auth (and a first-time host-key prompt) can still happen in the term.
export function sshBaseArgs(remote: RemoteConfig, batch = true): string[] {
  return [
    ...controlArgs(),
    ...(batch ? ['-o', 'BatchMode=yes'] : []),
    ...(remote.sshOptions ?? []),
    remote.host,
  ]
}

// POSIX single-quote escaping: wrap in single quotes and replace embedded quotes
// with '\''. A remote command travels to ssh as one shell string, so every arg
// we compose must be quoted to avoid word-splitting / injection.
export function shquote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function shquoteJoin(argv: string[]): string {
  return argv.map(shquote).join(' ')
}

export interface RunResult { stdout: string; stderr: string; code: number }

// Run a command on the remote as an argv (each element is shell-quoted). Never
// rejects on a non-zero remote exit — returns the code so callers decide (mirrors
// how gitManager inspects exit 128). Rejects only on ssh transport failure.
export function run(
  remote: RemoteConfig,
  argv: string[],
  opts: { input?: string | Buffer; maxBuffer?: number } = {},
): Promise<RunResult> {
  const args = [...sshBaseArgs(remote), shquoteJoin(argv)]
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      args,
      { maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const code = (err as (NodeJS.ErrnoException & { code?: number }) | null)?.code
        // execFile sets err for non-zero exit; a numeric code means the remote
        // command ran and exited — resolve with it. A non-numeric code (ENOENT,
        // etc.) is a real ssh/spawn failure — reject.
        if (err && typeof code !== 'number') return reject(err)
        resolve({
          stdout: (stdout as unknown as Buffer).toString('utf8'),
          stderr: (stderr as unknown as Buffer).toString('utf8'),
          code: typeof code === 'number' ? code : 0,
        })
      },
    )
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }
  })
}

// Like run(), but returns raw stdout bytes — for binary file reads (images/PDFs)
// where a utf8 round-trip would corrupt the data.
export function runBuffer(
  remote: RemoteConfig,
  argv: string[],
  opts: { maxBuffer?: number } = {},
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  const args = [...sshBaseArgs(remote), shquoteJoin(argv)]
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      args,
      { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const code = (err as (NodeJS.ErrnoException & { code?: number }) | null)?.code
        if (err && typeof code !== 'number') return reject(err)
        resolve({
          stdout: stdout as unknown as Buffer,
          stderr: (stderr as unknown as Buffer).toString('utf8'),
          code: typeof code === 'number' ? code : 0,
        })
      },
    )
  })
}

// Full ssh argv for an interactive pty: force a tty (-tt) and run one remote
// command string. Used by SessionManager/PaneManager via node-pty.
export function interactiveArgs(remote: RemoteConfig, remoteCmd: string): string[] {
  return [...sshBaseArgs(remote, false), '-tt', remoteCmd]
}
