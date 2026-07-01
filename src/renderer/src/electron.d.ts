import type { SessionInfo, SessionState, SavedSession, DirEntry, FilePreview, WriteResult, GitStatus, GitDiff, GitResult, GitLog, GitBranches, RemoteConfig, RemoteTest } from '../../shared/types'

declare global {
  interface Window {
    api: {
      session: {
        create: (name: string, cwd: string, rootDir?: string, parentId?: string, resume?: boolean) => Promise<string>
        destroy: (id: string) => Promise<void>
        relaunch: (id: string) => Promise<boolean>
        list: () => Promise<SessionInfo[]>
        sendInput: (id: string, data: string) => void
        resize: (id: string, cols: number, rows: number) => void
        loadSaved: () => Promise<SavedSession[]>
        saveState: (sessions: SavedSession[]) => Promise<void>
        autosave: (sessions: SavedSession[]) => Promise<void>
      }
      remotes: {
        list: () => Promise<RemoteConfig[]>
        add: (input: Omit<RemoteConfig, 'id'>) => Promise<RemoteConfig>
        update: (remote: RemoteConfig) => Promise<void>
        remove: (id: string) => Promise<void>
        test: (remote: RemoteConfig) => Promise<RemoteTest>
        homeDir: (remote: RemoteConfig) => Promise<string>
      }
      pane: {
        create: (cwd: string) => Promise<string>
        destroy: (id: string) => Promise<void>
        sendInput: (id: string, data: string) => void
        resize: (id: string, cols: number, rows: number) => void
      }
      dialog: {
        openDir: (defaultPath?: string) => Promise<string | null>
      }
      fs: {
        readDir: (path: string) => Promise<DirEntry[]>
        readFile: (path: string) => Promise<FilePreview>
        readText: (path: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>
        writeFile: (path: string, content: string) => Promise<WriteResult>
        copy: (src: string, destDir: string) => Promise<WriteResult>
        move: (src: string, destDir: string) => Promise<WriteResult>
        delete: (path: string) => Promise<WriteResult>
        rename: (path: string, newName: string) => Promise<WriteResult>
        mkdir: (path: string) => Promise<WriteResult>
        createFile: (path: string) => Promise<WriteResult>
        pathForFile: (file: File) => string
      }
      shell: {
        openPath: (path: string) => Promise<string>
      }
      app: {
        focus: () => Promise<void>
        setAttention: (count: number) => Promise<void>
      }
      jupyter: {
        start: (dir?: string) => Promise<{ url: string; token: string } | null>
        install: (dir?: string) => Promise<boolean>
      }
      git: {
        status: (dir: string) => Promise<GitStatus>
        diff: (dir: string, file: string, staged: boolean, untracked: boolean) => Promise<GitDiff>
        stage: (dir: string, file: string) => Promise<GitResult>
        unstage: (dir: string, file: string) => Promise<GitResult>
        stageAll: (dir: string) => Promise<GitResult>
        unstageAll: (dir: string) => Promise<GitResult>
        commit: (dir: string, message: string) => Promise<GitResult>
        log: (dir: string, limit?: number) => Promise<GitLog>
        show: (dir: string, hash: string) => Promise<GitDiff>
        branches: (dir: string) => Promise<GitBranches>
        createBranch: (dir: string, name: string) => Promise<GitResult>
        checkoutBranch: (dir: string, name: string) => Promise<GitResult>
        deleteBranch: (dir: string, name: string, force: boolean) => Promise<GitResult>
        mergeBranch: (dir: string, name: string) => Promise<GitResult>
      }
      on: {
        output: (cb: (id: string, data: string) => void) => () => void
        stateChange: (cb: (id: string, state: string) => void) => () => void
        exit: (cb: (id: string, failedFast: boolean, error: string) => void) => () => void
        paneOutput: (cb: (id: string, data: string) => void) => () => void
        paneExit: (cb: (id: string) => void) => () => void
        requestSave: (cb: () => void) => () => void
      }
    }
  }
}

export {}
