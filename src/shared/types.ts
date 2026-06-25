export type SessionState = 'idle' | 'running' | 'waiting'

export interface SessionInfo {
  id: string
  name: string
  cwd: string
  state: SessionState
}

export interface SavedSession {
  name: string
  cwd: string
  scrollback: string
  paneScrollback?: string
}

export interface DirEntry {
  name: string
  isDir: boolean
}

// In-app file preview, returned by fs:readFile. Travels over IPC (and therefore
// over VNC for remote launches), so no external viewer / window manager needed.
export type FilePreview =
  | { kind: 'image'; name: string; dataUrl: string }
  | { kind: 'text'; name: string; text: string; truncated: boolean }
  | { kind: 'binary'; name: string }
  | { kind: 'error'; name: string; message: string }

export type WriteResult = { ok: true } | { ok: false; error: string }
