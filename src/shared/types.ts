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
  paneCount?: number     // number of stacked terminal panes to restore
  hasPane?: boolean      // legacy: single pane (older saves); read as paneCount 1
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

// --- Git ---------------------------------------------------------------------

export interface GitFileStatus {
  path: string        // repo-relative path
  orig?: string       // original path for renames/copies
  index: string       // staged status char (X of the porcelain XY pair; ' ' = none)
  worktree: string    // unstaged status char (Y of the pair; ' ' = none)
  staged: boolean     // has staged changes (index is meaningful)
  unstaged: boolean   // has unstaged changes (worktree is meaningful)
  untracked: boolean  // not yet tracked by git
}

export type GitStatus =
  | { repo: true; branch: string; ahead: number; behind: number; files: GitFileStatus[] }
  | { repo: false }                    // dir isn't inside a git work tree
  | { repo: 'error'; error: string }

export type GitDiff = { ok: true; diff: string } | { ok: false; error: string }
export type GitResult = { ok: true } | { ok: false; error: string }

export interface GitCommit {
  hash: string     // full SHA
  short: string    // abbreviated SHA
  subject: string  // first line of the message
  author: string
  date: string     // relative, e.g. "2 hours ago"
}

export type GitLog = { ok: true; commits: GitCommit[] } | { ok: false; error: string }

export type GitBranches =
  | { ok: true; current: string; branches: string[] }  // `current` is '' when detached
  | { ok: false; error: string }
