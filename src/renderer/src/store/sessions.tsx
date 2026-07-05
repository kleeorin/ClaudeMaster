import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react'
import type { SessionInfo, SessionState, SavedSession, RemoteConfig, PermissionMode, SetModeResult } from '../../../shared/types'
import { makeRemotePath, parseTarget } from '../../../shared/remotePath'
import { playChime } from '../lib/chime'
import { useNotebooks } from './notebooks'

// Is `path` inside (or equal to) the `root` directory subtree?
const isUnder = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

// A subsession's name = a 1–2 word summary of its duty, i.e. its agent role
// (kebab id → Title Case, e.g. "reviewer" → "Reviewer", "code-reviewer" →
// "Code Reviewer"). A plain `general` subsession has no special duty, so it falls
// back to the folder name.
const dutyName = (agentId: string | undefined, fallback: string): string =>
  agentId && agentId !== 'general'
    ? agentId.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : fallback

// Flatten the live sessions into the persisted shape. Parent links survive as an
// index into this array (ids are regenerated on restore); a subsession always
// follows its parent, so the index is always already known on the way back in.
// Async because it fetches each session's claude session id (for --resume on
// restore) from the main process.
async function serialize(sessions: SessionInfo[], panes: Record<string, string[]>): Promise<SavedSession[]> {
  // Don't persist a failed-to-start session — restoring it would just re-run the
  // same broken command and fail again. parentIndex is resolved against this same
  // filtered list so the saved indices stay consistent on restore.
  const live = sessions.filter((s) => s.state !== 'exited')
  const claudeIds = await Promise.all(live.map((s) => window.api.session.claudeId(s.id)))
  return live.map((s, i) => ({
    name: s.name,
    cwd: s.cwd,
    rootDir: s.rootDir,
    parentIndex: s.parentId ? live.findIndex((p) => p.id === s.parentId) : undefined,
    paneCount: panes[s.id]?.length ?? 0,
    remoteId: s.remoteId,
    agentId: s.agentId,
    model: s.model,
    permissionMode: s.permissionMode,
    claudeSessionId: claudeIds[i],
  }))
}

interface State {
  sessions: SessionInfo[]
  activeId: string | null
  panes: Record<string, string[]>          // sessionId → stacked paneIds (persists when hidden)
  paneVisible: Record<string, boolean>     // sessionId → strip shown
  attention: Record<string, true>          // sessionIds that need you (cleared on view)
}

type Action =
  | { type: 'LOAD'; sessions: SessionInfo[] }
  | { type: 'ADD'; session: SessionInfo; paneIds?: string[] }
  | { type: 'REMOVE'; id: string }
  | { type: 'STATE_CHANGE'; id: string; state: SessionState }
  | { type: 'SET_MODE'; id: string; mode: PermissionMode }
  | { type: 'EXITED'; id: string; error: string }
  | { type: 'SET_ACTIVE'; id: string }
  | { type: 'ADD_ATTENTION'; id: string }
  | { type: 'ADD_PANE'; sessionId: string; paneId: string; afterPaneId?: string }
  | { type: 'SHOW_PANE'; sessionId: string }
  | { type: 'HIDE_PANE'; sessionId: string }
  | { type: 'REMOVE_PANE'; paneId: string }

