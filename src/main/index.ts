import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, extname, basename, dirname } from 'path'
import { homedir } from 'os'
import { readdir, readFile, writeFile, stat, cp, rename, rm, access, mkdir } from 'fs/promises'
import { watch } from 'fs'
import type { DirEntry, FilePreview, WriteResult } from '../shared/types'
import { SessionManager, type SessionBackend } from './sessionManager'
import { PtySessionManager } from './ptySessionManager'
import { getFrontend, setFrontend, type Frontend } from './appSettings'
import { isAgent, listAgents } from './agents'
import { listModels } from './models'
import * as conversations from './conversations'
import { AppControlMcpServer } from './mcpServer'
import { PaneManager } from './paneManager'
import { JupyterManager, findNearestPython } from './jupyterManager'
import * as gitManager from './gitManager'
import { saveState, loadState } from './sessionPersistence'
import * as remotes from './remotes'
import * as sshConfig from './sshConfig'
import * as remoteFs from './remoteFs'
import * as docsIndex from './docsIndex'
import * as permissions from './permissions'
import { parseTarget } from './remotePath'
import type { RemoteConfig, SavedSession, PermissionMode, PermissionScope, PermissionAction } from '../shared/types'

// App-control MCP server: each session's claude gets a per-session URL so it can
// drive ClaudeMaster (open files/panes, edit cells, spawn subsessions, …). Remote
// sessions reach it over a reverse tunnel (-R <port>) — the URL is 127.0.0.1:<port>
// on both ends, so the same config works locally and remotely.
const appMcp = new AppControlMcpServer()
// A global startup setting picks the whole app's frontend (restart to change).
// Both backends get the same app-control wiring, so the notebook MCP tools + the
// .ipynb funnel work identically in either — only the chat surface + claude I/O
// differ (native stream-json chat vs the real interactive Claude Code TUI in a pty).
const frontend: Frontend = getFrontend()
const backendOpts = {
  mcpConfig: (id: string) => appMcp.configFor(id),
  reverseTunnelPort: () => appMcp.portNumber,
}
const sessions: SessionBackend = frontend === 'tui'
  ? new PtySessionManager(backendOpts)
  : new SessionManager(backendOpts)
const panes = new PaneManager()
const jupyter = new JupyterManager()
let mainWindow: BrowserWindow | null = null
let isQuitting = false

// The active pane per session (path + kind), published by the renderer on tab
// switch. Backs the path-less, active-pane-targeted app-control tools.
const activePane = new Map<string, { path: string; isNotebook: boolean } | null>()

