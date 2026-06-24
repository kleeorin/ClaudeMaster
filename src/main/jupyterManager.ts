import { spawn, ChildProcess } from 'child_process'
import crypto from 'crypto'

export class JupyterManager {
  private server: ChildProcess | null = null
  private infoPromise: Promise<{ url: string; token: string } | null> | null = null

  start(): Promise<{ url: string; token: string } | null> {
    if (this.infoPromise) return this.infoPromise
    this.infoPromise = this._spawn()
    return this.infoPromise
  }

  private _spawn(): Promise<{ url: string; token: string } | null> {
    return new Promise((resolve) => {
      const token = crypto.randomBytes(24).toString('hex')
      let resolved = false
      const done = (val: { url: string; token: string } | null) => {
        if (resolved) return
        resolved = true
        resolve(val)
      }

      const proc = spawn('python3', [
        '-m', 'jupyter', 'server',
        '--no-browser',
        '--port=0',
        '--ip=127.0.0.1',
        `--ServerApp.token=${token}`,
        '--ServerApp.disable_check_xsrf=True',
      ], { env: process.env as Record<string, string> })

      this.server = proc

      const onData = (data: Buffer) => {
        const text = data.toString()
        process.stderr.write('[jupyter] ' + text)
        // Match any host (0.0.0.0, localhost, 127.0.0.1, etc.) and extract port
        const m = text.match(/https?:\/\/[^:]+:(\d+)/)
        if (!m) return
        proc.stdout?.off('data', onData)
        proc.stderr?.off('data', onData)
        done({ url: `http://127.0.0.1:${m[1]}`, token })
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
    return new Promise((resolve) => {
      const proc = spawn('python3', ['-m', 'pip', 'install', 'jupyter-server', 'notebook'], {
        env: process.env as Record<string, string>,
      })
      proc.on('exit', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
      setTimeout(() => resolve(false), 120_000)
    })
  }

  destroy(): void {
    this.server?.kill()
    this.reset()
  }
}
