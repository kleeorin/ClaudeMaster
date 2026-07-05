import { createContext, useContext, useReducer, useCallback, useEffect, type ReactNode } from 'react'

// Per-session open state for the Permission Control Center panel — a right-side
// dock, twin of the git panel (see gitPanel.tsx). Kept separate so it toggles
// independently and can sit beside the file browser / git panel.
type State = Record<string, boolean>

type Action =
  | { type: 'SET'; sessionId: string; open: boolean }
  | { type: 'DESTROY'; sessionId: string }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET':
      return { ...state, [action.sessionId]: action.open }
    case 'DESTROY': {
      const next = { ...state }
      delete next[action.sessionId]
      return next
    }
    default:
      return state
  }
}

interface ContextValue {
  open: State
  openPerms: (sessionId: string) => void
  closePerms: (sessionId: string) => void
}

const PermsPanelContext = createContext<ContextValue | null>(null)

export function PermsPanelProvider({ children }: { children: ReactNode }) {
  const [open, dispatch] = useReducer(reducer, {})

  useEffect(() => {
    // Keep the panel for a session that only lost Claude (fast failure); close it
    // on a real session exit.
    return window.api.on.exit((id, failedFast) => { if (!failedFast) dispatch({ type: 'DESTROY', sessionId: id }) })
  }, [])

  const openPerms = useCallback((sessionId: string) => dispatch({ type: 'SET', sessionId, open: true }), [])
  const closePerms = useCallback((sessionId: string) => dispatch({ type: 'SET', sessionId, open: false }), [])

  return (
    <PermsPanelContext.Provider value={{ open, openPerms, closePerms }}>
      {children}
    </PermsPanelContext.Provider>
  )
}

export function usePermsPanel(): ContextValue {
  const ctx = useContext(PermsPanelContext)
  if (!ctx) throw new Error('usePermsPanel must be used within PermsPanelProvider')
  return ctx
}