// Request/response bridge for tools that must act in the renderer (open a file,
// add a pane). Correlate by reqId; time out so a tool never hangs the session.
let reqSeq = 0
const pendingAppReq = new Map<number, (r: { text?: string; error?: string }) => void>()
function askRenderer(op: string, sessionId: string, args: Record<string, unknown>): Promise<{ text?: string; error?: string }> {
  return new Promise((resolve) => {
    if (!mainWindow) return resolve({ error: 'app window not available' })
    const reqId = ++reqSeq
    pendingAppReq.set(reqId, resolve)
    mainWindow.webContents.send('appcontrol:request', { reqId, op, sessionId, args })
    setTimeout(() => { if (pendingAppReq.delete(reqId)) resolve({ error: 'renderer timed out' }) }, 5000)
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      plugins: true,  // enable Chromium's built-in PDF viewer (FileView iframe)
      // Hand the chosen frontend to the preload synchronously (before the renderer
      // runs) so App can pick its chat surface without an async round-trip.
      additionalArguments: [`--cm-frontend=${frontend}`],
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  // Stop the taskbar flash once the user actually looks at the window.
  mainWindow.on('focus', () => mainWindow?.flashFrame(false))
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.webContents.send('app:request-save')
      // Fallback: force-close after 10s if renderer doesn't respond
      setTimeout(() => { isQuitting = true; mainWindow?.close() }, 10000)
    }
  })

  // Structured stream-json events (transcript), permission prompts, and the
  // claude session id (on init) — the native-chat replacements for raw output.
  sessions.on('event', (id: string, e: unknown) => {
    mainWindow?.webContents.send('session:event', id, e)
  })
  sessions.on('permission', (id: string, req: unknown) => {
    mainWindow?.webContents.send('session:permission', id, req)
  })
  sessions.on('ready', (id: string, claudeSessionId: string) => {
    mainWindow?.webContents.send('session:ready', id, claudeSessionId)
  })
  sessions.on('stateChange', (id: string, state: string) => {
    mainWindow?.webContents.send('session:stateChange', id, state)
  })
  sessions.on('exit', (id: string, failedFast: boolean, error: string) => {
    mainWindow?.webContents.send('session:exit', id, failedFast, error)
  })
  // TUI mode: raw pty output for the session terminal (native mode never emits it).
  sessions.on('output', (id: string, data: string) => {
    mainWindow?.webContents.send('session:output', id, data)
  })

  panes.on('output', (id: string, data: string) => {
    mainWindow?.webContents.send('pane:output', id, data)
  })
  panes.on('exit', (id: string) => {
    mainWindow?.webContents.send('pane:exit', id)
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// The remote a path belongs to is encoded in the path itself (remote://id/…), so
// every fs/git/session handler resolves it the same way. Returns undefined for
// local paths or an unknown/stale remote id (falls back to local behavior).
async function remoteFor(encodedPath: string): Promise<RemoteConfig | undefined> {
  const { remoteId } = parseTarget(encodedPath)
  if (!remoteId) return undefined
  return (await remotes.get(remoteId)) ?? undefined
}

ipcMain.handle('session:create', async (_, name: string, cwd: string, rootDir?: string, parentId?: string, resume?: boolean, claudeSessionId?: string, agentId?: string, model?: string, permissionMode?: PermissionMode) =>
  sessions.create(name, cwd, rootDir ?? cwd, parentId, resume, await remoteFor(cwd), claudeSessionId, agentId, model, permissionMode)
)
ipcMain.handle('session:destroy', (_, id: string) => { appMcp.release(id); sessions.destroy(id) })
ipcMain.handle('session:relaunch', (_, id: string) => sessions.relaunch(id))
ipcMain.handle('session:list', () => sessions.list())
ipcMain.handle('session:load-saved', () => loadState())
ipcMain.handle('session:save-state', async (_, saved: SavedSession[]) => {
  await saveState(saved)
  isQuitting = true
  mainWindow?.close()
})
ipcMain.handle('session:autosave', async (_, saved: SavedSession[]) => {
  await saveState(saved)
})
// Native-chat turn I/O over stream-json (replaces keystroke input + pty resize).
ipcMain.on('session:sendTurn', (_, id: string, text: string) => sessions.sendUserTurn(id, text))
ipcMain.on('session:interrupt', (_, id: string) => sessions.interrupt(id))
ipcMain.on('session:respondPermission', (_, id: string, requestId: string, decision: unknown) =>
  sessions.respondPermission(id, requestId, decision as never)
)
ipcMain.handle('session:claudeId', (_, id: string) => sessions.claudeSessionId(id))
// Native /resume: list past conversations for a cwd, read one back, and rebind
// a session's engine to it. Local only for now (remote projects live remote).
ipcMain.handle('session:listConversations', (_, cwd: string) => conversations.listConversations(cwd))
ipcMain.handle('session:readConversation', (_, cwd: string, id: string) => conversations.readConversation(cwd, id))
ipcMain.on('session:resumeInto', (_, id: string, claudeSessionId: string) => sessions.resumeInto(id, claudeSessionId))
ipcMain.on('session:clear', (_, id: string) => sessions.restartFresh(id))
// TUI mode: keystroke input + terminal resize for the session pty (no-ops in native).
ipcMain.on('session:input', (_, id: string, data: string) => sessions.sendInput(id, data))
ipcMain.on('session:resize', (_, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))

// App settings. The frontend is read once at startup (both the backend and the
// renderer's chat surface are chosen then), so setting it only takes effect on the
// next launch — the renderer surfaces a "restart to apply" notice.
ipcMain.handle('settings:getFrontend', () => getFrontend())
ipcMain.handle('settings:setFrontend', (_, f: Frontend) => { setFrontend(f) })

// The agent roles a new session can be created as (for the sidebar role picker).
ipcMain.handle('agents:list', () => listAgents())
// The models the picker offers (for the sidebar model picker).
ipcMain.handle('models:list', () => listModels())

// Permission Control Center: merge Claude's own settings files for a session's
// cwd + agent into an effective permission picture (P1, read-only)…
ipcMain.handle('perms:get', (_, cwd: string, agentId?: string) => permissions.getEffective(cwd, agentId))
// …set a session's mode, live if supported else on next launch (P2)…
ipcMain.handle('perms:setMode', (_, sessionId: string, mode: PermissionMode) => sessions.setPermissionMode(sessionId, mode))
// …and add/remove allow/deny/ask rules in the chosen settings file (P3).
ipcMain.handle('perms:addRule', (_, cwd: string, scope: PermissionScope, action: PermissionAction, value: string) => permissions.addRule(cwd, scope, action, value))
ipcMain.handle('perms:removeRule', (_, cwd: string, scope: PermissionScope, action: PermissionAction, value: string) => permissions.removeRule(cwd, scope, action, value))

// --- App-control MCP tools ---------------------------------------------------
// The renderer publishes the active pane; tools that mutate the UI round-trip
// back through askRenderer (handled by the renderer's AppControlBridge).
ipcMain.on('session:activePane', (_, sessionId: string, info: { path: string; isNotebook: boolean } | null) =>
  activePane.set(sessionId, info)
)
ipcMain.on('appcontrol:response', (_, reqId: number, result: { text?: string; error?: string }) => {
  const resolve = pendingAppReq.get(reqId)
  if (resolve) { pendingAppReq.delete(reqId); resolve(result) }
})

appMcp.register({
  name: 'list_sessions',
  description: 'List the ClaudeMaster sessions currently open (id, name, working directory, state, agent role, and parentId for subsessions).',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({ text: JSON.stringify(sessions.list().map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, state: s.state, agent: s.agentId ?? 'general', parentId: s.parentId }))) }),
})
appMcp.register({
  name: 'list_agents',
  description: 'List the agent roles a session can be spawned as (id, name, what each is for). Pass an id as the `agent` argument to spawn_subsession / create_session to give the new session a persistent role (charter + tool scope + model).',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({ text: JSON.stringify(listAgents()) }),
})
appMcp.register({
  name: 'read_active_pane',
  description: "Get the file open in the calling session's active pane (the one the user is looking at). Fails if the Claude tab is active (no file visible).",
  inputSchema: { type: 'object', properties: {} },
  handler: async (sessionId) => {
    const p = activePane.get(sessionId)
    if (!p) return { error: 'No file pane is active in this session (the Claude tab is focused). Ask the user to open a file first.' }
    return { text: JSON.stringify(p) }
  },
})
appMcp.register({
  name: 'open_file',
  description: 'Open a file in a tab of the calling session (so the user can see it). Absolute path.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path' } }, required: ['path'] },
  handler: async (sessionId, args) => {
    const path = String(args.path ?? '')
    if (!path) return { error: 'path is required' }
    try { await access(path) } catch { return { error: `no such file: ${path}` } }
    return askRenderer('openFile', sessionId, { path, isNotebook: extname(path).toLowerCase() === '.ipynb' })
  },
})
appMcp.register({
  name: 'open_pane',
  description: 'Open a terminal pane in the calling session.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (sessionId) => askRenderer('openPane', sessionId, {}),
})

