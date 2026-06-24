import { createContext, useContext, useReducer, useCallback, useEffect, type ReactNode } from 'react'
import { KernelClient, type CellOutput, type KernelStatus } from '../lib/kernelClient'

export interface Cell {
  id: string
  code: string
  outputs: CellOutput[]
  executionCount: number | null
  running: boolean
}

interface SessionNotebook {
  cells: Cell[]
  kernelStatus: KernelStatus | null
  open: boolean
}

type State = Record<string, SessionNotebook>

type Action =
  | { type: 'OPEN'; sessionId: string }
  | { type: 'CLOSE'; sessionId: string }
  | { type: 'DESTROY'; sessionId: string }
  | { type: 'SET_STATUS'; sessionId: string; status: KernelStatus }
  | { type: 'ADD_CELL'; sessionId: string; cell: Cell }
  | { type: 'REMOVE_CELL'; sessionId: string; cellId: string }
  | { type: 'UPDATE_CODE'; sessionId: string; cellId: string; code: string }
  | { type: 'SET_RUNNING'; sessionId: string; cellId: string; running: boolean }
  | { type: 'ADD_OUTPUT'; sessionId: string; cellId: string; output: CellOutput }
  | { type: 'SET_EXEC_COUNT'; sessionId: string; cellId: string; count: number }
  | { type: 'CLEAR_OUTPUTS'; sessionId: string; cellId: string }

function defaultNotebook(): SessionNotebook {
  return { cells: [newCell()], kernelStatus: null, open: false }
}

function newCell(): Cell {
  return { id: crypto.randomUUID(), code: '', outputs: [], executionCount: null, running: false }
}

function reducer(state: State, action: Action): State {
  const nb = state[action.sessionId]
  const patch = (s: SessionNotebook) => ({ ...state, [action.sessionId]: s })

  switch (action.type) {
    case 'OPEN':
      return patch({ ...(nb ?? defaultNotebook()), open: true, kernelStatus: 'starting' })
    case 'CLOSE':
      return nb ? patch({ ...nb, open: false }) : state
    case 'DESTROY': {
      const next = { ...state }
      delete next[action.sessionId]
      return next
    }
    case 'SET_STATUS':
      return nb ? patch({ ...nb, kernelStatus: action.status }) : state
    case 'ADD_CELL':
      return nb ? patch({ ...nb, cells: [...nb.cells, action.cell] }) : state
    case 'REMOVE_CELL':
      return nb ? patch({ ...nb, cells: nb.cells.filter((c) => c.id !== action.cellId) }) : state
    case 'UPDATE_CODE':
      return nb ? patch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, code: action.code } : c) }) : state
    case 'SET_RUNNING':
      return nb ? patch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, running: action.running } : c) }) : state
    case 'ADD_OUTPUT':
      return nb ? patch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, outputs: [...c.outputs, action.output] } : c) }) : state
    case 'SET_EXEC_COUNT':
      return nb ? patch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, executionCount: action.count } : c) }) : state
    case 'CLEAR_OUTPUTS':
      return nb ? patch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, outputs: [], executionCount: null } : c) }) : state
    default:
      return state
  }
}

// Kernel clients live outside React state (not serializable)
const kernelClients = new Map<string, KernelClient>()
let serverInfo: { url: string; token: string } | null = null

async function getServerInfo(): Promise<{ url: string; token: string } | null> {
  if (serverInfo) return serverInfo
  serverInfo = await window.api.jupyter.start()
  return serverInfo
}

