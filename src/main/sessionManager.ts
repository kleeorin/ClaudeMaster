import { EventEmitter } from 'events'
import { homedir } from 'os'
import crypto from 'crypto'
import type {
  RemoteConfig, SessionInfo, SessionState, ClaudeEvent, PermissionRequest, PermissionDecision,
} from '../shared/types'
import { parseTarget } from './remotePath'
import * as ssh from './ssh'
import { ClaudeEngine, claudeArgs } from './claudeEngine'

interface Session extends SessionInfo {
  engine: ClaudeEngine | null   // null once the Claude process has exited (relaunchable)
  claudeSessionId: string       // claude's own session id (for --resume)
  startedAt: number             // last launch time, for the fast-failure heuristic
  remote?: RemoteConfig         // kept so the session can relaunch over the same host
  resume: boolean               // whether Claude was launched with --resume
  closing?: boolean             // set by destroy() so a kill isn't misread as a crash
  replacing?: boolean           // set by resumeInto() so the kill relaunches instead of exiting
  stderrTail: string            // recent stderr, so a fast failure can show why
  tunnelWarned?: boolean        // emitted the "reverse tunnel failed" notice once (remote)
  resumeFallbackTried?: boolean // retried a missing --resume target as a fresh session once
  sawInit?: boolean             // a system/init arrived this launch (distinguishes real turns from startup failures)
}

// A session that dies within this window of launching never really started —
// most often a bad remote command (`claude: command not found`, ssh auth
// failure). We report those as failures (keep the row + show output).
const STARTUP_GRACE_MS = 4000
const TAIL_MAX = 2000

// Build the remote shell command that launches Claude in stream-json mode. Runs
// an interactive login shell (-ilc) so the remote's PATH (nvm, npm-global, …) is
// set up as on a real login — see the long note kept from the pty era. The tail
// is the same headless argv we use locally, shell-quoted.
function remoteClaudeCmd(dir: string, args: string[]): string {
  const argv = args.map(ssh.shquote).join(' ')
  const inner = [
    `cd ${ssh.shquote(dir)} || exit 1`,
    `command -v claude >/dev/null 2>&1 || { [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; }`,
    `command -v claude >/dev/null 2>&1 || for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/bin" /usr/local/bin; do [ -x "$d/claude" ] && PATH="$d:$PATH" && export PATH && break; done`,
    `command -v claude >/dev/null 2>&1 || { echo "claude: not found on this remote (checked login shell, ~/.nvm, ~/.local/bin, ~/.npm-global/bin, /usr/local/bin)" >&2; exit 127; }`,
    `exec claude ${argv}`,
  ].join('\n')
  return 'exec "${SHELL:-bash}" -ilc ' + ssh.shquote(inner)
}

// Optional hooks the app injects (kept out of SessionManager's core so it stays
// transport-only). `mcpConfig` returns the --mcp-config string for a session
// (the app-control server); undefined skips it (e.g. remote until the tunnel).
export interface SessionManagerOpts {
  mcpConfig?: (sessionId: string, remote?: RemoteConfig) => string | undefined
  // The local app-control MCP port to reverse-tunnel into a remote session, so
  // remote claude can reach it at 127.0.0.1:<port>. undefined = no tunnel.
  reverseTunnelPort?: () => number | undefined
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  constructor(private readonly opts: SessionManagerOpts = {}) { super() }

  create(
    name: string,
    cwd: string,
    rootDir = cwd,
    parentId?: string,
    resume = false,
    remote?: RemoteConfig,
    claudeSessionId?: string,
  ): string {
    const id = crypto.randomUUID()
    const session: Session = {
      id, name, cwd, rootDir, parentId, remoteId: remote?.id,
      state: 'idle', engine: null, startedAt: 0, remote, resume,
      claudeSessionId: claudeSessionId ?? crypto.randomUUID(),
      stderrTail: '',
    }
    this.sessions.set(id, session)
    this.launch(session)
    return id
  }