// --- Pane-edit tools (Step 5) ------------------------------------------------
// These target the calling session's ACTIVE pane (what the user is looking at)
// and mutate it LIVE in memory — no .ipynb write here; the pane is marked unsaved
// (yellow ● + Save) for the user to persist, so we never clobber the file under
// an unsaved user. Cells are addressed by 0-based index. Guard the target first.
// Resolve which notebook a cell tool targets: an explicit `path` if given,
// otherwise the calling session's active pane. An open notebook is edited live
// in its pane (unsaved); a not-open one is written quietly to disk (decided
// renderer-side by whether it's loaded — see notebooks.applyAppEdit).
function resolveNotebook(sessionId: string, args: Record<string, unknown>): { path: string } | { error: string } {
  const explicit = args.path != null ? String(args.path) : ''
  if (explicit) {
    if (extname(explicit).toLowerCase() !== '.ipynb') return { error: `${explicit} is not a .ipynb notebook. Use edit_active_file for text files.` }
    // Guard against a stale path: if the user is actively viewing a DIFFERENT
    // notebook, that is almost certainly the intended target — refuse the explicit
    // path and steer to the active pane. Escape hatch for a deliberate other-file
    // edit: open_file it first (so the user sees the change), which makes it active.
    const active = activePane.get(sessionId)
    if (active?.isNotebook && active.path !== explicit) {
      return { error: `Refusing to edit ${explicit}: the user is currently viewing a different notebook (${active.path}), which is almost certainly the one they mean. Omit \`path\` to edit the notebook they're looking at. Only edit ${explicit} if the user explicitly named that file this turn — and if so, open_file it first so the change is visible, then edit.` }
    }
    return { path: explicit }
  }
  const p = activePane.get(sessionId)
  if (!p) return { error: 'No notebook is open in the active pane, and no `path` was given. Pass an absolute `path` to edit a specific notebook, or ask the user to open one.' }
  if (!p.isNotebook) return { error: `The active pane is a text file (${p.path}), not a notebook. Pass a notebook \`path\`, or use edit_active_file for text.` }
  return { path: p.path }
}
function activeTextFile(sessionId: string): { path: string } | { error: string } {
  const p = activePane.get(sessionId)
  if (!p) return { error: 'No file pane is active (the Claude tab is focused). Ask the user to open the file first.' }
  if (p.isNotebook) return { error: `The active pane is a notebook (${p.path}). Use the cell tools (edit_cell, add_cell, insert_cell, delete_cell, move_cell, set_cell_type).` }
  return { path: p.path }
}
// One renderer round-trip for every notebook mutation; `op` selects the edit.
// The resolved path overrides any raw `path` Claude passed in args.
const notebookEdit = (sessionId: string, op: string, args: Record<string, unknown>) => {
  const t = resolveNotebook(sessionId, args)
  if ('error' in t) return Promise.resolve(t)
  return askRenderer('notebookEdit', sessionId, { ...args, op, path: t.path })
}
// A `path` field every cell tool accepts. Strongly steer Claude to OMIT it so the
// tool targets the user's active pane — passing a stale path from earlier context
// (when a different notebook was in focus) is the main targeting mistake.
const pathProp = { path: { type: 'string', description: "Leave UNSET by default — the tool then targets whatever notebook the user is currently viewing (their active pane), which is almost always what you want. Set `path` (absolute, .ipynb) ONLY when the user explicitly names a DIFFERENT notebook to edit in this request. Never reuse a path from earlier in the conversation: the user may have switched notebooks since, and an unset path always follows their current focus. A path that isn't open is written straight to disk." } }
appMcp.register({
  name: 'edit_cell',
  description: "Replace the source of a cell (0-based index) in a notebook. Targets the active pane unless `path` is given. If that notebook is open it updates live (unsaved, for the user to save); if not, it's written to disk. Clears the cell's outputs.",
  inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' }, source: { type: 'string' } }, required: ['index', 'source'] },
  handler: (sessionId, args) => notebookEdit(sessionId, 'edit_cell', args),
})
appMcp.register({
  name: 'add_cell',
  description: "Append a new cell to the end of a notebook (active pane unless `path` is given). type = 'code' (default), 'markdown', or 'raw'. Optional source. Live if the notebook is open, else written to disk.",
  inputSchema: { type: 'object', properties: { ...pathProp, type: { type: 'string' }, source: { type: 'string' } } },
  handler: (sessionId, args) => notebookEdit(sessionId, 'add_cell', args),
})
appMcp.register({
  name: 'insert_cell',
  description: 'Insert a new cell before the given 0-based index in a notebook (active pane unless `path` is given). type = code/markdown/raw. Optional source. Live if open, else written to disk.',
  inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' }, type: { type: 'string' }, source: { type: 'string' } }, required: ['index'] },
  handler: (sessionId, args) => notebookEdit(sessionId, 'insert_cell', args),
})
appMcp.register({
  name: 'delete_cell',
  description: 'Delete the cell at the given 0-based index in a notebook (active pane unless `path` is given). Live if open, else written to disk.',
  inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' } }, required: ['index'] },
  handler: (sessionId, args) => notebookEdit(sessionId, 'delete_cell', args),
})
appMcp.register({
  name: 'move_cell',
  description: 'Move a cell from one 0-based index to another in a notebook (active pane unless `path` is given). Live if open, else written to disk.',
  inputSchema: { type: 'object', properties: { ...pathProp, from: { type: 'number' }, to: { type: 'number' } }, required: ['from', 'to'] },
  handler: (sessionId, args) => notebookEdit(sessionId, 'move_cell', args),
})
appMcp.register({
  name: 'set_cell_type',
  description: "Change a cell's type (code/markdown/raw) by 0-based index in a notebook (active pane unless `path` is given). Clears its outputs. Live if open, else written to disk.",
  inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' }, type: { type: 'string' } }, required: ['index', 'type'] },
  handler: (sessionId, args) => notebookEdit(sessionId, 'set_cell_type', args),
})
appMcp.register({
  name: 'create_notebook',
  description: 'Create a new, empty .ipynb at an absolute `path` (fails if it already exists). It is NOT opened in a pane; use the cell tools with the same `path` to populate it (written to disk), or open it in the app to work on it live.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path ending in .ipynb' } }, required: ['path'] },
  handler: async (sessionId, args) => {
    const path = String(args.path ?? '')
    if (!path) return { error: 'path is required' }
    if (extname(path).toLowerCase() !== '.ipynb') return { error: 'path must end in .ipynb' }
    // Refuse to clobber — check existence on the right host (remote or local).
    const remote = await remoteFor(path)
    const already = remote
      ? await remoteFs.exists(remote, parseTarget(path).path)
      : await access(path).then(() => true, () => false)
    if (already) return { error: `already exists: ${path}` }
    return askRenderer('createNotebook', sessionId, { path })
  },
})
appMcp.register({
  name: 'edit_active_file',
  description: "Replace a unique snippet in the TEXT file open in the calling session's active pane, writing through to disk and updating the pane live. `old_string` must occur exactly once. Use this (not your normal Edit) when you want the user's open editor to reflect the change.",
  inputSchema: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['old_string', 'new_string'] },
  handler: (sessionId, args) => {
    const t = activeTextFile(sessionId)
    if ('error' in t) return Promise.resolve(t)
    return askRenderer('editActiveFile', sessionId, { path: t.path, old_string: args.old_string, new_string: args.new_string })
  },
})

