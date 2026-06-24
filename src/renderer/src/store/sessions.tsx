import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react'
import type { SessionInfo, SessionState } from '../../../shared/types'
import { getScrollback } from '../lib/scrollbackStore'

interface State {
  sessions: SessionInfo[]
  activeId: string | null
  panes: Record<string, string>            // sessionId → paneId (persists when hidden)
  paneVisible: Record<string, boolean>     // sessionId → shown
  savedScrollback: Record<string, string>  // sessionId → initial scrollback
  savedPaneScrollback: Record<string, string> // sessionId → initial pane scrollback
}

type Action =
  | { type: 'LOAD'; sessions: SessionInfo[] }
  | { type: 'ADD'; session: SessionInfo; scrollback?: string; paneId?: string; paneScrollback?: string }
  | { type: 'REMOVE'; id: string }
  | { type: 'STATE_CHANGE'; id: string; state: SessionState }
  | { type: 'SET_ACTIVE'; id: string }
  | { type: 'SET_PANE'; sessionId: string; paneId: string }
  | { type: 'SHOW_PANE'; sessionId: string }
  | { type: 'HIDE_PANE'; sessionId: string }
  | { type: 'CLEAR_PANE'; paneId: string }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'LOAD':
      return { ...state, sessions: action.sessions }
    case 'ADD': {
      const newPanes = action.paneId
        ? { ...state.panes, [action.session.id]: action.paneId }
        : state.panes
      const newPaneVisible = action.paneId
        ? { ...(state.paneVisible ?? {}), [action.session.id]: true }
        : (state.paneVisible ?? {})
      const newSavedPaneScrollback = action.paneScrollback !== undefined
        ? { ...(state.savedPaneScrollback ?? {}), [action.session.id]: action.paneScrollback }
        : (state.savedPaneScrollback ?? {})
      return {
        ...state,
        sessions: [...state.sessions, action.session],
        activeId: action.session.id,
        panes: newPanes,
        paneVisible: newPaneVisible,
        savedScrollback: {
          ...(state.savedScrollback ?? {}),
          [action.session.id]: action.scrollback ?? '',
        },
        savedPaneScrollback: newSavedPaneScrollback,
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
      const savedScrollback = { ...(state.savedScrollback ?? {}) }
      delete savedScrollback[action.id]
      const savedPaneScrollback = { ...(state.savedPaneScrollback ?? {}) }
      delete savedPaneScrollback[action.id]
      return { sessions, activeId, panes, paneVisible, savedScrollback, savedPaneScrollback }
    }
    case 'STATE_CHANGE':
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, state: action.state } : s
        ),
      }
    case 'SET_ACTIVE':
      return { ...state, activeId: action.id }
    case 'SET_PANE':
      return {
        ...state,
        panes: { ...state.panes, [action.sessionId]: action.paneId },
        paneVisible: { ...(state.paneVisible ?? {}), [action.sessionId]: true },
      }
    case 'SHOW_PANE':
      return { ...state, paneVisible: { ...(state.paneVisible ?? {}), [action.sessionId]: true } }
    case 'HIDE_PANE': {
      const paneVisible = { ...(state.paneVisible ?? {}) }
      delete paneVisible[action.sessionId]
      return { ...state, paneVisible }
    }
    case 'CLEAR_PANE': {
      const sessionId = Object.entries(state.panes).find(([, id]) => id === action.paneId)?.[0]
      if (!sessionId) return state
      const panes = { ...state.panes }
      delete panes[sessionId]
      const paneVisible = { ...(state.paneVisible ?? {}) }
      delete paneVisible[sessionId]
      return { ...state, panes, paneVisible }
    }
    default:
      return state
  }
}

interface ContextValue extends State {
  createSession: () => Promise<void>
  closeSession: (id: string) => Promise<void>
  setActive: (id: string) => void
  openPane: (sessionId: string) => Promise<void>
  closePane: (sessionId: string) => void
  paneFor: (sessionId: string) => string | null
  paneIdFor: (sessionId: string) => string | null
}

