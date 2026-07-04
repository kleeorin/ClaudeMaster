import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import { homedir } from 'os'
import crypto from 'crypto'
import type {
  RemoteConfig, SessionInfo, SessionState, PermissionDecision,
} from '../shared/types'
import { parseTarget } from './remotePath'
import * as ssh from './ssh'
import { disallowedValue } from './claudeEngine'
import { getAgent, SUBSESSION_REPORT_INSTRUCTION, type Agent } from './agents'
import type { SessionManagerOpts, SessionBackend } from './sessionManager'

// The TUI backend: runs the REAL interactive `claude` in a pty (so /remote-control,
// /login, model picker, plan mode all work), scraping ANSI for the busy/permission
// state the sidebar dots need. It is the pre-pivot backend (recovered from master),
// extended so the app-control MCP server + the .ipynb funnel ride along in TUI mode:
// interactive claude is launched with --mcp-config (the per-session app server) and
// --disallowedTools (the notebook funnel), exactly the flags the native engine uses.
// Everything else in the app (file browser, notebook viewer/editor + its MCP tools,
// git panel, shell panes) is frontend-independent and works unchanged.

interface Session extends SessionInfo {
  pty: pty.IPty | null       // null once the Claude process has exited (relaunchable)
  startedAt: number          // last launch time, for the fast-failure heuristic
  remote?: RemoteConfig      // kept so the session can relaunch over the same host
  resume: boolean            // whether Claude was launched with --continue
  closing?: boolean          // set by destroy() so a kill isn't misread as a crash
}

const STARTUP_GRACE_MS = 4000
const TAIL_MAX = 2000

// Build the argv passed to the interactive `claude`. --continue resumes the most
// recent conversation in the cwd (the TUI has no --resume-by-id like headless). The
// app-control MCP server + notebook funnel are added when available so the notebook
// tools work here too (same flags the native engine uses; no --strict-mcp-config so
// the user's own MCP servers keep working).
function claudeTuiArgs(resume: boolean, mcpConfig?: string, agent: Agent = getAgent(), model = agent.model, systemPrompt = agent.systemPrompt): string[] {
  const args = resume ? ['--continue'] : []
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  if (model) args.push('--model', model)
  // The agent's role config works identically in interactive mode (all launch args).
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
  if (agent.allowedTools?.length) args.push('--allowedTools', agent.allowedTools.join(','))
  args.push('--disallowedTools', disallowedValue(agent.disallowedTools))
  return args
}

// Build the remote shell command that launches Claude. Runs an interactive login
// shell (-ilc) so the remote's PATH (nvm, npm-global, …) is set up as on a real
// login. The tail is the same argv we use locally, shell-quoted.
function remoteClaudeCmd(dir: string, args: string[]): string {
  const argv = args.map(ssh.shquote).join(' ')
  const inner = [
    `cd ${ssh.shquote(dir)} || exit 1`,
    `command -v claude >/dev/null 2>&1 || { [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; }`,
    `command -v claude >/dev/null 2>&1 || for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/bin" /usr/local/bin; do [ -x "$d/claude" ] && PATH="$d:$PATH" && export PATH && break; done`,
    `command -v claude >/dev/null 2>&1 || { echo "claude: not found on this remote (checked login shell, ~/.nvm, ~/.local/bin, ~/.npm-global/bin, /usr/local/bin)"; exit 127; }`,
    `exec claude ${argv}`,
  ].join('\n')
  return 'exec "${SHELL:-bash}" -ilc ' + ssh.shquote(inner)
}

// Claude keeps redrawing its working footer (spinner + elapsed counter) for the
// whole time a turn is in flight — including during silent tool calls — so the
// presence of this hint is a reliable "busy" signal.
const BUSY_RE = /esc to interrupt/i
const BUSY_GRACE_MS = 2500
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g

// Matches Claude Code permission prompts. Deliberately specific so ordinary streamed
// output doesn't read as a prompt: the numbered "❯ 1. Yes" form (not a bare "Yes").
const PERMISSION_RE = /(do you want to|do you trust|❯\s*\d+\.\s*Yes|don.t ask again)/i
const PROBE_OVERLAP = 32

export class PtySessionManager extends EventEmitter implements SessionBackend {
  private sessions = new Map<string, Session>()
  private busyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private probeTails = new Map<string, string>()
  private outputTails = new Map<string, string>()

  constructor(private readonly opts: SessionManagerOpts = {}) { super() }

