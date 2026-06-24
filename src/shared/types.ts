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
