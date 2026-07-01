import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import { homedir } from 'os'
import type { RemoteConfig, SessionInfo, SessionState } from '../shared/types'
import { parseTarget } from './remotePath'
import * as ssh from './ssh'

interface Session extends SessionInfo {
  pty: pty.IPty | null       // null once the Claude process has exited (relaunchable)
  startedAt: number          // last launch time, for the fast-failure heuristic
  remote?: RemoteConfig      // kept so the session can relaunch over the same host
  resume: boolean            // whether Claude was launched with --continue
  closing?: boolean          // set by destroy() so a kill isn't misread as a crash
}

// A session that dies within this window of launching never really started — most
// often a bad remote command (`claude: command not found`, ssh auth failure). We
// report those as failures (keep the row + show output) rather than removing them.
const STARTUP_GRACE_MS = 4000

// How much trailing (ANSI-stripped) output to keep so a fast failure can show why.
const TAIL_MAX = 2000

// Build the remote shell command that launches Claude. It runs an *interactive*
// login shell (-il) on purpose: a bare login shell (-l, no -i) sources the
// profile but a non-interactive `~/.bashrc` returns early at its `case $- in *i*`
// guard — which is exactly where nvm / PATH exports usually live — so `claude`
// (installed via nvm or npm-global) wouldn't be found. `-il` loads the same
// environment you get when you SSH in and type `claude`. Belt-and-suspenders:
// if it's still not on PATH we source nvm and probe common install dirs, then
// emit a clear "not found" line the session banner can surface.
function remoteClaudeCmd(dir: string, resume: boolean): string {
  const inner = [
    `cd ${ssh.shquote(dir)} || exit 1`,
    `command -v claude >/dev/null 2>&1 || { [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; }`,
    `command -v claude >/dev/null 2>&1 || for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/bin" /usr/local/bin; do [ -x "$d/claude" ] && PATH="$d:$PATH" && export PATH && break; done`,
    `command -v claude >/dev/null 2>&1 || { echo "claude: not found on this remote (checked login shell, ~/.nvm, ~/.local/bin, ~/.npm-global/bin, /usr/local/bin)"; exit 127; }`,
    `exec claude${resume ? ' --continue' : ''}`,
  ].join('\n')
  return 'exec "${SHELL:-bash}" -ilc ' + ssh.shquote(inner)
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
  private outputTails = new Map<string, string>()

  // `cwd`/`rootDir` may be remote-encoded (remote://id/path); when `remote` is
  // given they belong to that host and Claude is launched over ssh. The stored
  // SessionInfo keeps the encoded paths (the renderer's file browser / git panel
  // need them); only the spawn uses the stripped remote path.
  create(
    name: string,
    cwd: string,
    rootDir = cwd,
    parentId?: string,
    resume = false,
    remote?: RemoteConfig,
  ): string {
    const id = crypto.randomUUID()
    const session: Session = {
      id, name, cwd, rootDir, parentId, remoteId: remote?.id,
      state: 'idle', pty: null, startedAt: 0, remote, resume,
    }
    this.sessions.set(id, session)
    this.launch(session)
    return id
  }

  // (Re)spawn the Claude pty for a session and wire it up. Called on create and
  // on relaunch (e.g. after installing `claude` on a remote). The file browser,
  // git panel, and terminal panes are independent of this pty, so a session stays
  // usable even when Claude itself never starts.
  private launch(session: Session): void {
    const { id, cwd, remote, resume } = session

    // See remoteClaudeCmd: launches Claude via an interactive login shell so the
    // remote's PATH (nvm, npm-global, …) is set up as it is on a real login.
    const remoteCmd = remote ? remoteClaudeCmd(parseTarget(cwd).path || '.', resume) : ''
    const ptyProcess = remote
      ? pty.spawn('ssh', ssh.interactiveArgs(remote, remoteCmd), {
          name: 'xterm-256color', cols: 80, rows: 24,
          cwd: homedir(), env: process.env as Record<string, string>,
        })
      : pty.spawn('claude', resume ? ['--continue'] : [], {
          name: 'xterm-256color', cols: 80, rows: 24,
          cwd: cwd || homedir(), env: process.env as Record<string, string>,
        })

    session.pty = ptyProcess
    session.startedAt = Date.now()
    session.state = 'idle'
    session.closing = false
    this.outputTails.set(id, '')

    ptyProcess.onData((data) => {
      this.emit('output', id, data)
      this.captureTail(id, data)
      this.detect(id, data)
    })

    ptyProcess.onExit(() => {
      // A near-instant, un-asked-for exit is a startup failure (bad remote
      // command, ssh error) — the Claude process never came up. Keep the session
      // alive (only its terminal is gone) and tell the renderer why, so it can
      // show "Claude not available" + a Retry instead of dropping the whole
      // workspace. A slow exit, or one triggered by destroy(), is a real close.
      const failedFast = !session.closing && Date.now() - session.startedAt < STARTUP_GRACE_MS
      if (failedFast) {
        const tail = (this.outputTails.get(id) ?? '').trim()
        session.pty = null
        session.state = 'exited'
        clearTimeout(this.busyTimers.get(id))
        this.busyTimers.delete(id)
        this.probeTails.delete(id)
        this.emit('exit', id, true, tail)
      } else {
        this.cleanup(id)
        this.emit('exit', id, false, '')
      }
    })
  }

  // Re-run Claude in an existing session whose process had exited (Retry). Returns
  // false for an unknown session; a no-op (true) if it's already running.
  relaunch(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (session.pty) return true
    this.launch(session)
    this.emit('stateChange', id, session.state)  // clear the renderer's 'exited'
    return true
  }

  // Keep a rolling window of recent (ANSI-stripped) output so a fast failure can
  // report why it died.
  private captureTail(id: string, data: string): void {
    const next = ((this.outputTails.get(id) ?? '') + data.replace(ANSI_RE, '')).slice(-TAIL_MAX)
    this.outputTails.set(id, next)
  }

  sendInput(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.pty) return
    session.pty.write(data)
    // Submitting (Enter) — or answering a permission prompt — kicks off work.
    // Mark it running optimistically so the dot reacts before the first spinner
    // frame; the busy watchdog then keeps it accurate from the TUI itself.
    if (data === '\r') this.markRunning(id)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty?.resize(cols, rows)
  }

  destroy(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.closing = true
    if (session.pty) {
      session.pty.kill()  // fires onExit → cleanup + 'exit' (so panels tear down)
    } else {
      // Already exited (e.g. an 'exited' session being closed): clean up and still
      // emit 'exit' so the file browser / git panel listeners tear their state down.
      this.cleanup(id)
      this.emit('exit', id, false, '')
    }
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(({ id, name, cwd, rootDir, parentId, remoteId, state }) => ({
      id, name, cwd, rootDir, parentId, remoteId, state,
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
    this.outputTails.delete(id)
  }
}