// --- Session-control tools (Step 6) ------------------------------------------
// The multi-agent surface: spawn helpers in the same folder, open/close sessions,
// and orchestrate siblings. All are MCP tools, so the can_use_tool prompt gates
// them (wide + permission-gated). `sessionId` is the CALLING session's id.
// Validate an optional `agent` arg against the registry; returns the id (or
// undefined for none), or an error listing the valid ids.
function resolveAgentArg(args: Record<string, unknown>): { agent?: string } | { error: string } {
  if (args.agent == null || args.agent === '') return {}
  const agent = String(args.agent)
  if (!isAgent(agent)) return { error: `unknown agent "${agent}". Call list_agents for the valid roles.` }
  return { agent }
}
const agentProp = { agent: { type: 'string', description: 'Optional agent role for the new session (id from list_agents, e.g. "explorer", "reviewer", "implementer"). Omit for a plain "general" session. The role persists for the whole session — charter + tool scope + model.' } }
const modelProp = { model: { type: 'string', description: 'Optional model override for the new session (e.g. "claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-fable-5"). Overrides the role\'s default model. Omit to use the role\'s model, else the account default.' } }
const modelArg = (args: Record<string, unknown>) => (args.model != null && args.model !== '' ? String(args.model) : undefined)
appMcp.register({
  name: 'spawn_subsession',
  description: "Spawn a new Claude subsession. Defaults to the SAME folder as the calling session (several agents working in one directory); pass an absolute `dir` to scope it to a subdirectory. Optional `agent` gives it a persistent role (see list_agents); optional `model` overrides the model (cheap Haiku for grunt work, Opus for hard tasks). Optional `prompt` seeds its first turn. Returns the new session id (use it with run_in_session).",
  inputSchema: { type: 'object', properties: { dir: { type: 'string', description: "Absolute path; defaults to the calling session's own folder" }, ...agentProp, ...modelProp, prompt: { type: 'string' } } },
  handler: async (sessionId, args) => {
    const dir = args.dir != null ? String(args.dir) : undefined
    if (dir) { try { await access(dir) } catch { return { error: `no such directory: ${dir}` } } }
    const a = resolveAgentArg(args)
    if ('error' in a) return a
    return askRenderer('spawnSubsession', sessionId, { dir, agent: a.agent, model: modelArg(args), prompt: args.prompt })
  },
})
appMcp.register({
  name: 'create_session',
  description: 'Open a new top-level Claude session in the given absolute directory. Optional `agent` gives it a persistent role (see list_agents); optional `model` overrides the model. Optional `prompt` seeds its first turn. Returns the new session id.',
  inputSchema: { type: 'object', properties: { dir: { type: 'string' }, ...agentProp, ...modelProp, prompt: { type: 'string' } }, required: ['dir'] },
  handler: async (sessionId, args) => {
    const dir = String(args.dir ?? '')
    if (!dir) return { error: 'dir is required' }
    try { await access(dir) } catch { return { error: `no such directory: ${dir}` } }
    const a = resolveAgentArg(args)
    if ('error' in a) return a
    return askRenderer('createSession', sessionId, { dir, agent: a.agent, model: modelArg(args), prompt: args.prompt })
  },
})
appMcp.register({
  name: 'close_session',
  description: 'Close a ClaudeMaster session (and any of its subsessions) by id, from list_sessions. Destructive.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  handler: async (sessionId, args) => {
    const id = String(args.id ?? '')
    if (!id) return { error: 'id is required' }
    if (id === sessionId) return { error: 'refusing to close the calling session' }
    if (!sessions.list().some((s) => s.id === id)) return { error: `no such session: ${id}` }
    return askRenderer('closeSession', sessionId, { id })
  },
})
appMcp.register({
  name: 'run_in_session',
  description: 'Send a prompt (a new user turn) to another ClaudeMaster session by id (from list_sessions). Use to orchestrate sibling agents — e.g. hand a subsession a task.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' } }, required: ['id', 'prompt'] },
  handler: async (sessionId, args) => {
    const id = String(args.id ?? '')
    const prompt = String(args.prompt ?? '')
    if (!id || !prompt) return { error: 'id and prompt are required' }
    if (id === sessionId) return { error: 'refusing to send a turn to yourself' }
    if (!sessions.list().some((s) => s.id === id)) return { error: `no such session: ${id}` }
    // Seed via the renderer so the target's transcript shows the injected prompt
    // as a user turn (the chat store echoes it), then sends over stream-json.
    return askRenderer('runInSession', sessionId, { id, prompt })
  },
})
appMcp.register({
  name: 'report_to_parent',
  description: "Report a result back to the session that spawned you (a subsession's parent). Send a tight `summary` of what you found or did — this closes the orchestration loop so the parent gets your distilled result instead of scraping your transcript. Optional `status` (e.g. 'done', 'blocked', 'failed'). The report is QUEUED and delivered when the parent is next idle, so it never interrupts the parent mid-task; several siblings' reports batch into one turn. Errors if this is a top-level session with no parent.",
  inputSchema: { type: 'object', properties: { summary: { type: 'string' }, status: { type: 'string' } }, required: ['summary'] },
  handler: async (sessionId, args) => {
    const summary = String(args.summary ?? '')
    if (!summary) return { error: 'summary is required' }
    const parentId = sessions.list().find((s) => s.id === sessionId)?.parentId
    if (!parentId) return { error: 'this is a top-level session — it has no parent to report to.' }
    if (!sessions.list().some((s) => s.id === parentId)) return { error: 'the parent session is no longer open.' }
    const status = args.status != null ? String(args.status) : ''
    // Tagged so the parent knows it came from a subsession. The renderer queues it
    // and flushes to the parent's transcript on the parent's next idle (deferred
    // delivery — see AppControlBridge), so a busy parent isn't interrupted.
    const text = `[report from subsession ${sessionId}${status ? ` — ${status}` : ''}]\n\n${summary}`
    return askRenderer('reportToParent', sessionId, { parentId, text })
  },
})
ipcMain.handle('remotes:list', () => remotes.list())
ipcMain.handle('remotes:add', (_, input: Omit<RemoteConfig, 'id'>) => remotes.add(input))
ipcMain.handle('remotes:update', async (_, remote: RemoteConfig) => {
  const prev = await remotes.get(remote.id)
  await remotes.update(remote)
  // A JupyterManager caches the RemoteConfig it was built with, so an edit (e.g. a
  // new pythonPath) wouldn't take effect until restart. Rebuild it — but only when a
  // LAUNCH-relevant field changed, so a cosmetic edit (label/defaultDir) doesn't
  // tear down a running server and kill its open kernels.
  const launchChanged = !prev
    || prev.pythonPath !== remote.pythonPath
    || prev.host !== remote.host
    || (prev.sshOptions ?? []).join('\x00') !== (remote.sshOptions ?? []).join('\x00')
  if (launchChanged) invalidateRemoteJupyter(remote.id)
})
ipcMain.handle('remotes:remove', async (_, id: string) => {
  await remotes.remove(id)
  invalidateRemoteJupyter(id)
})
ipcMain.handle('remotes:test', (_, remote: RemoteConfig) => remotes.test(remote))
ipcMain.handle('remotes:homeDir', (_, remote: RemoteConfig) => remotes.homeDir(remote))
// Top-level Host aliases from ~/.ssh/config, for one-click quick-add in the picker.
ipcMain.handle('remotes:sshConfigHosts', () => sshConfig.listHosts())
// Resolve a saved remote's real user/host/port (via `ssh -G`) for display.
ipcMain.handle('remotes:resolveHost', (_, host: string, sshOptions?: string[]) => sshConfig.resolve(host, sshOptions ?? []))

