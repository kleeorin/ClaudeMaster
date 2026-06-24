import { createContext, useContext, useReducer, useCallback, useEffect, type ReactNode } from 'react'

interface SessionBrowser {
  open: boolean
  path: string  // current directory being viewed (cwd or a descendant)
}

type State = Record<string, SessionBrowser>

type Action =
  | { type: 'OPEN'; sessionId: string; cwd: string }
  | { type: 'CLOSE'; sessionId: string }
  | { type: 'NAVIGATE'; sessionId: string; path: string }
  | { type: 'DESTROY'; sessionId: string }

function reducer(state: State, action: Action): State {
  const b = state[action.sessionId]
  const patch = (s: SessionBrowser) => ({ ...state, [action.sessionId]: s })

  switch (action.type) {
    case 'OPEN':
      // Reset to cwd each time it's opened fresh; keep path if already known.
      return patch({ open: true, path: b?.path ?? action.cwd })
    case 'CLOSE':
      return b ? patch({ ...b, open: false }) : state
    case 'NAVIGATE':
      return b ? patch({ ...b, path: action.path }) : state
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
  browsers: State
  openBrowser: (sessionId: string, cwd: string) => void
  closeBrowser: (sessionId: string) => void
  navigate: (sessionId: string, path: string) => void
}

const FileBrowserContext = createContext<ContextValue | null>(null)

export function FileBrowserProvider({ children }: { children: ReactNode }) {
  const [browsers, dispatch] = useReducer(reducer, {})

  useEffect(() => {
    const offExit = window.api.on.exit((id) => {
      dispatch({ type: 'DESTROY', sessionId: id })
    })
    return offExit
  }, [])

  const openBrowser = useCallback((sessionId: string, cwd: string) => {
    dispatch({ type: 'OPEN', sessionId, cwd })
  }, [])

  const closeBrowser = useCallback((sessionId: string) => {
    dispatch({ type: 'CLOSE', sessionId })
  }, [])

  const navigate = useCallback((sessionId: string, path: string) => {
    dispatch({ type: 'NAVIGATE', sessionId, path })
  }, [])

  return (
    <FileBrowserContext.Provider value={{ browsers, openBrowser, closeBrowser, navigate }}>
      {children}
    </FileBrowserContext.Provider>
  )
}

export function useFileBrowser(): ContextValue {
  const ctx = useContext(FileBrowserContext)
  if (!ctx) throw new Error('useFileBrowser must be used within FileBrowserProvider')
  return ctx
}