// Drop a key from a Record without mutating the original.
function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'LOAD':
      return { ...state, sessions: action.sessions }
    case 'ADD': {
      const hasPanes = !!action.paneIds?.length
      const newPanes = hasPanes
        ? { ...state.panes, [action.session.id]: action.paneIds! }
        : state.panes
      const newPaneVisible = hasPanes
        ? { ...(state.paneVisible ?? {}), [action.session.id]: true }
        : (state.paneVisible ?? {})
      return {
        ...state,
        sessions: [...state.sessions, action.session],
        activeId: action.session.id,
        panes: newPanes,
        paneVisible: newPaneVisible,
      }
    }
    case 'REMOVE': {
      const sessions = state.sessions.filter((s) => s.id !== action.id)
      const activeId =
        state.activeId === action.id ? (sessions[0]?.id ?? null) : state.activeId
      const panes = { ...state.panes }
      delete panes[action.id]
      const paneVisible = { ...(state.paneVisible ?? {}) }
      delete paneVisible[action.id]
      return { ...state, sessions, activeId, panes, paneVisible, attention: omit(state.attention, action.id) }
    }
    case 'STATE_CHANGE':
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          // Leaving 'exited' (e.g. a successful relaunch) clears the stored error.
          s.id === action.id
            ? { ...s, state: action.state, exitError: action.state === 'exited' ? s.exitError : undefined }
            : s
        ),
      }
    case 'SET_MODE':
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.id === action.id ? { ...s, permissionMode: action.mode } : s)),
      }
    case 'EXITED':
      // Keep the row; mark it failed and stash the reason for the banner/tooltip.
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, state: 'exited', exitError: action.error } : s
        ),
      }
    case 'SET_ACTIVE':
      // Looking at a session clears its pending attention.
      return { ...state, activeId: action.id, attention: omit(state.attention, action.id) }
    case 'ADD_ATTENTION':
      return state.attention[action.id]
        ? state
        : { ...state, attention: { ...state.attention, [action.id]: true } }
    case 'ADD_PANE': {
      const list = state.panes[action.sessionId] ?? []
      const at = action.afterPaneId ? list.indexOf(action.afterPaneId) : -1
      const next = at >= 0
        ? [...list.slice(0, at + 1), action.paneId, ...list.slice(at + 1)]
        : [...list, action.paneId]
      return {
        ...state,
        panes: { ...state.panes, [action.sessionId]: next },
        paneVisible: { ...(state.paneVisible ?? {}), [action.sessionId]: true },
      }
    }
    case 'SHOW_PANE':
      return { ...state, paneVisible: { ...(state.paneVisible ?? {}), [action.sessionId]: true } }
    case 'HIDE_PANE': {
      const paneVisible = { ...(state.paneVisible ?? {}) }
      delete paneVisible[action.sessionId]
      return { ...state, paneVisible }
    }
    case 'REMOVE_PANE': {
      const sessionId = Object.entries(state.panes).find(([, ids]) => ids.includes(action.paneId))?.[0]
      if (!sessionId) return state
      const remaining = state.panes[sessionId].filter((id) => id !== action.paneId)
      const panes = { ...state.panes }
      const paneVisible = { ...(state.paneVisible ?? {}) }
      if (remaining.length === 0) {
        // Last terminal in the strip closed — drop the strip entirely.
        delete panes[sessionId]
        delete paneVisible[sessionId]
      } else {
        panes[sessionId] = remaining
      }
      return { ...state, panes, paneVisible }
    }
    default:
      return state
  }
}

interface ContextValue extends State {
  createSession: (agentId?: string, model?: string) => Promise<void>
  createRemoteSession: (remote: RemoteConfig, dir: string, agentId?: string, model?: string) => Promise<void>
  relaunchSession: (id: string) => Promise<void>
  addSubsession: (parentId: string, dir?: string, agentId?: string, model?: string) => Promise<void>
  // App-control (MCP) spawners: no dialog, dir passed explicitly, return the new
  // id so the caller can orchestrate (seed a prompt via the chat store, …).
  spawnSubsession: (parentId: string, dir?: string, agentId?: string, model?: string) => Promise<string | undefined>
  createSessionAt: (dir: string, agentId?: string, model?: string) => Promise<string | undefined>
  closeSession: (id: string) => Promise<void>
  // Set a session's permission mode. Persists to the store (so autosave/restore
  // keep it) and asks main to apply it live or on next launch.
  setSessionMode: (id: string, mode: PermissionMode) => Promise<SetModeResult>
  setActive: (id: string) => void
  openPane: (sessionId: string) => Promise<void>
  addPane: (sessionId: string, afterPaneId?: string) => Promise<void>
  removePane: (paneId: string) => Promise<void>
  closePane: (sessionId: string) => void
  paneIdsFor: (sessionId: string) => string[]        // all panes, regardless of visibility
  visiblePanesFor: (sessionId: string) => string[]   // panes when the strip is shown, else []
  // Attention notification settings (persisted).
  notifyEnabled: boolean
  soundEnabled: boolean
  setNotifyEnabled: (v: boolean) => void
  setSoundEnabled: (v: boolean) => void
}

