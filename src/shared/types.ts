export type SessionState = 'idle' | 'running' | 'waiting'

export interface SessionInfo {
  id: string
  name: string
  cwd: string        // where Claude runs (a subsession shares its parent's cwd)
  rootDir: string    // root for the terminal pane + file browser (a subdir for subsessions)
  parentId?: string  // set on subsessions; points at the owning session
  state: SessionState
}

export interface SavedSession {
  name: string
  cwd: string
  rootDir?: string       // defaults to cwd when absent (older saves)
  parentIndex?: number   // index of the parent within the saved array (subsessions only)
  hasPane?: boolean
}

export interface DirEntry {
  name: string
  isDir: boolean
  size: number     // bytes; 0 for directories / unreadable entries
  mtimeMs: number  // last-modified epoch ms; 0 if unreadable
}

// In-app file preview, returned by fs:readFile. Travels over IPC (and therefore
// over VNC for remote launches), so no external viewer / window manager needed.
export type FilePreview =
  | { kind: 'image'; name: string; dataUrl: string }
  | { kind: 'pdf'; name: string; dataUrl: string }
  | { kind: 'text'; name: string; text: string; truncated: boolean }
  | { kind: 'binary'; name: string }
  | { kind: 'error'; name: string; message: string }

export type WriteResult = { ok: true } | { ok: false; error: string }
