import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SessionInfo, SavedSession, DirEntry, FilePreview, WriteResult, GitStatus, GitDiff, GitResult, GitLog, GitBranches, RemoteConfig, RemoteTest } from '../shared/types'

contextBridge.exposeInMainWorld('api', {
  session: {
    create: (name: string, cwd: string, rootDir?: string, parentId?: string, resume?: boolean): Promise<string> =>
      ipcRenderer.invoke('session:create', name, cwd, rootDir, parentId, resume),
    destroy: (id: string): Promise<void> =>
      ipcRenderer.invoke('session:destroy', id),
    relaunch: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('session:relaunch', id),
    list: (): Promise<SessionInfo[]> =>
      ipcRenderer.invoke('session:list'),
    sendInput: (id: string, data: string): void =>
      ipcRenderer.send('session:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('session:resize', id, cols, rows),
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
    // Resolve the absolute path of a dropped File (for drag-in from the OS).
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
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
    output: (cb: (id: string, data: string) => void): (() => void) => {
      const h = (_: unknown, id: string, data: string) => cb(id, data)
      ipcRenderer.on('session:output', h)
      return () => ipcRenderer.removeListener('session:output', h)
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
  },
})
