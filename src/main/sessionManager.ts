import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import { homedir } from 'os'
import type { SessionInfo, SessionState } from '../shared/types'

interface Session extends SessionInfo {
  pty: pty.IPty
}

const IDLE_TIMEOUT_MS = 2000

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g

// Matches Claude Code permission prompts (interactive selector and classic y/n forms)
const PERMISSION_RE = /\(y\/n|allow\s+\w[\w\s]*\?|do you want to|don.t ask again|❯\s*(?:\d+\.\s*)?Yes/i

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  create(name: string, cwd: string): string {
    const id = crypto.randomUUID()

    const ptyProcess = pty.spawn('claude', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || homedir(),
      env: process.env as Record<string, string>,
    })

    const session: Session = { id, name, cwd, state: 'idle', pty: ptyProcess }
    this.sessions.set(id, session)

    ptyProcess.onData((data) => {
      this.emit('output', id, data)
      if (PERMISSION_RE.test(data.replace(ANSI_RE, ''))) {
        this.setState(id, 'waiting')
      }
      this.scheduleIdle(id)
    })

    ptyProcess.onExit(() => {
      this.cleanup(id)
      this.emit('exit', id)
    })

    return id
  }

  sendInput(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.pty.write(data)
    // Only mark running when the user submits (Enter key)
    if (data === '\r') this.setState(id, 'running')
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty.resize(cols, rows)
  }

  destroy(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.pty.kill()
    this.cleanup(id)
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(({ id, name, cwd, state }) => ({
      id, name, cwd, state,
    }))
  }

  private setState(id: string, state: SessionState): void {
    const session = this.sessions.get(id)
    if (!session || session.state === state) return
    session.state = state
    this.emit('stateChange', id, state)
  }

  private scheduleIdle(id: string): void {
    clearTimeout(this.idleTimers.get(id))
    this.idleTimers.set(id, setTimeout(() => {
      // Don't overwrite 'waiting' — the session is paused for user input, not truly idle.
      if (this.sessions.get(id)?.state !== 'waiting') this.setState(id, 'idle')
    }, IDLE_TIMEOUT_MS))
  }

  private cleanup(id: string): void {
    clearTimeout(this.idleTimers.get(id))
    this.sessions.delete(id)
    this.idleTimers.delete(id)
  }
}