async function createKernel(url: string, token: string): Promise<string> {
  const res = await fetch(`${url}/api/kernels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `token ${token}` },
    body: JSON.stringify({ name: 'python3' }),
  })
  const data = await res.json()
  return data.id as string
}

async function destroyKernel(url: string, token: string, kernelId: string): Promise<void> {
  await fetch(`${url}/api/kernels/${kernelId}`, {
    method: 'DELETE',
    headers: { Authorization: `token ${token}` },
  })
}

interface ContextValue {
  notebooks: State
  openNotebook: (sessionId: string) => Promise<void>
  closeNotebook: (sessionId: string) => void
  addCell: (sessionId: string) => void
  removeCell: (sessionId: string, cellId: string) => void
  updateCode: (sessionId: string, cellId: string, code: string) => void
  executeCell: (sessionId: string, cellId: string) => void
  clearOutputs: (sessionId: string, cellId: string) => void
  interruptKernel: (sessionId: string) => void
  restartKernel: (sessionId: string) => Promise<void>
  installAndRetry: (sessionId: string) => Promise<void>
}

const NotebookContext = createContext<ContextValue | null>(null)

export function NotebookProvider({ children }: { children: ReactNode }) {
  const [notebooks, dispatch] = useReducer(reducer, {})

  // Clean up kernels when sessions exit
  useEffect(() => {
    const offExit = window.api.on.exit(async (id) => {
      const client = kernelClients.get(id)
      if (client) {
        const info = serverInfo
        // best-effort kernel cleanup
        try { if (info) await destroyKernel(info.url, info.token, (client as unknown as { kernelId: string }).kernelId) } catch { /**/ }
        client.dispose()
        kernelClients.delete(id)
      }
      dispatch({ type: 'DESTROY', sessionId: id })
    })
    return offExit
  }, [])

  const openNotebook = useCallback(async (sessionId: string) => {
    dispatch({ type: 'OPEN', sessionId })
    if (kernelClients.has(sessionId)) {
      // Already have a kernel — just re-open the panel
      return
    }
    try {
      const info = await getServerInfo()
      if (!info) throw new Error('jupyter not available')
      const kernelId = await createKernel(info.url, info.token)
      const client = new KernelClient(info.url, info.token, kernelId)
      client.onStatusChange = (status) => dispatch({ type: 'SET_STATUS', sessionId, status })
      await client.connect()
      kernelClients.set(sessionId, client)
      dispatch({ type: 'SET_STATUS', sessionId, status: 'idle' })
    } catch {
      dispatch({ type: 'SET_STATUS', sessionId, status: 'dead' })
    }
  }, [])

  const closeNotebook = useCallback((sessionId: string) => {
    dispatch({ type: 'CLOSE', sessionId })
  }, [])

  const addCell = useCallback((sessionId: string) => {
    dispatch({ type: 'ADD_CELL', sessionId, cell: newCell() })
  }, [])

  const removeCell = useCallback((sessionId: string, cellId: string) => {
    dispatch({ type: 'REMOVE_CELL', sessionId, cellId })
  }, [])

  const updateCode = useCallback((sessionId: string, cellId: string, code: string) => {
    dispatch({ type: 'UPDATE_CODE', sessionId, cellId, code })
  }, [])

  const executeCell = useCallback((sessionId: string, cellId: string) => {
    const client = kernelClients.get(sessionId)
    const nb = notebooks[sessionId]
    if (!client || !nb) return
    const cell = nb.cells.find((c) => c.id === cellId)
    if (!cell || cell.running) return

    dispatch({ type: 'CLEAR_OUTPUTS', sessionId, cellId })
    dispatch({ type: 'SET_RUNNING', sessionId, cellId, running: true })

    client.execute(
      cell.code,
      (output) => dispatch({ type: 'ADD_OUTPUT', sessionId, cellId, output }),
      (count) => {
        dispatch({ type: 'SET_EXEC_COUNT', sessionId, cellId, count })
        dispatch({ type: 'SET_RUNNING', sessionId, cellId, running: false })
      },
    )
  }, [notebooks])

  const clearOutputs = useCallback((sessionId: string, cellId: string) => {
    dispatch({ type: 'CLEAR_OUTPUTS', sessionId, cellId })
  }, [])

  const interruptKernel = useCallback((sessionId: string) => {
    kernelClients.get(sessionId)?.interrupt()
  }, [])

  const restartKernel = useCallback(async (sessionId: string) => {
    const client = kernelClients.get(sessionId)
    if (!client) return
    dispatch({ type: 'SET_STATUS', sessionId, status: 'starting' })
    await client.restart()
  }, [])

  const installAndRetry = useCallback(async (sessionId: string) => {
    dispatch({ type: 'SET_STATUS', sessionId, status: 'starting' })
    await window.api.jupyter.install()
    // Reset cached server info so next openNotebook attempt spawns a fresh server
    serverInfo = null
    kernelClients.get(sessionId)?.dispose()
    kernelClients.delete(sessionId)
    try {
      const info = await getServerInfo()
      if (!info) throw new Error('jupyter not available')
      const kernelId = await createKernel(info.url, info.token)
      const client = new KernelClient(info.url, info.token, kernelId)
      client.onStatusChange = (status) => dispatch({ type: 'SET_STATUS', sessionId, status })
      await client.connect()
      kernelClients.set(sessionId, client)
      dispatch({ type: 'SET_STATUS', sessionId, status: 'idle' })
    } catch {
      dispatch({ type: 'SET_STATUS', sessionId, status: 'dead' })
    }
  }, [])

  return (
    <NotebookContext.Provider value={{
      notebooks, openNotebook, closeNotebook,
      addCell, removeCell, updateCode,
      executeCell, clearOutputs,
      interruptKernel, restartKernel, installAndRetry,
    }}>
      {children}
    </NotebookContext.Provider>
  )
}

export function useNotebooks(): ContextValue {
  const ctx = useContext(NotebookContext)
  if (!ctx) throw new Error('useNotebooks must be used within NotebookProvider')
  return ctx
}
