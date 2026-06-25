import type { SessionInfo, SessionState, SavedSession, DirEntry, FilePreview, WriteResult } from '../../shared/types'

declare global {
  interface Window {
    api: {
      session: {
        create: (name: string, cwd: string) => Promise<string>
        destroy: (id: string) => Promise<void>
        list: () => Promise<SessionInfo[]>
        sendInput: (id: string, data: string) => void
        resize: (id: string, cols: number, rows: number) => void
        loadSaved: () => Promise<SavedSession[]>
        saveState: (sessions: SavedSession[]) => Promise<void>
        autosave: (sessions: SavedSession[]) => Promise<void>
      }
      pane: {
        create: (cwd: string) => Promise<string>
        destroy: (id: string) => Promise<void>
        sendInput: (id: string, data: string) => void
        resize: (id: string, cols: number, rows: number) => void
      }
      dialog: {
        openDir: () => Promise<string | null>
      }
      fs: {
        readDir: (path: string) => Promise<DirEntry[]>
        readFile: (path: string) => Promise<FilePreview>
        writeFile: (path: string, content: string) => Promise<WriteResult>
      }
      shell: {
        openPath: (path: string) => Promise<string>
      }
      jupyter: {
        start: () => Promise<{ url: string; token: string } | null>
        install: () => Promise<boolean>
      }
      on: {
        output: (cb: (id: string, data: string) => void) => () => void
        stateChange: (cb: (id: string, state: string) => void) => () => void
        exit: (cb: (id: string) => void) => () => void
        paneOutput: (cb: (id: string, data: string) => void) => () => void
        paneExit: (cb: (id: string) => void) => () => void
        requestSave: (cb: () => void) => () => void
      }
    }
  }
}

export {}