ipcMain.handle('pane:create', async (_, cwd: string) => panes.create(cwd, await remoteFor(cwd)))
ipcMain.handle('pane:destroy', (_, id: string) => panes.destroy(id))
ipcMain.on('pane:input', (_, id: string, data: string) => panes.sendInput(id, data))
ipcMain.on('pane:resize', (_, id: string, cols: number, rows: number) => panes.resize(id, cols, rows))

ipcMain.handle('fs:readDir', async (_, path: string): Promise<DirEntry[]> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.readDir(remote, parseTarget(path).path)
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const detailed = await Promise.all(
      entries.map(async (e) => {
        // stat for size/mtime; tolerate unreadable entries (broken symlinks, perms).
        let size = 0, mtimeMs = 0
        try { const s = await stat(join(path, e.name)); size = s.size; mtimeMs = s.mtimeMs } catch { /* leave 0 */ }
        return { name: e.name, isDir: e.isDirectory(), size, mtimeMs }
      })
    )
    // Default order (folders first, by name); the renderer re-sorts on demand.
    return detailed.sort((a, b) =>
      a.isDir !== b.isDir
        ? a.isDir ? -1 : 1
        : a.name.localeCompare(b.name)
    )
  } catch {
    return []
  }
})
ipcMain.handle('shell:openPath', (_, path: string) => shell.openPath(path))