const SessionContext = createContext<ContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    sessions: [], activeId: null, panes: {}, paneVisible: {}, attention: {},
  })

  // Keep a ref so event handlers always see fresh state
  const stateRef = useRef(state)
  stateRef.current = state

  // Notebook kernels are torn down when their owning session closes.
  const { notebooks, shutdownKernel } = useNotebooks()
  const notebooksRef = useRef(notebooks)
  notebooksRef.current = notebooks

  // Notification preferences, persisted across launches.
  const [notifyEnabled, setNotifyEnabledState] = useState(() => localStorage.getItem('cm.notify') !== '0')
  const [soundEnabled, setSoundEnabledState] = useState(() => localStorage.getItem('cm.sound') !== '0')
  const notifyRef = useRef(notifyEnabled); notifyRef.current = notifyEnabled
  const soundRef = useRef(soundEnabled); soundRef.current = soundEnabled

  const setNotifyEnabled = useCallback((v: boolean) => {
    localStorage.setItem('cm.notify', v ? '1' : '0')
    setNotifyEnabledState(v)
    // Ask once when first enabling, so the OS prompt happens on a click.
    if (v && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [])
  const setSoundEnabled = useCallback((v: boolean) => {
    localStorage.setItem('cm.sound', v ? '1' : '0')
    setSoundEnabledState(v)
    if (v) playChime('done')  // audible confirmation + unlocks the AudioContext
  }, [])

  // Fire desktop notification + chime for a session that needs you. Clicking the
  // notification brings the window forward and focuses that session.
  const notify = useCallback((id: string, name: string, st: SessionState) => {
    const waiting = st === 'waiting'
    if (soundRef.current) playChime(waiting ? 'waiting' : 'done')
    if (!notifyRef.current || !('Notification' in window)) return
    const fire = () => {
      const n = new Notification(`Claude · ${name}`, {
        body: waiting ? 'Needs your input (permission prompt)' : 'Finished — your turn',
        tag: id,        // collapse repeats from the same session
        silent: true,   // we play our own chime
      })
      n.onclick = () => { void window.api.app.focus(); dispatch({ type: 'SET_ACTIVE', id }) }
    }
    if (Notification.permission === 'granted') fire()
    else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((p) => { if (p === 'granted') fire() })
    }
  }, [])

  // Mirror the attention count onto the OS (dock/taskbar badge + frame flash).
  useEffect(() => {
    void window.api.app.setAttention(Object.keys(state.attention).length)
  }, [state.attention])

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      const running = await window.api.session.list()
      if (cancelled) return
      if (running.length > 0) {
        // Hot-reload: sessions already exist in the main process
        dispatch({ type: 'LOAD', sessions: running })
      } else {
        // Fresh start: restore previously saved sessions
        const saved = await window.api.session.loadSaved()
        if (cancelled) return
        const idByIndex: string[] = []  // map a saved index → its new live id (for parent links)
        for (let i = 0; i < saved.length; i++) {
          const s = saved[i]
          const rootDir = s.rootDir ?? s.cwd
          const parentId = s.parentIndex != null ? idByIndex[s.parentIndex] : undefined
          // Restore the session, resuming its claude conversation. Native mode
          // resumes by id (--resume <claudeSessionId>) when we have one; without an
          // id (older saves) it starts fresh so a missing id can't fast-fail. TUI
          // mode has no resume-by-id, so it --continue's the cwd's latest convo
          // (resume flag true, id ignored by the pty backend).
          const resume = window.api.frontend === 'tui' ? true : !!s.claudeSessionId
          const id = await window.api.session.create(
            s.name, s.cwd, rootDir, parentId, resume, s.claudeSessionId, s.agentId, s.model, s.permissionMode,
          )
          if (cancelled) return
          idByIndex[i] = id
          // Older saves stored a single `hasPane` flag; newer ones a `paneCount`.
          const count = s.paneCount ?? (s.hasPane ? 1 : 0)
          const paneIds: string[] = []
          for (let p = 0; p < count; p++) {
            paneIds.push(await window.api.pane.create(rootDir))
            if (cancelled) return
          }
          dispatch({
            type: 'ADD',
            session: { id, name: s.name, cwd: s.cwd, rootDir, parentId, remoteId: s.remoteId, agentId: s.agentId, model: s.model, permissionMode: s.permissionMode, state: 'idle' },
            paneIds,
          })
        }
      }
    }
    init()

    const offState = window.api.on.stateChange((id, raw) => {
      const next = raw as SessionState
      const prev = stateRef.current.sessions.find((s) => s.id === id)
      dispatch({ type: 'STATE_CHANGE', id, state: next })
      if (!prev) return

      // The two transitions that mean "this session now wants you": a permission
      // prompt appeared, or a turn just finished (running → idle).
      const wantsYou =
        (next === 'waiting' && prev.state !== 'waiting') ||
        (next === 'idle' && prev.state === 'running')
      if (!wantsYou) return

      const isActive = stateRef.current.activeId === id
      // Badge only backgrounded sessions; the active one resolves when you look.
      if (!isActive) dispatch({ type: 'ADD_ATTENTION', id })
      // Notify/sound unless you're already watching this exact session in a
      // focused window.
      if (!isActive || !document.hasFocus()) notify(id, prev.name, next)
    })
    const offExit = window.api.on.exit((id, failedFast, error) => {
      // A session that died at startup stays put with its error visible; a normal
      // exit (you finished the session) is removed as before.
      if (failedFast) {
        dispatch({ type: 'EXITED', id, error })
        // Flag it for attention unless you're already looking at it.
        if (stateRef.current.activeId !== id) dispatch({ type: 'ADD_ATTENTION', id })
      } else {
        dispatch({ type: 'REMOVE', id })
      }
    })
    const offPaneExit = window.api.on.paneExit((paneId) => {
      dispatch({ type: 'REMOVE_PANE', paneId })
    })
    const offRequestSave = window.api.on.requestSave(async () => {
      const saved = await serialize(stateRef.current.sessions, stateRef.current.panes)
      await window.api.session.saveState(saved)
    })

    return () => {
      cancelled = true
      offState()
      offExit()
      offPaneExit()
      offRequestSave()
    }
  }, [])

  const createSession = useCallback(async (agentId?: string, model?: string) => {
    const cwd = await window.api.dialog.openDir()
    if (!cwd) return
    const name = cwd.split('/').pop() || 'Session'
    const id = await window.api.session.create(name, cwd, cwd, undefined, false, undefined, agentId, model)
    dispatch({ type: 'ADD', session: { id, name, cwd, rootDir: cwd, agentId, model, state: 'idle' } })
  }, [])

  // Start a session on a remote host. `dir` is a plain absolute path on that host;
  // we encode it as remote://id/dir so every downstream fs/git call routes over
  // ssh to the right box (see shared/remotePath.ts).
  const createRemoteSession = useCallback(async (remote: RemoteConfig, dir: string, agentId?: string, model?: string) => {
    const cwd = makeRemotePath(remote.id, dir)
    const name = dir.split('/').filter(Boolean).pop() || remote.label
    const id = await window.api.session.create(name, cwd, cwd, undefined, false, undefined, agentId, model)
    dispatch({ type: 'ADD', session: { id, name, cwd, rootDir: cwd, remoteId: remote.id, agentId, model, state: 'idle' } })
  }, [])

  // A subsession runs its own Claude in the parent's directory, but scopes its
  // terminal pane and file browser to a chosen subdirectory of that directory.
  // For a remote parent the local dir dialog can't browse the remote, so the
  // caller (Sidebar) supplies `dir` — a plain path on the remote — via the remote
  // folder picker; local parents fall back to the native dialog.
  const addSubsession = useCallback(async (parentId: string, dir?: string, agentId?: string, model?: string) => {
    const parent = stateRef.current.sessions.find((s) => s.id === parentId)
    if (!parent) return
    let picked = dir
    if (!picked) {
      if (parent.remoteId) return  // remote needs an explicit dir from the picker
      picked = (await window.api.dialog.openDir(parent.cwd)) ?? undefined
      if (!picked) return
    }
    const rootDir = parent.remoteId ? makeRemotePath(parent.remoteId, picked) : picked
    const name = dutyName(agentId, picked.split('/').filter(Boolean).pop() || 'Subsession')
    const id = await window.api.session.create(name, parent.cwd, rootDir, parentId, false, undefined, agentId, model)
    dispatch({
      type: 'ADD',
      session: { id, name, cwd: parent.cwd, rootDir, parentId, remoteId: parent.remoteId, agentId, model, state: 'idle' },
    })
  }, [])

  // Spawn a subsession from app-control (no dialog). Defaults to the parent's OWN
  // folder — the same-folder multi-agent case — so several Claude backends run in
  // one directory; pass `dir` (a plain path on the parent's host) to scope it to a
  // subdirectory instead. Optionally seeds an initial prompt. Returns the new id.
  const spawnSubsession = useCallback(async (parentId: string, dir?: string, agentId?: string, model?: string): Promise<string | undefined> => {
    const parent = stateRef.current.sessions.find((s) => s.id === parentId)
    if (!parent) return undefined
    const picked = dir ?? parseTarget(parent.cwd).path  // plain path; default = same folder
    const rootDir = parent.remoteId ? makeRemotePath(parent.remoteId, picked) : picked
    const name = dutyName(agentId, picked.split('/').filter(Boolean).pop() || 'Subsession')
    const id = await window.api.session.create(name, parent.cwd, rootDir, parentId, false, undefined, agentId, model)
    dispatch({
      type: 'ADD',
      session: { id, name, cwd: parent.cwd, rootDir, parentId, remoteId: parent.remoteId, agentId, model, state: 'idle' },
    })
    return id
  }, [])

  // Open a new top-level session in `dir` from app-control (no dialog). Local only
  // (dir is a plain absolute path); remote creation stays interactive for now.
  const createSessionAt = useCallback(async (dir: string, agentId?: string, model?: string): Promise<string | undefined> => {
    const name = dir.split('/').filter(Boolean).pop() || 'Session'
    const id = await window.api.session.create(name, dir, dir, undefined, false, undefined, agentId, model)
    dispatch({ type: 'ADD', session: { id, name, cwd: dir, rootDir: dir, agentId, model, state: 'idle' } })
    return id
  }, [])

  const setSessionMode = useCallback(async (id: string, mode: PermissionMode): Promise<SetModeResult> => {
    // Optimistically store the mode (autosave/restore keep it); main applies it
    // live if the CLI supports it, else on the next launch.
    dispatch({ type: 'SET_MODE', id, mode })
    return window.api.perms.setMode(id, mode)
  }, [])

  const closeSession = useCallback(async (id: string) => {
    // Closing a session also closes any subsessions hanging off it.
    const closing = stateRef.current.sessions.filter((s) => s.id === id || s.parentId === id)
    const toClose = closing.map((s) => s.id)
    const closedIds = new Set(toClose)
    const survivors = stateRef.current.sessions.filter((s) => !closedIds.has(s.id))

    // Shut down kernels for notebooks living under a closing session's root. A
    // surviving session only spares the kernel if it owns the notebook at least
    // as specifically (a deeper-or-equal rootDir) — so closing a subsession kills
    // the kernels in its subdir even though the parent still covers that subtree,
    // while a sibling session on the same (or a nested) folder keeps its kernel.
    for (const nb of Object.values(notebooksRef.current)) {
      if (!nb.kernelStatus || nb.kernelStatus === 'dead') continue
      const closingRoots = closing.filter((s) => isUnder(nb.path, s.rootDir)).map((s) => s.rootDir)
      if (closingRoots.length === 0) continue
      const closingDepth = Math.max(...closingRoots.map((r) => r.length))
      const sparedBySurvivor = survivors.some(
        (s) => isUnder(nb.path, s.rootDir) && s.rootDir.length >= closingDepth,
      )
      if (sparedBySurvivor) continue
      void shutdownKernel(nb.path)
    }

    for (const sid of toClose) {
      for (const paneId of stateRef.current.panes[sid] ?? []) {
        await window.api.pane.destroy(paneId)
      }
      await window.api.session.destroy(sid)
      dispatch({ type: 'REMOVE', id: sid })
    }

    // Auto-save remaining sessions so state survives crashes and hot-reloads
    const closed = new Set(toClose)
    const remaining = stateRef.current.sessions.filter((s) => !closed.has(s.id))
    await window.api.session.autosave(await serialize(remaining, stateRef.current.panes))
  }, [shutdownKernel])

  const setActive = useCallback((id: string) => {
    dispatch({ type: 'SET_ACTIVE', id })
  }, [])

  // Retry launching Claude in an existing (exited) session — e.g. after you've
  // installed claude on the remote. The main process re-emits the state, which
  // clears the 'exited' status via STATE_CHANGE.
  const relaunchSession = useCallback(async (id: string) => {
    await window.api.session.relaunch(id)
  }, [])

  // Spawn a new terminal in this session's stack. `afterPaneId` inserts the new
  // terminal directly below the given one (the "+" on a specific terminal);
  // omit it to append at the bottom.
  const addPane = useCallback(async (sessionId: string, afterPaneId?: string) => {
    const session = stateRef.current.sessions.find((s) => s.id === sessionId)
    if (!session) return
    const paneId = await window.api.pane.create(session.rootDir)
    dispatch({ type: 'ADD_PANE', sessionId, paneId, afterPaneId })
  }, [])

  // Toolbar toggle: reveal an existing (hidden) stack, or open the first terminal.
  const openPane = useCallback(async (sessionId: string) => {
    if (stateRef.current.panes?.[sessionId]?.length) {
      dispatch({ type: 'SHOW_PANE', sessionId })
      return
    }
    await addPane(sessionId)
  }, [addPane])

  // Close one terminal in the stack (the "×" on a terminal). Killing the pty
  // also fires paneExit, but we update optimistically so the UI is immediate.
  const removePane = useCallback(async (paneId: string) => {
    dispatch({ type: 'REMOVE_PANE', paneId })
    await window.api.pane.destroy(paneId)
  }, [])

  const closePane = useCallback((sessionId: string) => {
    dispatch({ type: 'HIDE_PANE', sessionId })
  }, [])

  const paneIdsFor = useCallback((sessionId: string): string[] =>
    state.panes?.[sessionId] ?? [],
  [state.panes])

  const visiblePanesFor = useCallback((sessionId: string): string[] =>
    state.paneVisible?.[sessionId] ? (state.panes?.[sessionId] ?? []) : [],
  [state.panes, state.paneVisible])

  return (
    <SessionContext.Provider value={{
      ...state, createSession, createRemoteSession, relaunchSession, addSubsession, spawnSubsession, createSessionAt, closeSession, setSessionMode, setActive,
      openPane, addPane, removePane, closePane, paneIdsFor, visiblePanesFor,
      notifyEnabled, soundEnabled, setNotifyEnabled, setSoundEnabled,
    }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSessions(): ContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSessions must be used within SessionProvider')
  return ctx
}
