import { execFile } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import type { RemoteConfig } from '../shared/types'

// OpenSSH connection multiplexing. fs/git polling (directory reads, `git status`)
// fires often, so a fresh TCP+auth handshake per call would be unusably slow.
// ControlMaster keeps one connection alive and routes every later ssh call over
// it; ControlPersist keeps it warm briefly after the last use.
//
// The socket MUST live in a short, space-free directory. It used to sit under
// app.getPath('userData'), which on macOS is "~/Library/Application Support/…":
//  - the SPACE breaks ssh's `-o ControlPath=…` parsing (ssh tokenises the value
//    like a config line → "keyword controlpath extra arguments at end of line"),
//    which broke *every* ssh call on macOS; and
//  - the long nested path can exceed the 104-byte Unix-domain-socket path limit.
// ~/.ssh is short and space-free, and `%C` (a hash of the connection params) is a
// fixed short token, so we stay well under the limit. %C needs OpenSSH ≥ 6.7.
let cmDirReady = false
function controlArgs(): string[] {
  const dir = join(homedir(), '.ssh')
  if (!cmDirReady) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* already exists / not writable */ }
    cmDirReady = true
  }
  // No quoting needed: home dirs can't contain spaces on macOS/Linux, and `%C`
  // has none, so the value is space-free by construction — which is exactly what
  // ssh's `-o` parser requires.
  const cm = join(dir, 'cm-%C')
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
export function sshBaseArgs(remote: RemoteConfig, batch = true, opts: { noControl?: boolean } = {}): string[] {
  return [
    // `noControl` opts out of connection multiplexing for this invocation — needed
    // when the connection carries a reverse tunnel (see interactiveArgs).
    ...(opts.noControl ? [] : controlArgs()),
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

// Full ssh argv for an interactive session: force a tty (-tt) and run one remote
// command string. Used by SessionManager (stream-json) and PaneManager.
//
// `reverseTunnel` (a port) adds `-R port:127.0.0.1:port` so remote `claude` can
// reach the LOCAL app-control MCP server (remote localhost:port → local port).
// The tunnel must ride its OWN ssh connection: a -R on a multiplexed ControlMaster
// *secondary* session is silently ignored, so we skip control multiplexing when
// tunnelling. The long-lived claude connection gains little from multiplexing
// anyway (it's the frequent short fs/git calls that benefit).
export function interactiveArgs(remote: RemoteConfig, remoteCmd: string, reverseTunnel?: number): string[] {
  if (reverseTunnel) {
    // sshBaseArgs(noControl) ends with the host; insert -R before it.
    const optsThenHost = sshBaseArgs(remote, false, { noControl: true })
    const host = optsThenHost[optsThenHost.length - 1]
    const opts = optsThenHost.slice(0, -1)
    return [...opts, '-R', `${reverseTunnel}:127.0.0.1:${reverseTunnel}`, host, '-tt', remoteCmd]
  }
  return [...sshBaseArgs(remote, false), '-tt', remoteCmd]
}