// --- File watching (notebook conflict backstop) ------------------------------
// The open NotebookView watches its file so an EXTERNAL write (Bash, git, a
// sibling agent's quiet disk write) is caught: a clean pane reloads, a dirty pane
// raises a conflict banner. The app's own in-memory MCP edits never touch disk,
// so they don't fire this; its own saves are echo-filtered renderer-side by
// comparing content. Ref-counted so several sessions watching one path share one
// watcher. Local uses fs.watch (debounced — it can double-fire); remote polls mtime.
const fileWatchers = new Map<string, { close: () => void; count: number }>()
ipcMain.on('fs:watch', async (_, path: string) => {
  const existing = fileWatchers.get(path)
  if (existing) { existing.count++; return }
  const notify = () => mainWindow?.webContents.send('fs:changed', path)
  const remote = await remoteFor(path)
  let close: () => void
  if (remote) {
    const bare = parseTarget(path).path
    let last = await remoteFs.mtimeMs(remote, bare).catch(() => 0)
    const iv = setInterval(async () => {
      const m = await remoteFs.mtimeMs(remote, bare).catch(() => last)
      if (m !== last) { last = m; notify() }
    }, 2000)
    close = () => clearInterval(iv)
  } else {
    let timer: NodeJS.Timeout | null = null
    let w: ReturnType<typeof watch> | null = null
    try {
      w = watch(path, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(notify, 200)
      })
      w.on('error', () => {})
    } catch { /* file may not exist yet; watch is best-effort */ }
    close = () => { if (timer) clearTimeout(timer); w?.close() }
  }
  fileWatchers.set(path, { close, count: 1 })
})
ipcMain.on('fs:unwatch', (_, path: string) => {
  const e = fileWatchers.get(path)
  if (!e) return
  if (--e.count <= 0) { e.close(); fileWatchers.delete(path) }
})

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Pick a destination path in destDir that doesn't already exist, appending
// " (1)", " (2)", … before the extension on collision — like a file manager.
async function uniqueDest(destDir: string, name: string): Promise<string> {
  const exists = async (p: string) => { try { await access(p); return true } catch { return false } }
  if (!(await exists(join(destDir, name)))) return join(destDir, name)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = join(destDir, `${stem} (${i})${ext}`)
    if (!(await exists(candidate))) return candidate
  }
}

