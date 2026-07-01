import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import { homedir } from 'os'
import type { SessionInfo, SessionState } from '../shared/types'

interface Session extends SessionInfo {
  pty: pty.IPty
}

// Claude keeps redrawing its working footer (spinner + elapsed counter) for the
// whole time a turn is in flight — including during silent tool calls — so the
// presence of this hint is a reliable "busy" signal where an output-gap timeout
// was not (a long tool call with no output used to be misread as idle).
const BUSY_RE = /esc to interrupt/i

// Grace after the last output before we call a session idle. The spinner's
// elapsed counter ticks ~once a second while a turn runs, so this comfortably
// outlasts the gap between frames (and absorbs jitter) without flicker.
const BUSY_GRACE_MS = 2500

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g

// Matches Claude Code permission prompts. Kept deliberately specific so ordinary
// streamed output doesn't read as a prompt: the interactive selector requires the
// numbered "❯ 1. Yes" form (not a bare "Yes"), and the loose "(y/n)" catch-all is
// gone — a live turn is recognised by the busy footer instead (see detect()).
const PERMISSION_RE = /(do you want to|do you trust|❯\s*\d+\.\s*Yes|don.t ask again)/i

// Stripped-output carry: bridges a keyword split across two pty chunks without
// letting stale matches linger. Longest keyword we test is ~16 chars.
const PROBE_OVERLAP = 32

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  private busyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private probeTails = new Map<string, string>()

  create(name: string, cwd: string, rootDir = cwd, parentId?: string, resume = false): string {
    const id = crypto.randomUUID()

    // Restored sessions resume their last conversation in this folder via
    // Claude's own renderer; fresh sessions start clean. Claude always runs in
    // `cwd` — a subsession shares its parent's cwd, only `rootDir` differs.
    const ptyProcess = pty.spawn('claude', resume ? ['--continue'] : [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || homedir(),
      env: process.env as Record<string, string>,
    })

    const session: Session = { id, name, cwd, rootDir, parentId, state: 'idle', pty: ptyProcess }
    this.sessions.set(id, session)

    ptyProcess.onData((data) => {
      this.emit('output', id, data)
      this.detect(id, data)
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
    // Submitting (Enter) — or answering a permission prompt — kicks off work.
    // Mark it running optimistically so the dot reacts before the first spinner
    // frame; the busy watchdog then keeps it accurate from the TUI itself.
    if (data === '\r') this.markRunning(id)
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
    return Array.from(this.sessions.values()).map(({ id, name, cwd, rootDir, parentId, state }) => ({
      id, name, cwd, rootDir, parentId, state,
    }))
  }

  private setState(id: string, state: SessionState): void {
    const session = this.sessions.get(id)
    if (!session || session.state === state) return
    session.state = state
    this.emit('stateChange', id, state)
  }

  // Classify a fresh pty chunk. Priority: the live busy footer wins — a turn that's
  // still in flight is never a prompt, and this stops incidental prompt-like text
  // in streamed output (e.g. "do you want to…") from parking a running session in
  // 'waiting'. Only with no busy footer do we treat a permission match as a real
  // prompt. Crucially, Claude paints "esc to interrupt" only once per turn — each
  // later spinner frame just moves the cursor and updates the glyph/seconds — so
  // while already running we treat *any* continued output as the turn still being
  // live and re-arm the watchdog. Idle is reached only when output truly stops for
  // BUSY_GRACE_MS.
  private detect(id: string, data: string): void {
    const probe = (this.probeTails.get(id) ?? '') + data.replace(ANSI_RE, '')
    this.probeTails.set(id, probe.slice(-PROBE_OVERLAP))

    if (BUSY_RE.test(probe)) {
      this.markRunning(id)
    } else if (PERMISSION_RE.test(probe)) {
      clearTimeout(this.busyTimers.get(id))
      this.setState(id, 'waiting')
    } else if (this.sessions.get(id)?.state === 'running') {
      // Spinner tick / tool output while a turn is in flight — keep it alive.
      this.armBusyWatchdog(id)
    }
  }

  // Enter 'running' and (re)arm the watchdog.
  private markRunning(id: string): void {
    this.setState(id, 'running')
    this.armBusyWatchdog(id)
  }

  // After BUSY_GRACE_MS with no further output, the turn is over -> idle.
  private armBusyWatchdog(id: string): void {
    clearTimeout(this.busyTimers.get(id))
    this.busyTimers.set(id, setTimeout(() => {
      // Only fall to idle from running — don't clobber a pending 'waiting' prompt.
      if (this.sessions.get(id)?.state === 'running') this.setState(id, 'idle')
    }, BUSY_GRACE_MS))
  }

  private cleanup(id: string): void {
    clearTimeout(this.busyTimers.get(id))
    this.sessions.delete(id)
    this.busyTimers.delete(id)
    this.probeTails.delete(id)
  }
}
