import { createContext, useContext, useReducer, useCallback, useEffect, type ReactNode } from 'react'

// Per-session open state for the git panel — a right-side dock that mirrors the
// file browser. Kept separate from the file-browser store so the two panels
// toggle independently and can be shown side by side.
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
  openGit: (sessionId: string) => void
  closeGit: (sessionId: string) => void
}

const GitPanelContext = createContext<ContextValue | null>(null)

export function GitPanelProvider({ children }: { children: ReactNode }) {
  const [open, dispatch] = useReducer(reducer, {})

  useEffect(() => {
    // Keep the panel for a session that only lost Claude (fast failure); close it
    // on a real session exit.
    return window.api.on.exit((id, failedFast) => { if (!failedFast) dispatch({ type: 'DESTROY', sessionId: id }) })
  }, [])

  const openGit = useCallback((sessionId: string) => dispatch({ type: 'SET', sessionId, open: true }), [])
  const closeGit = useCallback((sessionId: string) => dispatch({ type: 'SET', sessionId, open: false }), [])

  return (
    <GitPanelContext.Provider value={{ open, openGit, closeGit }}>
      {children}
    </GitPanelContext.Provider>
  )
}

export function useGitPanel(): ContextValue {
  const ctx = useContext(GitPanelContext)
  if (!ctx) throw new Error('useGitPanel must be used within GitPanelProvider')
  return ctx
}