// Copy a file/dir (recursively) into destDir, never overwriting.
ipcMain.handle('fs:copy', async (_, src: string, destDir: string): Promise<WriteResult> => {
  const remote = await remoteFor(destDir)
  if (remote) return remoteFs.copy(remote, parseTarget(src).path, parseTarget(destDir).path)
  try {
    await cp(src, await uniqueDest(destDir, basename(src)), { recursive: true })
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Move a file/dir into destDir. rename() is atomic on the same filesystem; fall
// back to copy+remove across devices.
ipcMain.handle('fs:move', async (_, src: string, destDir: string): Promise<WriteResult> => {
  const remote = await remoteFor(destDir)
  if (remote) return remoteFs.move(remote, parseTarget(src).path, parseTarget(destDir).path)
  try {
    const dest = await uniqueDest(destDir, basename(src))
    try {
      await rename(src, dest)
    } catch {
      await cp(src, dest, { recursive: true })
      await rm(src, { recursive: true, force: true })
    }
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Delete to the OS trash (recoverable) rather than an irreversible unlink.
ipcMain.handle('fs:delete', async (_, path: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.del(remote, parseTarget(path).path)
  try {
    await shell.trashItem(path)
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Rename within the same directory; refuse to clobber an existing name.
ipcMain.handle('fs:rename', async (_, path: string, newName: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.rename(remote, parseTarget(path).path, newName)
  try {
    const dest = join(dirname(path), newName)
    if (dest === path) return { ok: true }
    try { await access(dest); return { ok: false, error: 'A file with that name already exists' } }
    catch { /* name is free */ }
    await rename(path, dest)
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Create a new (empty) directory; non-recursive so it fails if it already exists.
ipcMain.handle('fs:mkdir', async (_, path: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.mkdir(remote, parseTarget(path).path)
  try {
    await mkdir(path)
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Create a new empty file; 'wx' fails rather than truncate an existing file.
ipcMain.handle('fs:createFile', async (_, path: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.createFile(remote, parseTarget(path).path)
  try {
    await writeFile(path, '', { flag: 'wx' })
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}
const MAX_TEXT_BYTES = 2 * 1024 * 1024 // 2 MB cap for text previews

ipcMain.handle('fs:readFile', async (_, path: string): Promise<FilePreview> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.readFile(remote, parseTarget(path).path)
  const name = basename(path)
  try {
    const ext = extname(path).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (mime) {
      const buf = await readFile(path)
      return { kind: 'image', name, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    }

    // Render PDFs inline via Chromium's built-in viewer (travels over VNC).
    if (ext === '.pdf') {
      const buf = await readFile(path)
      return { kind: 'pdf', name, dataUrl: `data:application/pdf;base64,${buf.toString('base64')}` }
    }

    const { size } = await stat(path)
    const buf = await readFile(path)
    // Binary heuristic: a NUL byte in the first chunk means "not text".
    if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary', name }

    const truncated = size > MAX_TEXT_BYTES
    const text = buf.subarray(0, MAX_TEXT_BYTES).toString('utf8')
    return { kind: 'text', name, text, truncated }
  } catch (err) {
    return { kind: 'error', name, message: err instanceof Error ? err.message : String(err) }
  }
})

// Full, untruncated UTF-8 read — used for .ipynb so notebooks round-trip without
// the size cap / binary heuristic that fs:readFile applies for previews.
ipcMain.handle('fs:readText', async (_, path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.readText(remote, parseTarget(path).path)
  try {
    const text = await readFile(path, 'utf8')
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('fs:writeFile', async (_, path: string, content: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.writeFile(remote, parseTarget(path).path, content)
  try {
    await writeFile(path, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// --- Docs / knowledge layer (wikilink resolve + create) ---------------------
// rootDir may be a remote:// path; remoteFor picks the host (memory root is
// local-only, handled inside docsIndex).
ipcMain.handle('docs:resolve', async (_, rootDir: string, fromPath: string, target: string): Promise<string | null> =>
  docsIndex.resolveDoc(rootDir, fromPath, target, await remoteFor(rootDir))
)
ipcMain.handle('docs:create', async (_, rootDir: string, target: string) =>
  docsIndex.createDoc(rootDir, target, await remoteFor(rootDir))
)

// Jupyter servers: the local one, plus lazily-created tunneled servers keyed by
// `${remoteId}:${interpreter}`. `path` is the notebook's (possibly remote-encoded)
// path, used to pick the host AND to resolve which interpreter launches the server.
const remoteJupyter = new Map<string, JupyterManager>()
// Interpreter resolved by walking up from a notebook's directory, cached per
// `${remoteId}:${startDir}` so the ssh walk runs at most once per directory.
const nearestPythonCache = new Map<string, string>()
// Tear down + forget ALL of a host's cached Jupyter servers and resolved
// interpreters (on remote edit/removal) so they rebuild from the current
// RemoteConfig next time. Hoisted, so the remotes:update/remove handlers can call it.
function invalidateRemoteJupyter(id: string): void {
  const prefix = `${id}:`
  for (const [key, jm] of remoteJupyter) {
    if (key.startsWith(prefix)) { jm.destroy(); remoteJupyter.delete(key) }
  }
  for (const key of nearestPythonCache.keys()) {
    if (key.startsWith(prefix)) nearestPythonCache.delete(key)
  }
}
async function jupyterFor(path?: string): Promise<JupyterManager> {
  const remote = path ? await remoteFor(path) : undefined
  if (!remote) return jupyter
  // Interpreter to launch Jupyter with: an explicit remote.pythonPath override
  // wins; otherwise walk up from the notebook's own directory for the nearest
  // venv that actually has jupyter_server (falling back to bare python3). This is
  // what lets a host with per-project venvs "just work" without hand-configuring
  // a path — see findNearestPython.
  let pythonPath = remote.pythonPath?.trim()
  if (!pythonPath) {
    const startDir = dirname(parseTarget(path!).path)
    const cacheKey = `${remote.id}:${startDir}`
    pythonPath = nearestPythonCache.get(cacheKey)
    if (!pythonPath) {
      pythonPath = (await findNearestPython(remote, startDir)) ?? 'python3'
      nearestPythonCache.set(cacheKey, pythonPath)
    }
  }
  const key = `${remote.id}:${pythonPath}`
  let jm = remoteJupyter.get(key)
  if (!jm) { jm = new JupyterManager({ ...remote, pythonPath }); remoteJupyter.set(key, jm) }
  return jm
}
ipcMain.handle('jupyter:start', async (_, dir?: string) => (await jupyterFor(dir)).start())
ipcMain.handle('jupyter:install', async (_, dir?: string) => (await jupyterFor(dir)).install())

ipcMain.handle('git:status', (_, dir: string) => gitManager.status(dir))
ipcMain.handle('git:diff', (_, dir: string, file: string, staged: boolean, untracked: boolean) =>
  gitManager.diff(dir, file, staged, untracked)
)
ipcMain.handle('git:stage', (_, dir: string, file: string) => gitManager.stage(dir, file))
ipcMain.handle('git:unstage', (_, dir: string, file: string) => gitManager.unstage(dir, file))
ipcMain.handle('git:stageAll', (_, dir: string) => gitManager.stageAll(dir))
ipcMain.handle('git:stageTracked', (_, dir: string) => gitManager.stageTracked(dir))
ipcMain.handle('git:unstageAll', (_, dir: string) => gitManager.unstageAll(dir))
ipcMain.handle('git:commit', (_, dir: string, message: string) => gitManager.commit(dir, message))
ipcMain.handle('git:log', (_, dir: string, limit?: number) => gitManager.log(dir, limit))
ipcMain.handle('git:show', (_, dir: string, hash: string) => gitManager.show(dir, hash))
ipcMain.handle('git:branches', (_, dir: string) => gitManager.branches(dir))
ipcMain.handle('git:createBranch', (_, dir: string, name: string) => gitManager.createBranch(dir, name))
ipcMain.handle('git:checkoutBranch', (_, dir: string, name: string) => gitManager.checkoutBranch(dir, name))
ipcMain.handle('git:deleteBranch', (_, dir: string, name: string, force: boolean) => gitManager.deleteBranch(dir, name, force))
ipcMain.handle('git:mergeBranch', (_, dir: string, name: string) => gitManager.mergeBranch(dir, name))

// Bring the window forward (e.g. from a notification click).
ipcMain.handle('app:focus', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

// Reflect the count of sessions needing attention on the OS: dock/taskbar badge
// (macOS, Linux Unity) plus a frame flash while the window is unfocused.
ipcMain.handle('app:setAttention', (_, count: number) => {
  app.badgeCount = Math.max(0, count)
  if (!mainWindow) return
  mainWindow.flashFrame(count > 0 && !mainWindow.isFocused())
})

ipcMain.handle('dialog:openDir', async (_, defaultPath?: string) => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: defaultPath || homedir(),
  })
  return result.canceled ? null : result.filePaths[0]
})

// Native "Save as…" picker — returns the chosen absolute path (local), or null
// if cancelled. Writing is done separately via fs:writeFile.
ipcMain.handle('dialog:saveFile', async (_, defaultName?: string) => {
  if (!mainWindow) return null
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName ? join(homedir(), defaultName) : homedir(),
  })
  return result.canceled ? null : (result.filePath ?? null)
})

// Last-resort net: an async throw with no local handler (a child-process 'error'
// we didn't wire, a stray rejected promise) would otherwise kill the whole main
// process — every session's terminal dies at once with no explanation. Log it and
// keep running; the specific handlers above are what actually report failures to
// the user, this just stops one stray throw from taking the app down.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

app.whenReady().then(async () => {
  // Start the app-control server before any session launches so configFor() has a port.
  try { await appMcp.start() } catch (e) { console.error('app-control MCP server failed to start:', e) }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  jupyter.destroy()
  for (const jm of remoteJupyter.values()) jm.destroy()
  if (process.platform !== 'darwin') app.quit()
})
