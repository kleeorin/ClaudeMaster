import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { ClaudeEvent, PermissionRequest, PermissionDecision } from '../shared/types'

// One running `claude` process, driven over the bidirectional stream-json
// protocol (see PROTOCOL-stream-json.md, pinned against CLI 2.1.198). Replaces
// the old node-pty TUI: instead of scraping ANSI, we parse structured JSON
// events and speak the control protocol for permissions + interrupt.
//
// This class is transport-agnostic about local vs remote: the caller supplies
// the argv (either `claude …` directly, or `ssh <host> … exec claude …`). It
// only knows how to spawn, frame line-delimited JSON both ways, and translate
// the wire protocol into typed events.

// The pinned headless argv. `--permission-prompt-tool stdio` is the (help-hidden)
// sentinel that routes `can_use_tool` prompts over this control channel; without
// it the CLI silently auto-denies non-allowlisted tools.
export function claudeArgs(opts: {
  sessionId: string
  resume?: boolean
  mcpConfig?: string   // JSON string (or path) for --mcp-config; adds the app-control server
  model?: string
  extra?: string[]
}): string[] {
  const a = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
  ]
  // --session-id sets a fresh id; --resume <id> continues an existing one. They
  // are mutually exclusive, so a resumed session reuses the id via --resume.
  if (opts.resume) a.push('--resume', opts.sessionId)
  else a.push('--session-id', opts.sessionId)
  // Add the app-control server WITHOUT --strict-mcp-config, so the user's own
  // configured MCP servers keep working alongside it.
  if (opts.mcpConfig) a.push('--mcp-config', opts.mcpConfig)
  if (opts.model) a.push('--model', opts.model)
  // Funnel .ipynb edits through the app-control notebook tools. A deny rule
  // (unlike the permission-handler guard in handlePermission) also beats an
  // "allow always" and acceptEdits mode — the cases where the tool never prompts.
  // NotebookEdit only ever targets notebooks, so deny it by name; scope the
  // general file tools to the .ipynb glob so normal code editing is unaffected.
  a.push('--disallowedTools', NOTEBOOK_DENY)
  if (opts.extra) a.push(...opts.extra)
  return a
}

// Comma-separated (the flag accepts comma or space) so it's one unambiguous argv
// value. `**/*.ipynb` matches notebooks at any depth. NB: the exact path-glob
// matching is the one bit worth confirming live (a wrong glob silently fails to
// match — the handlePermission guard still covers the prompting path).
const NOTEBOOK_DENY = 'NotebookEdit,Write(**/*.ipynb),Edit(**/*.ipynb)'

// The native file tools we intercept for notebooks, and where each carries its
// target path. If a call targets a .ipynb, return the deny message steering Claude
// to the app-control notebook tools; otherwise return null (allow normal handling).
function notebookGuard(toolName: string, input: Record<string, unknown> | undefined): string | null {
  const pathKey = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path'
  const nativeFileTools = new Set(['Write', 'Edit', 'NotebookEdit'])
  if (!nativeFileTools.has(toolName)) return null
  const target = input?.[pathKey]
  if (typeof target !== 'string' || !target.toLowerCase().endsWith('.ipynb')) return null
  return 'ClaudeMaster manages .ipynb files through its own tools — the native '
    + `${toolName} tool is disabled for notebooks. Use the app-control notebook tools instead: `
    + 'edit_cell / add_cell / insert_cell / delete_cell / move_cell / set_cell_type '
    + '(each takes an optional `path`; omit it to target the open pane), or create_notebook '
    + 'for a new one. These edit an open notebook live in its pane instead of overwriting the file.'
}

interface EngineSpawn {
  command: string          // 'claude' locally, or 'ssh' for a remote
  args: string[]           // claudeArgs(...) locally, or ssh args wrapping it
  cwd: string              // process cwd (local dir, or homedir for ssh)
  env: Record<string, string>
}

type PendingPermission = { request: PermissionRequest; resolve: (d: PermissionDecision) => void }

export interface ClaudeEngineEvents {
  event: (e: ClaudeEvent) => void            // any parsed stream-json event, for the transcript
  permission: (req: PermissionRequest) => void
  state: (state: 'idle' | 'running' | 'waiting') => void
  ready: (sessionId: string) => void         // fired on the init event
  exit: (code: number | null) => void
}

