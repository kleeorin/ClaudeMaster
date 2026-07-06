import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SessionInfo, SavedSession, DirEntry, FilePreview, WriteResult, GitStatus, GitDiff, GitResult, GitLog, GitBranches, RemoteConfig, RemoteTest, ClaudeEvent, PermissionRequest, PermissionDecision, ConversationMeta, EffectivePermissions, PermissionMode, PermissionScope, PermissionAction, SetModeResult, SshConfigHost, ResolvedHost } from '../shared/types'

// The whole-app frontend, handed over synchronously by main via additionalArguments
// so the renderer can pick its chat surface (ChatView vs TerminalView) on first
// render, with no async round-trip. Defaults to 'native' if the arg is absent.
const frontendArg = process.argv.find((a) => a.startsWith('--cm-frontend='))?.split('=')[1]
const frontend: 'native' | 'tui' = frontendArg === 'tui' ? 'tui' : 'native'

contextBridge.exposeInMainWorld('api', {
  frontend,
  agents: {
    list: (): Promise<Array<{ id: string; name: string; description: string }>> =>
      ipcRenderer.invoke('agents:list'),
  },
  models: {
    list: (): Promise<Array<{ id: string; name: string }>> =>
      ipcRenderer.invoke('models:list'),
  },
  perms: {
    // The effective permission picture from Claude's own settings files for a
    // session's cwd + agent role.
    get: (cwd: string, agentId?: string): Promise<EffectivePermissions> =>
      ipcRenderer.invoke('perms:get', cwd, agentId),
    // Set a session's permission mode (live if supported, else on next launch).
    setMode: (sessionId: string, mode: PermissionMode): Promise<SetModeResult> =>
      ipcRenderer.invoke('perms:setMode', sessionId, mode),
    // Add / remove an allow|deny|ask rule in the chosen settings file.
    addRule: (cwd: string, scope: PermissionScope, action: PermissionAction, value: string): Promise<WriteResult> =>
      ipcRenderer.invoke('perms:addRule', cwd, scope, action, value),
    removeRule: (cwd: string, scope: PermissionScope, action: PermissionAction, value: string): Promise<WriteResult> =>
      ipcRenderer.invoke('perms:removeRule', cwd, scope, action, value),
  },
  settings: {
    getFrontend: (): Promise<'native' | 'tui'> =>
      ipcRenderer.invoke('settings:getFrontend'),
    // Persist the choice; takes effect on next launch (caller shows a restart notice).
    setFrontend: (f: 'native' | 'tui'): Promise<void> =>
      ipcRenderer.invoke('settings:setFrontend', f),
  },
  session: {
    create: (name: string, cwd: string, rootDir?: string, parentId?: string, resume?: boolean, claudeSessionId?: string, agentId?: string, model?: string, permissionMode?: PermissionMode): Promise<string> =>
      ipcRenderer.invoke('session:create', name, cwd, rootDir, parentId, resume, claudeSessionId, agentId, model, permissionMode),
    destroy: (id: string): Promise<void> =>
      ipcRenderer.invoke('session:destroy', id),
    relaunch: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('session:relaunch', id),
    list: (): Promise<SessionInfo[]> =>
      ipcRenderer.invoke('session:list'),
    // Native-chat turn I/O (stream-json). `sendTurn` submits a whole user turn;
    // `interrupt` is the Esc equivalent; `respondPermission` answers a prompt.
    sendTurn: (id: string, text: string): void =>
      ipcRenderer.send('session:sendTurn', id, text),
    interrupt: (id: string): void =>
      ipcRenderer.send('session:interrupt', id),
    // TUI mode: raw keystroke input + terminal resize for the session pty.
    sendInput: (id: string, data: string): void =>
      ipcRenderer.send('session:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('session:resize', id, cols, rows),
    respondPermission: (id: string, requestId: string, decision: PermissionDecision): void =>
      ipcRenderer.send('session:respondPermission', id, requestId, decision),
    claudeId: (id: string): Promise<string | undefined> =>
      ipcRenderer.invoke('session:claudeId', id),
    // Native /resume: list/read past conversations, and rebind a session to one.
    listConversations: (cwd: string): Promise<ConversationMeta[]> =>
      ipcRenderer.invoke('session:listConversations', cwd),
    readConversation: (cwd: string, id: string): Promise<ClaudeEvent[]> =>
      ipcRenderer.invoke('session:readConversation', cwd, id),
    resumeInto: (id: string, claudeSessionId: string): void =>
      ipcRenderer.send('session:resumeInto', id, claudeSessionId),
    clear: (id: string): void =>
      ipcRenderer.send('session:clear', id),
    // App-control: publish the active pane (for path-less tools) + answer a
    // renderer-side tool request (open a file/pane) the main process forwarded.
    publishActivePane: (sessionId: string, info: { path: string; isNotebook: boolean } | null): void =>
      ipcRenderer.send('session:activePane', sessionId, info),
    appControlRespond: (reqId: number, result: { text?: string; error?: string }): void =>
      ipcRenderer.send('appcontrol:response', reqId, result),
    loadSaved: (): Promise<SavedSession[]> =>
      ipcRenderer.invoke('session:load-saved'),
    saveState: (saved: SavedSession[]): Promise<void> =>
      ipcRenderer.invoke('session:save-state', saved),
    autosave: (saved: SavedSession[]): Promise<void> =>
      ipcRenderer.invoke('session:autosave', saved),
  },
  remotes: {
    list: (): Promise<RemoteConfig[]> =>
      ipcRenderer.invoke('remotes:list'),
    add: (input: Omit<RemoteConfig, 'id'>): Promise<RemoteConfig> =>
      ipcRenderer.invoke('remotes:add', input),
    update: (remote: RemoteConfig): Promise<void> =>
      ipcRenderer.invoke('remotes:update', remote),
    remove: (id: string): Promise<void> =>
      ipcRenderer.invoke('remotes:remove', id),
    test: (remote: RemoteConfig): Promise<RemoteTest> =>
      ipcRenderer.invoke('remotes:test', remote),
    homeDir: (remote: RemoteConfig): Promise<string> =>
      ipcRenderer.invoke('remotes:homeDir', remote),
    // ~/.ssh/config Host aliases, for one-click quick-add.
    sshConfigHosts: (): Promise<SshConfigHost[]> =>
      ipcRenderer.invoke('remotes:sshConfigHosts'),
    // Resolve a host's real user/host/port for display (via `ssh -G`).
    resolveHost: (host: string, sshOptions?: string[]): Promise<ResolvedHost> =>
      ipcRenderer.invoke('remotes:resolveHost', host, sshOptions),
  },
  pane: {
    create: (cwd: string): Promise<string> =>
      ipcRenderer.invoke('pane:create', cwd),
    destroy: (id: string): Promise<void> =>
      ipcRenderer.invoke('pane:destroy', id),
    sendInput: (id: string, data: string): void =>
      ipcRenderer.send('pane:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pane:resize', id, cols, rows),
  },
  dialog: {
    openDir: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openDir', defaultPath),
    saveFile: (defaultName?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:saveFile', defaultName),
  },
  fs: {
    readDir: (path: string): Promise<DirEntry[]> =>
      ipcRenderer.invoke('fs:readDir', path),
    readFile: (path: string): Promise<FilePreview> =>
      ipcRenderer.invoke('fs:readFile', path),
    readText: (path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('fs:readText', path),
    writeFile: (path: string, content: string): Promise<WriteResult> =>
      ipcRenderer.invoke('fs:writeFile', path, content),
    copy: (src: string, destDir: string): Promise<WriteResult> =>
      ipcRenderer.invoke('fs:copy', src, destDir),
    move: (src: string, destDir: string): Promise<WriteResult> =>
      ipcRenderer.invoke('fs:move', src, destDir),
    delete: (path: string): Promise<WriteResult> =>
      ipcRenderer.invoke('fs:delete', path),
    rename: (path: string, newName: string): Promise<WriteResult> =>
      ipcRenderer.invoke('fs:rename', path, newName),
    mkdir: (path: string): Promise<WriteResult> =>
      ipcRenderer.invoke('fs:mkdir', path),
    createFile: (path: string): Promise<WriteResult> =>
      ipcRenderer.invoke('fs:createFile', path),
    // Watch a file for external changes (the notebook conflict backstop). Ref-
    // counted in main; pair each watch() with an unwatch() on unmount.
    watch: (path: string): void => ipcRenderer.send('fs:watch', path),
    unwatch: (path: string): void => ipcRenderer.send('fs:unwatch', path),
    // Resolve the absolute path of a dropped File (for drag-in from the OS).
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
  },
  docs: {
    // Resolve a `[[wikilink]]` target to an existing .md path (or null).
    resolve: (rootDir: string, fromPath: string, target: string): Promise<string | null> =>
      ipcRenderer.invoke('docs:resolve', rootDir, fromPath, target),
    // Create docs/<slug>.md for a missing target and return its path.
    create: (rootDir: string, target: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('docs:create', rootDir, target),
  },
  shell: {
    openPath: (path: string): Promise<string> =>
      ipcRenderer.invoke('shell:openPath', path),
  },
  app: {
    focus: (): Promise<void> =>
      ipcRenderer.invoke('app:focus'),
    setAttention: (count: number): Promise<void> =>
      ipcRenderer.invoke('app:setAttention', count),
  },
  jupyter: {
    // `dir` (the notebook's directory, possibly remote-encoded) selects which
    // host's Jupyter server to use; omit for the local server.
    start: (dir?: string): Promise<{ url: string; token: string } | null> =>
      ipcRenderer.invoke('jupyter:start', dir),
    install: (dir?: string): Promise<boolean> =>
      ipcRenderer.invoke('jupyter:install', dir),
  },
  git: {
    status: (dir: string): Promise<GitStatus> =>
      ipcRenderer.invoke('git:status', dir),
    diff: (dir: string, file: string, staged: boolean, untracked: boolean): Promise<GitDiff> =>
      ipcRenderer.invoke('git:diff', dir, file, staged, untracked),
    stage: (dir: string, file: string): Promise<GitResult> =>
      ipcRenderer.invoke('git:stage', dir, file),
    unstage: (dir: string, file: string): Promise<GitResult> =>
      ipcRenderer.invoke('git:unstage', dir, file),
    stageAll: (dir: string): Promise<GitResult> =>
      ipcRenderer.invoke('git:stageAll', dir),
    stageTracked: (dir: string): Promise<GitResult> =>
      ipcRenderer.invoke('git:stageTracked', dir),
    unstageAll: (dir: string): Promise<GitResult> =>
      ipcRenderer.invoke('git:unstageAll', dir),
    commit: (dir: string, message: string): Promise<GitResult> =>
      ipcRenderer.invoke('git:commit', dir, message),
    log: (dir: string, limit?: number): Promise<GitLog> =>
      ipcRenderer.invoke('git:log', dir, limit),
    show: (dir: string, hash: string): Promise<GitDiff> =>
      ipcRenderer.invoke('git:show', dir, hash),
    branches: (dir: string): Promise<GitBranches> =>
      ipcRenderer.invoke('git:branches', dir),
    createBranch: (dir: string, name: string): Promise<GitResult> =>
      ipcRenderer.invoke('git:createBranch', dir, name),
    checkoutBranch: (dir: string, name: string): Promise<GitResult> =>
      ipcRenderer.invoke('git:checkoutBranch', dir, name),
    deleteBranch: (dir: string, name: string, force: boolean): Promise<GitResult> =>
      ipcRenderer.invoke('git:deleteBranch', dir, name, force),
    mergeBranch: (dir: string, name: string): Promise<GitResult> =>
      ipcRenderer.invoke('git:mergeBranch', dir, name),
  },
  on: {
    // Structured stream-json events for the transcript (native chat).
    event: (cb: (id: string, e: ClaudeEvent) => void): (() => void) => {
      const h = (_: unknown, id: string, e: ClaudeEvent) => cb(id, e)
      ipcRenderer.on('session:event', h)
      return () => ipcRenderer.removeListener('session:event', h)
    },
    permission: (cb: (id: string, req: PermissionRequest) => void): (() => void) => {
      const h = (_: unknown, id: string, req: PermissionRequest) => cb(id, req)
      ipcRenderer.on('session:permission', h)
      return () => ipcRenderer.removeListener('session:permission', h)
    },
    ready: (cb: (id: string, claudeSessionId: string) => void): (() => void) => {
      const h = (_: unknown, id: string, claudeSessionId: string) => cb(id, claudeSessionId)
      ipcRenderer.on('session:ready', h)
      return () => ipcRenderer.removeListener('session:ready', h)
    },
    appControlRequest: (cb: (req: { reqId: number; op: string; sessionId: string; args: Record<string, unknown> }) => void): (() => void) => {
      const h = (_: unknown, req: { reqId: number; op: string; sessionId: string; args: Record<string, unknown> }) => cb(req)
      ipcRenderer.on('appcontrol:request', h)
      return () => ipcRenderer.removeListener('appcontrol:request', h)
    },
    stateChange: (cb: (id: string, state: string) => void): (() => void) => {
      const h = (_: unknown, id: string, state: string) => cb(id, state)
      ipcRenderer.on('session:stateChange', h)
      return () => ipcRenderer.removeListener('session:stateChange', h)
    },
    exit: (cb: (id: string, failedFast: boolean, error: string) => void): (() => void) => {
      const h = (_: unknown, id: string, failedFast: boolean, error: string) => cb(id, failedFast, error)
      ipcRenderer.on('session:exit', h)
      return () => ipcRenderer.removeListener('session:exit', h)
    },
    // TUI mode: raw pty output for the session terminal (see session.sendInput).
    output: (cb: (id: string, data: string) => void): (() => void) => {
      const h = (_: unknown, id: string, data: string) => cb(id, data)
      ipcRenderer.on('session:output', h)
      return () => ipcRenderer.removeListener('session:output', h)
    },
    paneOutput: (cb: (id: string, data: string) => void): (() => void) => {
      const h = (_: unknown, id: string, data: string) => cb(id, data)
      ipcRenderer.on('pane:output', h)
      return () => ipcRenderer.removeListener('pane:output', h)
    },
    paneExit: (cb: (id: string) => void): (() => void) => {
      const h = (_: unknown, id: string) => cb(id)
      ipcRenderer.on('pane:exit', h)
      return () => ipcRenderer.removeListener('pane:exit', h)
    },
    requestSave: (cb: () => void): (() => void) => {
      const h = () => cb()
      ipcRenderer.on('app:request-save', h)
      return () => ipcRenderer.removeListener('app:request-save', h)
    },
    // A watched file changed on disk (see fs.watch). Carries the watched path.
    fileChanged: (cb: (path: string) => void): (() => void) => {
      const h = (_: unknown, path: string) => cb(path)
      ipcRenderer.on('fs:changed', h)
      return () => ipcRenderer.removeListener('fs:changed', h)
    },
  },
})