const SessionContext = createContext<ContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    sessions: [], activeId: null, panes: {}, paneVisible: {}, savedScrollback: {}, savedPaneScrollback: {},
  })

  // Keep a ref so event handlers always see fresh state
  const stateRef = useRef(state)
  stateRef.current = state

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
        for (const s of saved) {
          const id = await window.api.session.create(s.name, s.cwd)
          if (cancelled) return
          let paneId: string | undefined
          if (s.paneScrollback !== undefined) {
            paneId = await window.api.pane.create(s.cwd)
            if (cancelled) return
          }
          dispatch({
            type: 'ADD',
            session: { id, name: s.name, cwd: s.cwd, state: 'idle' },
            scrollback: s.scrollback,
            paneId,
            paneScrollback: s.paneScrollback,
          })
        }
      }
    }
    init()

    const offState = window.api.on.stateChange((id, state) => {
      dispatch({ type: 'STATE_CHANGE', id, state: state as SessionState })
    })
    const offExit = window.api.on.exit((id) => {
      dispatch({ type: 'REMOVE', id })
    })
    const offPaneExit = window.api.on.paneExit((paneId) => {
      dispatch({ type: 'CLEAR_PANE', paneId })
    })
    const offRequestSave = window.api.on.requestSave(async () => {
      const saved = stateRef.current.sessions.map((s) => ({
        name: s.name,
        cwd: s.cwd,
        scrollback: getScrollback(s.id),
        paneScrollback: stateRef.current.panes[s.id]
          ? getScrollback(stateRef.current.panes[s.id])
          : undefined,
      }))
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

  const createSession = useCallback(async () => {
    const cwd = await window.api.dialog.openDir()
    if (!cwd) return
    const name = cwd.split('/').pop() || 'Session'
    const id = await window.api.session.create(name, cwd)
    dispatch({ type: 'ADD', session: { id, name, cwd, state: 'idle' } })
  }, [])

  const closeSession = useCallback(async (id: string) => {
    const paneId = stateRef.current.panes[id]
    if (paneId) await window.api.pane.destroy(paneId)
    await window.api.session.destroy(id)
    dispatch({ type: 'REMOVE', id })

    // Auto-save remaining sessions so state survives crashes and hot-reloads
    const remaining = stateRef.current.sessions
      .filter((s) => s.id !== id)
      .map((s) => ({
        name: s.name,
        cwd: s.cwd,
        scrollback: getScrollback(s.id),
        paneScrollback: stateRef.current.panes[s.id]
          ? getScrollback(stateRef.current.panes[s.id])
          : undefined,
      }))
    await window.api.session.autosave(remaining)
  }, [])

  const setActive = useCallback((id: string) => {
    dispatch({ type: 'SET_ACTIVE', id })
  }, [])

  const openPane = useCallback(async (sessionId: string) => {
    if (stateRef.current.panes?.[sessionId]) {
      dispatch({ type: 'SHOW_PANE', sessionId })
      return
    }
    const session = stateRef.current.sessions.find((s) => s.id === sessionId)
    if (!session) return
    const paneId = await window.api.pane.create(session.cwd)
    dispatch({ type: 'SET_PANE', sessionId, paneId })
  }, [])

  const closePane = useCallback((sessionId: string) => {
    dispatch({ type: 'HIDE_PANE', sessionId })
  }, [])

  const paneFor = useCallback((sessionId: string): string | null =>
    state.paneVisible?.[sessionId] ? (state.panes?.[sessionId] ?? null) : null,
  [state.panes, state.paneVisible])

  const paneIdFor = useCallback((sessionId: string): string | null =>
    state.panes?.[sessionId] ?? null,
  [state.panes])

  return (
    <SessionContext.Provider value={{
      ...state, createSession, closeSession, setActive,
      openPane, closePane, paneFor, paneIdFor,
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