export class ClaudeEngine extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  private pending = new Map<string, PendingPermission>()
  private nextControlId = 1
  private _state: 'idle' | 'running' | 'waiting' = 'idle'
  private _turnActive = false

  constructor(private readonly spawnCfg: EngineSpawn) {
    super()
  }

  get state(): 'idle' | 'running' | 'waiting' { return this._state }
  get alive(): boolean { return this.child != null }

  start(): void {
    const { command, args, cwd, env } = this.spawnCfg
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    // Claude's own logs/errors go to stderr; surface as diagnostic events, don't crash.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('event', { type: 'stderr', text: chunk } as ClaudeEvent))

    child.on('exit', (code) => {
      this.child = null
      // Fail any in-flight permission prompts so the renderer doesn't hang.
      for (const { resolve } of this.pending.values()) resolve({ behavior: 'deny', message: 'session ended' })
      this.pending.clear()
      this.setState('idle')
      this.emit('exit', code)
    })
  }

  // Send a user turn (text, and later blocks). Marks the turn active → 'running'.
  sendUserTurn(text: string): void {
    if (!this.child) return
    this.write({ type: 'user', message: { role: 'user', content: text } })
    this._turnActive = true
    this.setState('running')
  }

  // Client→server interrupt control request (replaces sending ESC to a pty).
  interrupt(): void {
    if (!this.child) return
    this.write({ type: 'control_request', request_id: this.controlId(), request: { subtype: 'interrupt' } })
  }

  // Answer a can_use_tool prompt. `requestId` echoes the CLI's request_id.
  respondPermission(requestId: string, decision: PermissionDecision): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    p.resolve(decision)
    // Back to running if the turn is still going; the next result flips to idle.
    if (this._turnActive) this.setState('running')
  }

  kill(): void {
    this.child?.stdin.end()
    this.child?.kill('SIGTERM')
  }

  // --- internals -------------------------------------------------------------

  private controlId(): string { return `cm-${this.nextControlId++}` }

  private write(obj: unknown): void {
    this.child?.stdin.write(JSON.stringify(obj) + '\n')
  }

  private setState(s: 'idle' | 'running' | 'waiting'): void {
    if (this._state === s) return
    this._state = s
    this.emit('state', s)
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try { obj = JSON.parse(line) } catch { continue }
      this.handle(obj)
    }
  }

  private handle(o: Record<string, unknown>): void {
    const type = o.type as string

    if (type === 'control_request' && (o.request as Record<string, unknown>)?.subtype === 'can_use_tool') {
      this.handlePermission(o)
      return
    }
    // control_response (e.g. to our initialize/interrupt) — nothing to render.
    if (type === 'control_response') return

    // Everything else is transcript material; forward verbatim + typed.
    this.emit('event', o as unknown as ClaudeEvent)

    if (type === 'system' && (o.subtype as string) === 'init') {
      const sid = o.session_id as string
      this.emit('ready', sid)
    } else if (type === 'result') {
      this._turnActive = false
      this.setState('idle')
    }
  }

  private handlePermission(o: Record<string, unknown>): void {
    const requestId = o.request_id as string
    const r = o.request as Record<string, unknown>
    const req: PermissionRequest = {
      requestId,
      toolName: r.tool_name as string,
      displayName: (r.display_name as string) ?? (r.tool_name as string),
      input: r.input as Record<string, unknown>,
      toolUseId: r.tool_use_id as string,
      description: r.description as string | undefined,
      suggestions: (r.permission_suggestions as unknown[]) ?? [],
    }

    // Funnel .ipynb edits through ClaudeMaster's own notebook tools: auto-deny the
    // native file tools on notebooks (no user prompt), steering Claude to the app
    // tools that keep an open notebook's pane live instead of clobbering the file.
    // Done here (not via --disallowedTools) so it's an exact path check, not a glob.
    const notebookDeny = notebookGuard(req.toolName, req.input)
    if (notebookDeny) {
      this.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: notebookDeny } },
      })
      return
    }
    // Register the resolver; the CLI blocks until we send the control_response.
    this.pending.set(requestId, {
      request: req,
      resolve: (decision) => {
        this.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: decision.behavior === 'allow'
              ? {
                  behavior: 'allow',
                  updatedInput: decision.updatedInput ?? req.input,
                  // "allow always": apply/persist the request's suggestions.
                  ...(decision.updatedPermissions ? { updatedPermissions: decision.updatedPermissions } : {}),
                }
              : { behavior: 'deny', message: decision.message ?? 'Denied' },
          },
        })
      },
    })
    this.setState('waiting')
    this.emit('permission', req)
  }
}