  // (Re)spawn the Claude engine for a session and wire it up. Called on create
  // and on relaunch. The file browser, git panel, and terminal panes are
  // independent of the engine, so a session stays usable even if Claude fails.
  private launch(session: Session): void {
    const { id, cwd, remote, resume, claudeSessionId } = session
    const args = claudeArgs({ sessionId: claudeSessionId, resume, mcpConfig: this.opts.mcpConfig?.(id, remote) })

    // Remote gets the app-control MCP server reverse-tunnelled in (same port on
    // both ends) so remote claude can call it at 127.0.0.1:<port>.
    const tunnelPort = remote ? this.opts.reverseTunnelPort?.() : undefined
    const engine = remote
      ? new ClaudeEngine({
          command: 'ssh',
          args: ssh.interactiveArgs(remote, remoteClaudeCmd(parseTarget(cwd).path || '.', args), tunnelPort),
          cwd: homedir(),
          env: process.env as Record<string, string>,
        })
      : new ClaudeEngine({
          command: 'claude',
          args,
          cwd: cwd || homedir(),
          env: process.env as Record<string, string>,
        })

    session.engine = engine
    session.startedAt = Date.now()
    session.state = 'idle'
    session.closing = false
    session.stderrTail = ''
    session.sawInit = false

    engine.on('event', (e: ClaudeEvent) => {
      if (e.type === 'stderr' && typeof e.text === 'string') {
        session.stderrTail = (session.stderrTail + e.text).slice(-TAIL_MAX)
        // Case B: ssh is up but the -R forward didn't bind (remote forbids port
        // forwarding, or the port is taken). The conversation is fine; only app
        // control is dead — surface it once so the UI can say so.
        if (!session.tunnelWarned && /remote port forwarding failed/i.test(e.text)) {
          session.tunnelWarned = true
          this.emit('event', id, {
            type: 'app_control', ok: false,
            reason: 'App control is unavailable: the reverse tunnel to this remote could not be established (it may disallow port forwarding). The conversation is unaffected.',
          } as ClaudeEvent)
        }
      }
      // Swallow a `result` that arrives before this launch's init — it's a startup
      // failure (a missing --resume target emits subtype:error_during_execution then
      // exits), not a real turn result. Forwarding it would flash a bogus error
      // banner; the exit handler recovers by relaunching fresh.
      if (e.type === 'result' && !session.sawInit) return
      this.emit('event', id, e)
    })
    engine.on('ready', (sid: string) => {
      // claude may hand back a different id (e.g. on resume mismatch); trust it.
      session.sawInit = true
      session.claudeSessionId = sid
      this.emit('ready', id, sid)
    })
    engine.on('permission', (req: PermissionRequest) => this.emit('permission', id, req))
    engine.on('state', (state: 'idle' | 'running' | 'waiting') => this.setState(id, state))
    engine.on('exit', (code: number | null) => {
      // A resumeInto() kill: relaunch straight into the chosen conversation
      // rather than treating the exit as a crash/close.
      if (session.replacing) {
        session.replacing = false
        this.launch(session)
        this.emit('stateChange', id, session.state)
        return
      }
      // A near-instant, un-asked-for exit is a startup failure — the Claude
      // process never came up. Keep the session alive (only its engine is gone)
      // and tell the renderer why, so it can show "Claude not available" + Retry.
      // A --resume whose target conversation is gone (never written, /clear-ed, or
      // a stale saved id) makes claude print "No conversation found" and exit.
      // Retry once as a FRESH session, keeping the same id via --session-id so it
      // becomes resumable again. Timing-independent (not gated on the fast-fail
      // window) and transport-agnostic.
      if (!session.closing && session.resume && !session.resumeFallbackTried
          && /no conversation found/i.test(session.stderrTail)) {
        session.resumeFallbackTried = true
        session.resume = false
        this.launch(session)
        this.emit('stateChange', id, session.state)
        return
      }
      const failedFast = !session.closing && Date.now() - session.startedAt < STARTUP_GRACE_MS
      if (failedFast) {
        session.engine = null
        session.state = 'exited'
        this.emit('exit', id, true, (session.stderrTail || `claude exited (code ${code})`).trim())
      } else {
        this.cleanup(id)
        this.emit('exit', id, false, '')
      }
    })

    engine.start()
  }

  relaunch(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (session.engine) return true
    // A relaunch of a session that already had a claude id resumes it.
    session.resume = true
    session.resumeFallbackTried = false
    this.launch(session)
    this.emit('stateChange', id, session.state)
    return true
  }

  // Rebind a session to a past conversation and relaunch its engine with
  // --resume <claudeSessionId>. Backs the native /resume picker. If the engine
  // is running, the replacing flag makes its exit relaunch (see launch()).
  resumeInto(id: string, claudeSessionId: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.claudeSessionId = claudeSessionId
    session.resume = true
    session.resumeFallbackTried = false
    if (session.engine) {
      session.replacing = true
      session.engine.kill()
    } else {
      this.launch(session)
      this.emit('stateChange', id, session.state)
    }
  }

  // Restart a session with a brand-new conversation (fresh --session-id, no
  // resume) — the native /clear. Resets context; the caller clears the transcript.
  restartFresh(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.claudeSessionId = crypto.randomUUID()
    session.resume = false
    if (session.engine) {
      session.replacing = true
      session.engine.kill()
    } else {
      this.launch(session)
      this.emit('stateChange', id, session.state)
    }
  }

  // --- turn I/O (replaces keystroke sendInput) -------------------------------

  sendUserTurn(id: string, text: string): void {
    this.sessions.get(id)?.engine?.sendUserTurn(text)
  }

  interrupt(id: string): void {
    this.sessions.get(id)?.engine?.interrupt()
  }

  respondPermission(id: string, requestId: string, decision: PermissionDecision): void {
    this.sessions.get(id)?.engine?.respondPermission(requestId, decision)
  }

  destroy(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.closing = true
    if (session.engine) {
      session.engine.kill()  // fires exit → cleanup + 'exit'
    } else {
      this.cleanup(id)
      this.emit('exit', id, false, '')
    }
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(({ id, name, cwd, rootDir, parentId, remoteId, state }) => ({
      id, name, cwd, rootDir, parentId, remoteId, state,
    }))
  }

  // Claude's own session id, for persistence (--resume on restore).
  claudeSessionId(id: string): string | undefined {
    return this.sessions.get(id)?.claudeSessionId
  }

  private setState(id: string, state: SessionState): void {
    const session = this.sessions.get(id)
    if (!session || session.state === state) return
    session.state = state
    this.emit('stateChange', id, state)
  }

  private cleanup(id: string): void {
    this.sessions.delete(id)
  }
}
