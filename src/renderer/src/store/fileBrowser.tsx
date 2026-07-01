import { createContext, useContext, useReducer, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { remapPath } from '../lib/paths'

// A file/dir cut or copied in the file browser, ready to paste elsewhere. Global
// (not per-session), so you can copy in one session and paste in another.
export interface Clipboard {
  path: string
  mode: 'copy' | 'cut'
}

// Sentinel tab id for the Claude terminal (full-screen) tab. Real file tabs are
// keyed by absolute path, which always starts with '/', so this never collides.
export const CLAUDE_TAB = 'claude'

// A file open as a tab in the main column. Notebooks get the native cells+kernel
// view; everything else gets the code/preview view — both share the same slot.
export interface OpenFile {
  path: string
  isNotebook: boolean
}

interface SessionBrowser {
  open: boolean
  path: string  // current directory being viewed (cwd or a descendant)
  openFiles: OpenFile[]  // file tabs, in open order
  activeTab: string  // CLAUDE_TAB or one of openFiles' paths
  dirtyFiles: string[]  // paths with unsaved edits (drives close confirmation)
}

type State = Record<string, SessionBrowser>

type Action =
  | { type: 'OPEN'; sessionId: string; cwd: string }
  | { type: 'CLOSE'; sessionId: string }
  | { type: 'NAVIGATE'; sessionId: string; path: string }
  | { type: 'OPEN_FILE'; sessionId: string; path: string; isNotebook: boolean }
  | { type: 'CLOSE_FILE'; sessionId: string; path: string }
  | { type: 'SET_ACTIVE_TAB'; sessionId: string; tab: string }
  | { type: 'SET_DIRTY'; sessionId: string; path: string; dirty: boolean }
  | { type: 'RENAME_FILE'; from: string; to: string }
  | { type: 'DESTROY'; sessionId: string }

const freshBrowser = (cwd: string): SessionBrowser =>
  ({ open: true, path: cwd, openFiles: [], activeTab: CLAUDE_TAB, dirtyFiles: [] })

function reducer(state: State, action: Action): State {
  // RENAME_FILE has no sessionId (it spans all sessions); the rest are per-session.
  const sessionId = 'sessionId' in action ? action.sessionId : ''
  const b = state[sessionId]
  const patch = (s: SessionBrowser) => ({ ...state, [sessionId]: s })

  switch (action.type) {
    case 'OPEN':
      // Reset to cwd each time it's opened fresh; keep state if already known.
      return patch(b ? { ...b, open: true } : freshBrowser(action.cwd))
    case 'CLOSE':
      return b ? patch({ ...b, open: false }) : state
    case 'NAVIGATE':
      return b ? patch({ ...b, path: action.path }) : state
    case 'OPEN_FILE': {
      if (!b) return state
      // Reuse an existing tab for the same file; otherwise append one. Either way
      // the opened file becomes the active tab.
      const exists = b.openFiles.some((f) => f.path === action.path)
      const openFiles = exists
        ? b.openFiles
        : [...b.openFiles, { path: action.path, isNotebook: action.isNotebook }]
      return patch({ ...b, openFiles, activeTab: action.path })
    }
    case 'CLOSE_FILE': {
      if (!b) return state
      const idx = b.openFiles.findIndex((f) => f.path === action.path)
      if (idx === -1) return state
      const openFiles = b.openFiles.filter((f) => f.path !== action.path)
      const dirtyFiles = b.dirtyFiles.filter((p) => p !== action.path)
      // If the closed tab was active, fall through to its right neighbour, else
      // its left neighbour, else back to Claude.
      let activeTab = b.activeTab
      if (activeTab === action.path) {
        const next = openFiles[idx] ?? openFiles[idx - 1]
        activeTab = next ? next.path : CLAUDE_TAB
      }
      return patch({ ...b, openFiles, dirtyFiles, activeTab })
    }
    case 'SET_ACTIVE_TAB':
      return b ? patch({ ...b, activeTab: action.tab }) : state
    case 'SET_DIRTY': {
      if (!b) return state
      const has = b.dirtyFiles.includes(action.path)
      if (action.dirty === has) return state
      const dirtyFiles = action.dirty
        ? [...b.dirtyFiles, action.path]
        : b.dirtyFiles.filter((p) => p !== action.path)
      return patch({ ...b, dirtyFiles })
    }
    case 'RENAME_FILE': {
      // Make every session's open tabs, active tab, dirty set, and viewed dir
      // follow a file/folder rename (the file menu lives in one session, but the
      // path is global). CLAUDE_TAB never matches an absolute path, so it's safe.
      const { from, to } = action
      const next: State = {}
      for (const [sid, s] of Object.entries(state)) {
        next[sid] = {
          ...s,
          path: remapPath(s.path, from, to),
          openFiles: s.openFiles.map((f) => ({ ...f, path: remapPath(f.path, from, to) })),
          activeTab: remapPath(s.activeTab, from, to),
          dirtyFiles: s.dirtyFiles.map((p) => remapPath(p, from, to)),
        }
      }
      return next
    }
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
  openFile: (sessionId: string, path: string, isNotebook: boolean) => void
  closeFile: (sessionId: string, path: string) => void
  setActiveTab: (sessionId: string, tab: string) => void
  setFileDirty: (sessionId: string, path: string, dirty: boolean) => void
  renamePath: (from: string, to: string) => void
  clipboard: Clipboard | null
  setClipboard: (clip: Clipboard | null) => void
}

const FileBrowserContext = createContext<ContextValue | null>(null)

export function FileBrowserProvider({ children }: { children: ReactNode }) {
  const [browsers, dispatch] = useReducer(reducer, {})
  const [clipboard, setClipboard] = useState<Clipboard | null>(null)

  // Latest state, so closeFile can check dirtiness without re-creating callbacks.
  const stateRef = useRef(browsers)
  stateRef.current = browsers

  useEffect(() => {
    const offExit = window.api.on.exit((id, failedFast) => {
      // A fast Claude failure keeps the session alive (its files still work over
      // ssh), so only tear the browser down on a real close.
      if (!failedFast) dispatch({ type: 'DESTROY', sessionId: id })
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

  const openFile = useCallback((sessionId: string, path: string, isNotebook: boolean) => {
    dispatch({ type: 'OPEN_FILE', sessionId, path, isNotebook })
  }, [])

  const closeFile = useCallback((sessionId: string, path: string) => {
    const b = stateRef.current[sessionId]
    if (b?.dirtyFiles.includes(path) && !window.confirm('Discard unsaved changes?')) return
    dispatch({ type: 'CLOSE_FILE', sessionId, path })
  }, [])

  const setActiveTab = useCallback((sessionId: string, tab: string) => {
    dispatch({ type: 'SET_ACTIVE_TAB', sessionId, tab })
  }, [])

  const setFileDirty = useCallback((sessionId: string, path: string, dirty: boolean) => {
    dispatch({ type: 'SET_DIRTY', sessionId, path, dirty })
  }, [])

  const renamePath = useCallback((from: string, to: string) => {
    dispatch({ type: 'RENAME_FILE', from, to })
  }, [])

  return (
    <FileBrowserContext.Provider value={{ browsers, openBrowser, closeBrowser, navigate, openFile, closeFile, setActiveTab, setFileDirty, renamePath, clipboard, setClipboard }}>
      {children}
    </FileBrowserContext.Provider>
  )
}

export function useFileBrowser(): ContextValue {
  const ctx = useContext(FileBrowserContext)
  if (!ctx) throw new Error('useFileBrowser must be used within FileBrowserProvider')
  return ctx
}
