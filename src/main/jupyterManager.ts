import { spawn, ChildProcess } from 'child_process'
import { createServer } from 'net'
import crypto from 'crypto'
import type { RemoteConfig } from '../shared/types'
import * as ssh from './ssh'

// Walk upward from `startDir` (toward '/'), checking .venv/bin/python3 and
// venv/bin/python3 at each level for an interpreter that can actually import
// jupyter_server; return the first hit, else null. One ssh round trip runs the
// whole walk in a single shell loop (not one call per level). An explicit
// remote.pythonPath override always wins over this search — see the caller.
export async function findNearestPython(remote: RemoteConfig, startDir: string): Promise<string | null> {
  const script = [
    `d=${ssh.shquote(startDir)}`,
    'while :; do',
    '  for v in .venv venv; do',
    '    py="$d/$v/bin/python3"',
    '    if [ -x "$py" ] && "$py" -c "import jupyter_server" >/dev/null 2>&1; then echo "$py"; exit 0; fi',
    '  done',
    '  [ "$d" = "/" ] && exit 1',
    '  d=$(dirname "$d")',
    'done',
  ].join('\n')
  try {
    const { stdout, code } = await ssh.run(remote, ['sh', '-lc', script])
    return code === 0 ? (stdout.trim() || null) : null
  } catch {
    return null
  }
}

// Ask the OS for a free localhost port by binding to 0 and reading it back.
function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

// Runs a Jupyter server and hands back a localhost URL the renderer can hit.
// Local: a plain child process on 127.0.0.1. Remote (constructed with a
// RemoteConfig): the server runs on the remote and we forward a local port to it
// over ssh (`-L`), so the renderer still talks to 127.0.0.1 and kernelClient is
// none the wiser.
export class JupyterManager {
  private server: ChildProcess | null = null
  private infoPromise: Promise<{ url: string; token: string } | null> | null = null

  constructor(private remote?: RemoteConfig) {}

  start(): Promise<{ url: string; token: string } | null> {
    if (this.infoPromise) return this.infoPromise
    this.infoPromise = this.remote ? this._spawnRemote(this.remote) : this._spawnLocal()
    return this.infoPromise
  }

  private _spawnLocal(): Promise<{ url: string; token: string } | null> {
    const token = crypto.randomBytes(24).toString('hex')
    const proc = spawn('python3', [
      '-m', 'jupyter', 'server',
      '--no-browser',
      '--port=0',
      '--ip=127.0.0.1',
      `--ServerApp.token=${token}`,
      '--ServerApp.disable_check_xsrf=True',
      // The renderer fetches the kernel API from its own origin, so Jupyter must
      // answer CORS preflight; safe because it's bound to 127.0.0.1 and token-gated.
      '--ServerApp.allow_origin=*',
      // Root at "/" so a kernel can start in any notebook's directory (passed as a
      // path relative to root_dir), which sets the kernel cwd.
      '--ServerApp.root_dir=/',
    ], { env: process.env as Record<string, string> })
    // Local URL uses whatever port Jupyter picked (parsed from its banner).
    return this._await(proc, token, (port) => `http://127.0.0.1:${port}`)
  }

  private async _spawnRemote(remote: RemoteConfig): Promise<{ url: string; token: string } | null> {
    const token = crypto.randomBytes(24).toString('hex')
    // Interpreter to run Jupyter with: an explicitly configured one (e.g. a shared
    // venv that actually has jupyter_server) else the login-shell python3.
    const py = remote.pythonPath?.trim() || 'python3'
    // We need the remote port up front to set up the tunnel, so pick a free one on
    // the remote (tiny TOCTOU window) and pin Jupyter to it.
    let remotePort: number
    let localPort: number
    try {
      const { stdout, code } = await ssh.run(remote, [
        py, '-c',
        'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()',
      ])
      remotePort = Number(stdout.trim())
      if (code !== 0 || !remotePort) return null
      localPort = await freeLocalPort()
    } catch {
      return null
    }

    // One ssh invocation both forwards localPort→remote:remotePort and runs the
    // server (through a login shell so `jupyter`/`python3` are on PATH). Killing
    // this ssh child tears down both the tunnel and the remote server. `py` may be
    // an auto-discovered venv path (from findNearestPython) whose tree can contain
    // spaces, so it's shell-quoted into the command.
    const serverCmd =
      `${ssh.shquote(py)} -m jupyter server --no-browser --port=${remotePort} --ip=127.0.0.1 ` +
      `--ServerApp.token=${token} --ServerApp.disable_check_xsrf=True ` +
      `--ServerApp.allow_origin='*' --ServerApp.root_dir=/`
    const args = [
      ...ssh.sshBaseArgs(remote),
      '-L', `${localPort}:127.0.0.1:${remotePort}`,
      'exec "${SHELL:-bash}" -lc ' + ssh.shquote(serverCmd),
    ]
    const proc = spawn('ssh', args)
    // Remote URL is the local end of the tunnel.
    return this._await(proc, token, () => `http://127.0.0.1:${localPort}`)
  }

  // Shared readiness wait: Jupyter prints its listening URL to stderr; the first
  // such line means it's up. `makeUrl` turns the parsed remote port into the URL
  // the renderer should use (identity for local, tunnel port for remote).
  private _await(
    proc: ChildProcess,
    token: string,
    makeUrl: (port: string) => string,
  ): Promise<{ url: string; token: string } | null> {
    return new Promise((resolve) => {
      this.server = proc
      let resolved = false
      const done = (val: { url: string; token: string } | null) => {
        if (resolved) return
        resolved = true
        resolve(val)
      }

      const onData = (data: Buffer) => {
        const text = data.toString()
        process.stderr.write('[jupyter] ' + text)
        const m = text.match(/https?:\/\/[^:]+:(\d+)/)
        if (!m) return
        proc.stdout?.off('data', onData)
        proc.stderr?.off('data', onData)
        done({ url: makeUrl(m[1]), token })
      }

      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)
      proc.on('error', (err) => { console.error('[jupyter] spawn error:', err.message); this.reset(); done(null) })
      proc.on('exit', (code) => { console.error('[jupyter] exited with code', code); this.reset(); done(null) })
      setTimeout(() => { console.error('[jupyter] timed out after 30s'); done(null) }, 30_000)
    })
  }

  private reset(): void {
    this.server = null
    this.infoPromise = null
  }

  install(): Promise<boolean> {
    // ipykernel is required — without it there's no Python kernel to launch even
    // once the server is up. pip on a PEP-668 "externally managed" interpreter
    // (recent Debian / Raspberry Pi OS / macOS) refuses a normal install, so fall
    // back to --break-system-packages.
    const pkgs = 'jupyter-server notebook ipykernel'
    // Install into the same interpreter we'll launch with, so the packages land
    // where the server looks for them.
    const py = this.remote?.pythonPath?.trim() || 'python3'
    const script = `${py} -m pip install ${pkgs} || ${py} -m pip install --break-system-packages ${pkgs}`
    if (this.remote) {
      return ssh.run(this.remote, ['sh', '-lc', script], { maxBuffer: 64 * 1024 * 1024 })
        .then(({ code }) => code === 0)
        .catch(() => false)
    }
    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', script], { env: process.env as Record<string, string> })
      proc.on('exit', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
      setTimeout(() => resolve(false), 300_000)  // pip builds can be slow on a Pi
    })
  }

  destroy(): void {
    this.server?.kill()
    this.reset()
  }
}