  create(
    name: string,
    cwd: string,
    rootDir = cwd,
    parentId?: string,
    resume = false,
    remote?: RemoteConfig,
    _claudeSessionId?: string,   // unused in TUI mode (--continue, not resume-by-id)
    agentId?: string,
    model?: string,
  ): string {
    const id = crypto.randomUUID()
    const session: Session = {
      id, name, cwd, rootDir, parentId, remoteId: remote?.id, agentId, model,
      state: 'idle', pty: null, startedAt: 0, remote, resume,
    }
    this.sessions.set(id, session)
    this.launch(session)
    return id
  }

  private launch(session: Session): void {
    const { id, cwd, remote, resume } = session
    const agent = getAgent(session.agentId)
    const systemPrompt = [agent.systemPrompt, session.parentId ? SUBSESSION_REPORT_INSTRUCTION : undefined]
      .filter(Boolean).join('\n\n') || undefined
    const args = claudeTuiArgs(resume, this.opts.mcpConfig?.(id, remote), agent, session.model ?? agent.model, systemPrompt)

    // Remote gets the app-control MCP server reverse-tunnelled in (same port on
    // both ends) so remote claude can reach it at 127.0.0.1:<port>.
    const tunnelPort = remote ? this.opts.reverseTunnelPort?.() : undefined
    const ptyProcess = remote
      ? pty.spawn('ssh', ssh.interactiveArgs(remote, remoteClaudeCmd(parseTarget(cwd).path || '.', args), tunnelPort), {
          name: 'xterm-256color', cols: 80, rows: 24,
          cwd: homedir(), env: process.env as Record<string, string>,
        })
      : pty.spawn('claude', args, {
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
      // A near-instant, un-asked-for exit is a startup failure (bad remote command,
      // ssh error) — the Claude process never came up. Keep the session alive (only
      // its terminal is gone) and tell the renderer why. A slow exit, or one from
      // destroy(), is a real close.
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

  relaunch(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (session.pty) return true
    this.launch(session)
    this.emit('stateChange', id, session.state)
    return true
  }

  private captureTail(id: string, data: string): void {
    const next = ((this.outputTails.get(id) ?? '') + data.replace(ANSI_RE, '')).slice(-TAIL_MAX)
    this.outputTails.set(id, next)
  }

  sendInput(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.pty) return
    session.pty.write(data)
    // Submitting (Enter) — or answering a permission prompt — kicks off work. Mark
    // it running optimistically; the busy watchdog then keeps it accurate.
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
      session.pty.kill()  // fires onExit → cleanup + 'exit'
    } else {
      this.cleanup(id)
      this.emit('exit', id, false, '')
    }
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(({ id, name, cwd, rootDir, parentId, remoteId, agentId, model, state }) => ({
      id, name, cwd, rootDir, parentId, remoteId, agentId, model, state,
    }))
  }

  // --- SessionBackend stubs (native stream-json I/O lives in SessionManager) ----
  // In TUI mode these never fire: the renderer drives the terminal via sendInput,
  // and permissions / resume / clear are handled inside claude's own TUI.
  sendUserTurn(_id: string, _text: string): void { /* pty: use sendInput */ }
  interrupt(_id: string): void { /* pty: renderer sends ESC via sendInput */ }
  respondPermission(_id: string, _requestId: string, _decision: PermissionDecision): void { /* TUI handles prompts */ }
  resumeInto(_id: string, _claudeSessionId: string): void { /* TUI has its own /resume */ }
  restartFresh(_id: string): void { /* TUI has its own /clear */ }
  claudeSessionId(_id: string): string | undefined { return undefined }  // TUI: no resume-by-id

  private setState(id: string, state: SessionState): void {
    const session = this.sessions.get(id)
    if (!session || session.state === state) return
    session.state = state
    this.emit('stateChange', id, state)
  }

  // Classify a fresh pty chunk. The live busy footer wins — a turn still in flight
  // is never a prompt. Only with no busy footer is a permission match a real prompt.
  // While already running, any continued output re-arms the watchdog; idle is
  // reached only when output truly stops for BUSY_GRACE_MS.
  private detect(id: string, data: string): void {
    const probe = (this.probeTails.get(id) ?? '') + data.replace(ANSI_RE, '')
    this.probeTails.set(id, probe.slice(-PROBE_OVERLAP))

    if (BUSY_RE.test(probe)) {
      this.markRunning(id)
    } else if (PERMISSION_RE.test(probe)) {
      clearTimeout(this.busyTimers.get(id))
      this.setState(id, 'waiting')
    } else if (this.sessions.get(id)?.state === 'running') {
      this.armBusyWatchdog(id)
    }
  }

  private markRunning(id: string): void {
    this.setState(id, 'running')
    this.armBusyWatchdog(id)
  }

  private armBusyWatchdog(id: string): void {
    clearTimeout(this.busyTimers.get(id))
    this.busyTimers.set(id, setTimeout(() => {
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
