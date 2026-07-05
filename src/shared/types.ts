// 'exited' is a renderer-only terminal state: the process died so quickly after
// launch that it never really started (e.g. `claude: command not found` on a
// remote). We keep the row and show the error instead of silently removing it.
export type SessionState = 'idle' | 'running' | 'waiting' | 'exited'

export interface SessionInfo {
  id: string
  name: string
  cwd: string        // where Claude runs (a subsession shares its parent's cwd)
  rootDir: string    // root for the terminal pane + file browser (a subdir for subsessions)
  parentId?: string  // set on subsessions; points at the owning session
  remoteId?: string  // set when the session runs on a remote host (see RemoteConfig)
  agentId?: string   // the role this session runs as (see main/agents.ts); undefined = 'general'
  model?: string     // per-session model override; undefined = the role's model, else account default
  permissionMode?: PermissionMode  // --permission-mode; undefined/'default' = ordinary prompting
  state: SessionState
  exitError?: string // last output when state === 'exited' (why it failed to start)
}

export interface SavedSession {
  name: string
  cwd: string
  rootDir?: string       // defaults to cwd when absent (older saves)
  parentIndex?: number   // index of the parent within the saved array (subsessions only)
  paneCount?: number     // number of stacked terminal panes to restore
  hasPane?: boolean      // legacy: single pane (older saves); read as paneCount 1
  remoteId?: string      // remote host this session runs on (local when absent)
  agentId?: string       // the role this session runs as (re-applied on restore)
  model?: string         // per-session model override (re-applied on restore)
  permissionMode?: PermissionMode  // per-session mode (re-applied on restore)
  claudeSessionId?: string // claude's own --session-id, for --resume on restore
}

// --- Native chat backend (stream-json) ---------------------------------------
// See PROTOCOL-stream-json.md for the pinned wire contract (CLI 2.1.198).

// A parsed stream-json event, forwarded to the renderer to build the transcript.
// We keep it loose (the raw object) plus a couple of synthetic kinds; the store
// discriminates on `type`. Notable types: system/init, system/thinking_tokens,
// rate_limit_event, stream_event, assistant, user, result, and 'stderr' (ours).
export type ClaudeEvent = { type: string; [k: string]: unknown }

// A can_use_tool prompt surfaced to the renderer for a native permission UI.
export interface PermissionRequest {
  requestId: string
  toolName: string
  displayName: string
  input: Record<string, unknown>
  toolUseId: string
  description?: string
  suggestions: unknown[]   // permission_suggestions: setMode / addRules options
}

export type PermissionDecision =
  // updatedPermissions echoes the request's permission_suggestions (setMode /
  // addRules) to implement "allow always"; the CLI applies + persists them per
  // each suggestion's `destination` (session vs local/user/project settings).
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message?: string }

// --- Permission Control Center (see HANDOVER-permissions.md) ------------------
// A session's permission mode — Claude's `--permission-mode` launch flag and the
// `defaultMode` key in its settings files.
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

// Which of Claude's settings files a rule/mode comes from. Precedence low→high:
// user < project < local. (Enterprise policy is out of scope for v1.)
export type PermissionScope = 'user' | 'project' | 'local'

export type PermissionAction = 'allow' | 'deny' | 'ask'

// One allow/deny/ask entry (e.g. "Bash(npm run test:*)"), tagged with the file it
// came from so the UI can group + attribute it.
export interface PermissionRule {
  action: PermissionAction
  value: string
  scope: PermissionScope
}

// One of Claude's three settings files, as located for a session.
export interface PermissionFile {
  scope: PermissionScope
  path: string        // absolute (remote-encoded for remote sessions)
  exists: boolean
  unreadable?: boolean  // present but not valid JSON
}

// The merged permission picture for a session, read from Claude's OWN settings
// files — read-only visibility (P1). `mode` is the effective defaultMode (the
// highest-precedence file that sets one); the per-session launch override is P2.
export interface EffectivePermissions {
  cwd: string
  mode: PermissionMode          // effective defaultMode across the files ('default' if none set)
  modeScope?: PermissionScope   // which file set it (absent when defaulted)
  rules: PermissionRule[]       // every allow/deny/ask entry, tagged by scope
  files: PermissionFile[]       // the three settings files + whether each exists
  notebookFunnel: string[]      // read-only "system" denies (NOTEBOOK_DENY)
  agent?: {                     // read-only agent tool scoping, surfaced for clarity
    id: string
    name: string
    allowedTools?: string[]
    disallowedTools?: string[]
  }
  error?: string
}

// Outcome of a perms:setMode request. `live` = switched in the running session via
// the control protocol; `relaunched` = the session's engine was restarted (resume-
// preserving) to apply the flag now; `restart` = stored, applies on the next launch
// (TUI, or a busy session we didn't interrupt); `error` = couldn't apply.
export type SetModeResult =
  | { applied: 'live'; mode: PermissionMode }
  | { applied: 'relaunched'; mode: PermissionMode }
  | { applied: 'restart'; mode: PermissionMode; reason?: string }
  | { applied: 'error'; error: string }

// A resumable past conversation, for the native /resume picker (see conversations.ts).
export interface ConversationMeta {
  id: string          // claude session id (= transcript filename)
  mtimeMs: number     // last-modified, for ordering + "N ago" display
  title: string       // ai-generated title, else first user prompt
  lastPrompt: string  // subtitle preview
  turns: number       // user-turn count
}

// --- Remotes -----------------------------------------------------------------

// A saved SSH remote. `host` is anything ssh accepts as a destination
// (user@host, or a Host alias from ~/.ssh/config). `sshOptions` are extra argv
// passed before the destination (e.g. ['-p','2222'], ['-i','~/key'], ['-J','jump']).
export interface RemoteConfig {
  id: string
  label: string
  host: string
  defaultDir: string
  sshOptions?: string[]
}

// A top-level `Host` alias discovered in ~/.ssh/config, offered as a one-click
// quick-add in the remote picker. hostName/user are shown for context only — ssh
// resolves the real connection details from the config itself.
export interface SshConfigHost {
  alias: string
  hostName?: string
  user?: string
}

// cwd/rootDir strings for remote sessions are encoded as `remote://<id>/<abs>`
// (see main/remotePath.ts); this keeps the whole fs/git IPC surface path-only.
export type RemoteTest = { ok: true } | { ok: false; error: string }

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
