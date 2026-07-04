import type { SessionInfo, SessionState, SavedSession, DirEntry, FilePreview, WriteResult, GitStatus, GitDiff, GitResult, GitLog, GitBranches, RemoteConfig, RemoteTest, ClaudeEvent, PermissionRequest, PermissionDecision, ConversationMeta } from '../../shared/types'

declare global {
  interface Window {
    api: {
      // The whole-app frontend, chosen at startup (restart to change).
      frontend: 'native' | 'tui'
      agents: {
        list: () => Promise<Array<{ id: string; name: string; description: string }>>
      }
      models: {
        list: () => Promise<Array<{ id: string; name: string }>>
      }
      settings: {
        getFrontend: () => Promise<'native' | 'tui'>
        setFrontend: (f: 'native' | 'tui') => Promise<void>
      }
      session: {
        create: (name: string, cwd: string, rootDir?: string, parentId?: string, resume?: boolean, claudeSessionId?: string, agentId?: string, model?: string) => Promise<string>
        destroy: (id: string) => Promise<void>
        relaunch: (id: string) => Promise<boolean>
        list: () => Promise<SessionInfo[]>
        sendTurn: (id: string, text: string) => void
        interrupt: (id: string) => void
        // TUI mode: raw pty keystroke input + terminal resize.
        sendInput: (id: string, data: string) => void
        resize: (id: string, cols: number, rows: number) => void
        respondPermission: (id: string, requestId: string, decision: PermissionDecision) => void
        claudeId: (id: string) => Promise<string | undefined>
        listConversations: (cwd: string) => Promise<ConversationMeta[]>
        readConversation: (cwd: string, id: string) => Promise<ClaudeEvent[]>
        resumeInto: (id: string, claudeSessionId: string) => void
        clear: (id: string) => void
        publishActivePane: (sessionId: string, info: { path: string; isNotebook: boolean } | null) => void
        appControlRespond: (reqId: number, result: { text?: string; error?: string }) => void
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
        saveFile: (defaultName?: string) => Promise<string | null>
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
        watch: (path: string) => void
        unwatch: (path: string) => void
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
        stageTracked: (dir: string) => Promise<GitResult>
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
        event: (cb: (id: string, e: ClaudeEvent) => void) => () => void
        permission: (cb: (id: string, req: PermissionRequest) => void) => () => void
        ready: (cb: (id: string, claudeSessionId: string) => void) => () => void
        appControlRequest: (cb: (req: { reqId: number; op: string; sessionId: string; args: Record<string, unknown> }) => void) => () => void
        stateChange: (cb: (id: string, state: string) => void) => () => void
        exit: (cb: (id: string, failedFast: boolean, error: string) => void) => () => void
        output: (cb: (id: string, data: string) => void) => () => void
        paneOutput: (cb: (id: string, data: string) => void) => () => void
        paneExit: (cb: (id: string) => void) => () => void
        requestSave: (cb: () => void) => () => void
        fileChanged: (cb: (path: string) => void) => () => void
      }
    }
  }
}

export {}
