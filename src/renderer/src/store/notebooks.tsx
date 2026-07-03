import { createContext, useContext, useReducer, useCallback, useRef, useState, type ReactNode } from 'react'
import { KernelClient, type CellOutput, type KernelStatus } from '../lib/kernelClient'
import { parseNotebook, serializeNotebook, type NotebookMeta } from '../lib/ipynb'
import { remapPath } from '../lib/paths'
import { parseTarget } from '../../../shared/remotePath'
import type { WriteResult } from '../../../shared/types'

export type CellType = 'code' | 'markdown' | 'raw'

export interface Cell {
  id: string
  type: CellType
  code: string
  outputs: CellOutput[]
  executionCount: number | null
  running: boolean
  metadata: Record<string, unknown>
}

export interface KernelSpecInfo {
  name: string
  displayName: string
  language: string
}

// Preferred kernel when a notebook doesn't pin one: the auto-venv kernel resolves
// the nearest venv to the notebook's directory.
const PREFERRED_KERNEL = 'python-autovenv'

// Notebooks are keyed by their file path (not by session): opening the same
// notebook again reuses its loaded cells and attached kernel.
interface Notebook {
  path: string
  cells: Cell[]
  meta: NotebookMeta
  kernelStatus: KernelStatus | null
  kernelName: string | null  // kernelspec the running kernel was started from
  kernelCwd: string | null   // override dir for the kernel (custom env); null = notebook's dir
  dirty: boolean
  baseline: string           // last text we loaded/saved; disk == baseline ⇒ no external change
  conflict: boolean          // disk changed under us while the pane was dirty
}

type State = Record<string, Notebook>

type Action =
  | { type: 'LOAD'; path: string; cells: Cell[]; meta: NotebookMeta; baseline: string }
  | { type: 'SET_STATUS'; path: string; status: KernelStatus }
  | { type: 'SET_KERNEL_NAME'; path: string; name: string }
  | { type: 'SET_KERNELSPEC_META'; path: string; kernelspec: Record<string, unknown> }
  | { type: 'SET_KERNEL_CWD'; path: string; cwd: string | null }
  | { type: 'MARK_CLEAN'; path: string; baseline: string }
  | { type: 'SET_CONFLICT'; path: string; conflict: boolean }
  | { type: 'ADD_CELL'; path: string; cell: Cell }
  | { type: 'INSERT_CELL'; path: string; index: number; cell: Cell }
  | { type: 'MOVE_CELL'; path: string; from: number; to: number }
  | { type: 'SET_CELL_TYPE'; path: string; cellId: string; cellType: CellType }
  | { type: 'REMOVE_CELL'; path: string; cellId: string }
  | { type: 'UPDATE_CODE'; path: string; cellId: string; code: string }
  | { type: 'SET_RUNNING'; path: string; cellId: string; running: boolean }
  | { type: 'ADD_OUTPUT'; path: string; cellId: string; output: CellOutput }
  | { type: 'SET_EXEC_COUNT'; path: string; cellId: string; count: number }
  | { type: 'CLEAR_OUTPUTS'; path: string; cellId: string }
  | { type: 'RENAME'; from: string; to: string }

function newCell(type: CellType = 'code'): Cell {
  return { id: crypto.randomUUID(), type, code: '', outputs: [], executionCount: null, running: false, metadata: {} }
}

function reducer(state: State, action: Action): State {
  // RENAME re-keys the whole map and has no single `path`; the rest are per-path.
  const path = 'path' in action ? action.path : ''
  const nb = state[path]
  // Patch + mark dirty (content changed). LOAD/SET_STATUS/SET_KERNEL_NAME/MARK_CLEAN manage `dirty` themselves.
  const dirtyPatch = (s: Notebook) => ({ ...state, [path]: { ...s, dirty: true } })

  switch (action.type) {
    case 'LOAD': {
      const savedDir = action.meta.metadata?.autovenv_dir
      return { ...state, [action.path]: { path: action.path, cells: action.cells, meta: action.meta, kernelStatus: nb?.kernelStatus ?? null, kernelName: nb?.kernelName ?? null, kernelCwd: typeof savedDir === 'string' ? savedDir : null, dirty: false, baseline: action.baseline, conflict: false } }
    }
    case 'SET_STATUS':
      return nb ? { ...state, [action.path]: { ...nb, kernelStatus: action.status } } : state
    case 'SET_KERNEL_NAME':
      return nb ? { ...state, [action.path]: { ...nb, kernelName: action.name } } : state
    case 'SET_KERNELSPEC_META':
      return nb ? dirtyPatch({ ...nb, meta: { ...nb.meta, metadata: { ...nb.meta.metadata, kernelspec: action.kernelspec } } }) : state
    case 'SET_KERNEL_CWD': {
      if (!nb) return state
      const metadata = { ...nb.meta.metadata }
      if (action.cwd) metadata.autovenv_dir = action.cwd
      else delete metadata.autovenv_dir
      return dirtyPatch({ ...nb, kernelCwd: action.cwd, meta: { ...nb.meta, metadata } })
    }
    case 'MARK_CLEAN':
      return nb ? { ...state, [action.path]: { ...nb, dirty: false, baseline: action.baseline, conflict: false } } : state
    case 'SET_CONFLICT':
      return nb ? { ...state, [action.path]: { ...nb, conflict: action.conflict } } : state
    case 'ADD_CELL':
      return nb ? dirtyPatch({ ...nb, cells: [...nb.cells, action.cell] }) : state
    case 'INSERT_CELL': {
      if (!nb) return state
      const cells = [...nb.cells]
      cells.splice(Math.max(0, Math.min(action.index, cells.length)), 0, action.cell)
      return dirtyPatch({ ...nb, cells })
    }
    case 'MOVE_CELL': {
      if (!nb) return state
      const { from, to } = action
      if (from === to || from < 0 || to < 0 || from >= nb.cells.length || to >= nb.cells.length) return state
      const cells = [...nb.cells]
      const [moved] = cells.splice(from, 1)
      cells.splice(to, 0, moved)
      return dirtyPatch({ ...nb, cells })
    }
    case 'SET_CELL_TYPE':
      return nb ? dirtyPatch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, type: action.cellType, outputs: [], executionCount: null } : c) }) : state
    case 'REMOVE_CELL':
      return nb ? dirtyPatch({ ...nb, cells: nb.cells.filter((c) => c.id !== action.cellId) }) : state
    case 'UPDATE_CODE':
      return nb ? dirtyPatch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, code: action.code } : c) }) : state
    case 'SET_RUNNING':
      // Running state is transient UI, not a content change — don't mark dirty.
      return nb ? { ...state, [action.path]: { ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, running: action.running } : c) } } : state
    case 'ADD_OUTPUT':
      return nb ? dirtyPatch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, outputs: [...c.outputs, action.output] } : c) }) : state
    case 'SET_EXEC_COUNT':
      return nb ? dirtyPatch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, executionCount: action.count } : c) }) : state
    case 'CLEAR_OUTPUTS':
      return nb ? dirtyPatch({ ...nb, cells: nb.cells.map((c) => c.id === action.cellId ? { ...c, outputs: [], executionCount: null } : c) }) : state
    case 'RENAME': {
      // Re-key loaded notebooks at or under `from` so an open notebook follows a
      // file/folder rename. Same-dir renames keep the kernel's cwd valid.
      let changed = false
      const next: State = {}
      for (const [key, n] of Object.entries(state)) {
        const nk = remapPath(key, action.from, action.to)
        if (nk !== key) changed = true
        next[nk] = nk === key ? n : { ...n, path: nk }
      }
      return changed ? next : state
    }
    default:
      return state
  }
}

// Kernel clients live outside React state (not serializable), keyed by notebook path.
const kernelClients = new Map<string, KernelClient>()

// One Jupyter server per host, so remote notebooks get their remote server (and
// its kernelspecs) while local notebooks keep the local one. Keyed by remote id,
// or 'local'. The notebook's path carries the remote (remote://id/…).
const serverKey = (path: string) => parseTarget(path).remoteId ?? 'local'
const serverInfos = new Map<string, { url: string; token: string } | null>()

async function getServerInfo(path: string): Promise<{ url: string; token: string } | null> {
  const key = serverKey(path)
  if (serverInfos.has(key)) return serverInfos.get(key)!
  const info = await window.api.jupyter.start(path)
  serverInfos.set(key, info)
  return info
}

interface Specs { default: string; list: KernelSpecInfo[] }
const specsCaches = new Map<string, Specs>()

async function getSpecs(key: string, url: string, token: string): Promise<Specs> {
  const cached = specsCaches.get(key)
  if (cached) return cached
  const res = await fetch(`${url}/api/kernelspecs`, { headers: { Authorization: `token ${token}` } })
  const data = await res.json()
  const list: KernelSpecInfo[] = Object.values(data.kernelspecs ?? {}).map((k: any) => ({
    name: k.name,
    displayName: k.spec?.display_name ?? k.name,
    language: k.spec?.language ?? '',
  }))
  const specs = { default: data.default ?? 'python3', list }
  specsCaches.set(key, specs)
  return specs
}

// Kernel cwd is passed to the API as a path relative to root_dir ("/"), so strip
// the leading slash. Uses `override` (custom env dir) when set, else the
// notebook's own directory. Both are de-scheme'd first: the kernel runs on the
// server's own host, so it needs the plain remote path, not remote://id/….
function kernelCwdPath(notebookPath: string, override?: string | null): string {
  const raw = override && override.length > 0
    ? override
    : (notebookPath.slice(0, notebookPath.lastIndexOf('/')) || '/')
  const dir = parseTarget(raw).path
  return dir.replace(/^\/+/, '')
}

// Which kernelspec to start a notebook with: the one it pins in metadata (if still
// available), otherwise the auto-venv kernel, otherwise the server default.
function chooseSpec(meta: NotebookMeta | undefined, specs: Specs): string {
  const names = new Set(specs.list.map((s) => s.name))
  const pinned = (meta?.metadata?.kernelspec as { name?: string } | undefined)?.name
  if (pinned && names.has(pinned)) return pinned
  if (names.has(PREFERRED_KERNEL)) return PREFERRED_KERNEL
  return specs.default
}

async function createKernel(url: string, token: string, name: string, path: string): Promise<string> {
  const res = await fetch(`${url}/api/kernels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `token ${token}` },
    body: JSON.stringify({ name, path }),
  })
  const data = await res.json()
  if (!data.id) throw new Error(data.message ?? 'kernel create failed')
  return data.id as string
}

interface ContextValue {
  notebooks: State
  specs: KernelSpecInfo[]
  openNotebook: (path: string) => Promise<void>
  saveNotebook: (path: string) => Promise<WriteResult | undefined>
  setKernel: (path: string, specName: string) => Promise<void>
  setKernelDir: (path: string, dir: string) => Promise<void>
  addCell: (path: string, type?: CellType) => void
  insertCell: (path: string, type: CellType, index: number) => string
  moveCell: (path: string, from: number, to: number) => void
  setCellType: (path: string, cellId: string, type: CellType) => void
  removeCell: (path: string, cellId: string) => void
  updateCode: (path: string, cellId: string, code: string) => void
  applyAppEdit: (path: string, op: string, args: Record<string, unknown>, isOpen: boolean) => Promise<string>
  createNotebook: (path: string) => Promise<string>
  checkExternalChange: (path: string) => Promise<void>
  reloadFromDisk: (path: string) => Promise<void>
  dismissConflict: (path: string) => void
  executeCell: (path: string, cellId: string) => void
  runAll: (path: string) => Promise<void>
  restartAndRunAll: (path: string) => Promise<void>
  clearOutputs: (path: string, cellId: string) => void
  clearAllOutputs: (path: string) => void
  interruptKernel: (path: string) => void
  restartKernel: (path: string) => Promise<void>
  shutdownKernel: (path: string) => Promise<void>
  installAndRetry: (path: string) => Promise<void>
  renamePath: (from: string, to: string) => void
}

const NotebookContext = createContext<ContextValue | null>(null)

export function NotebookProvider({ children }: { children: ReactNode }) {
  const [notebooks, dispatch] = useReducer(reducer, {})
  const [specs, setSpecs] = useState<KernelSpecInfo[]>([])
  // Mirror of current state so callbacks read fresh data without re-creating.
  const nbRef = useRef(notebooks)
  nbRef.current = notebooks

  // Start a kernel for `path` from a specific spec, in `cwdOverride` (custom env
  // dir) or the notebook's directory, and wire it up. Caller owns disposing any
  // previous kernel and setting 'starting' status.
  const startKernel = useCallback(async (path: string, specName: string, cwdOverride: string | null): Promise<boolean> => {
    try {
      const info = await getServerInfo(path)
      if (!info) throw new Error('jupyter not available')
      const kernelId = await createKernel(info.url, info.token, specName, kernelCwdPath(path, cwdOverride))
      const client = new KernelClient(info.url, info.token, kernelId)
      client.onStatusChange = (status) => dispatch({ type: 'SET_STATUS', path, status })
      await client.connect()
      kernelClients.set(path, client)
      dispatch({ type: 'SET_KERNEL_NAME', path, name: specName })
      dispatch({ type: 'SET_STATUS', path, status: 'idle' })
      return true
    } catch {
      dispatch({ type: 'SET_STATUS', path, status: 'dead' })
      return false
    }
  }, [])

  // Attach a kernel to a path if it doesn't already have one (reused otherwise).
  const ensureKernel = useCallback(async (path: string) => {
    if (kernelClients.has(path)) return
    dispatch({ type: 'SET_STATUS', path, status: 'starting' })
    const info = await getServerInfo(path)
    if (!info) { dispatch({ type: 'SET_STATUS', path, status: 'dead' }); return }
    const allSpecs = await getSpecs(serverKey(path), info.url, info.token).catch(() => ({ default: 'python3', list: [] as KernelSpecInfo[] }))
    setSpecs(allSpecs.list)
    const nb = nbRef.current[path]
    await startKernel(path, chooseSpec(nb?.meta, allSpecs), nb?.kernelCwd ?? null)
  }, [startKernel])

  const openNotebook = useCallback(async (path: string) => {
    if (!nbRef.current[path]) {
      // First open: load cells from disk. Baseline = the raw text, so the watcher
      // can tell our own writes from a genuine external change.
      const res = await window.api.fs.readText(path)
      const text = res.ok ? res.text : ''
      const { cells, meta } = parseNotebook(text)
      dispatch({ type: 'LOAD', path, cells, meta, baseline: text })
    }
    await ensureKernel(path)
  }, [ensureKernel])

  const disposeKernel = async (path: string) => {
    const old = kernelClients.get(path)
    if (old) {
      await old.shutdown()
      old.dispose()
      kernelClients.delete(path)
    }
  }

  // Deliberately tear down a notebook's kernel (from the notebook browser, or when
  // its owning session closes). Leaves the loaded cells intact; reopening starts
  // a fresh kernel. 'dead' clears the live indicator everywhere.
  const shutdownKernel = useCallback(async (path: string) => {
    if (!kernelClients.has(path)) return
    await disposeKernel(path)
    dispatch({ type: 'SET_STATUS', path, status: 'dead' })
  }, [])

  // Switch a notebook to a different kernelspec (using the notebook's own dir),
  // persisting the choice into the notebook's metadata so it reopens the same.
  const setKernel = useCallback(async (path: string, specName: string) => {
    const nb = nbRef.current[path]
    if (nb?.kernelName === specName && !nb?.kernelCwd && kernelClients.has(path)) return
    await disposeKernel(path)
    dispatch({ type: 'SET_STATUS', path, status: 'starting' })
    dispatch({ type: 'SET_KERNEL_CWD', path, cwd: null })  // back to the notebook's dir
    const spec = specsCaches.get(serverKey(path))?.list.find((s) => s.name === specName)
    dispatch({ type: 'SET_KERNELSPEC_META', path, kernelspec: { name: specName, display_name: spec?.displayName ?? specName, language: spec?.language ?? 'python' } })
    await startKernel(path, specName, null)
  }, [startKernel])

  // Point a notebook's kernel at a custom directory: starts the auto-venv kernel
  // there so it resolves the nearest venv to that directory. Persisted in metadata.
  const setKernelDir = useCallback(async (path: string, dir: string) => {
    await disposeKernel(path)
    dispatch({ type: 'SET_STATUS', path, status: 'starting' })
    dispatch({ type: 'SET_KERNEL_CWD', path, cwd: dir })
    const specs = specsCaches.get(serverKey(path))
    const specName = specs?.list.some((s) => s.name === PREFERRED_KERNEL) ? PREFERRED_KERNEL : (specs?.default ?? 'python3')
    const spec = specs?.list.find((s) => s.name === specName)
    dispatch({ type: 'SET_KERNELSPEC_META', path, kernelspec: { name: specName, display_name: spec?.displayName ?? specName, language: spec?.language ?? 'python' } })
    await startKernel(path, specName, dir)
  }, [startKernel])

  const saveNotebook = useCallback(async (path: string): Promise<WriteResult | undefined> => {
    const nb = nbRef.current[path]
    if (!nb) return
    const text = serializeNotebook(nb.cells, nb.meta)
    const res = await window.api.fs.writeFile(path, text)
    // Baseline = exactly what we wrote, so the watcher event our own write triggers
    // is recognized as an echo (disk == baseline) and ignored.
    if (res.ok) dispatch({ type: 'MARK_CLEAN', path, baseline: text })
    return res
  }, [])

  // The watched notebook file changed on disk (external writer: Bash, git, a
  // sibling agent). Echo-filter our own writes by comparing to the baseline; then
  // a clean pane adopts disk, a dirty pane raises a conflict (banner in the view).
  const checkExternalChange = useCallback(async (path: string) => {
    const nb = nbRef.current[path]
    if (!nb) return
    const res = await window.api.fs.readText(path)
    if (!res.ok || res.text === nb.baseline) return  // unreadable, or our own write / no real change
    if (nb.dirty) {
      dispatch({ type: 'SET_CONFLICT', path, conflict: true })
    } else {
      const { cells, meta } = parseNotebook(res.text)
      dispatch({ type: 'LOAD', path, cells, meta, baseline: res.text })  // adopt disk live
    }
  }, [])

  // Conflict resolution: take the on-disk version (discard in-memory edits)…
  const reloadFromDisk = useCallback(async (path: string) => {
    const res = await window.api.fs.readText(path)
    const text = res.ok ? res.text : ''
    const { cells, meta } = parseNotebook(text)
    dispatch({ type: 'LOAD', path, cells, meta, baseline: text })
  }, [])
  // …or keep mine (dismiss the banner; the next save overwrites disk).
  const dismissConflict = useCallback((path: string) => {
    dispatch({ type: 'SET_CONFLICT', path, conflict: false })
  }, [])

  const addCell = useCallback((path: string, type: CellType = 'code') => {
    dispatch({ type: 'ADD_CELL', path, cell: newCell(type) })
  }, [])

  const insertCell = useCallback((path: string, type: CellType, index: number): string => {
    const cell = newCell(type)
    dispatch({ type: 'INSERT_CELL', path, index, cell })
    return cell.id
  }, [])

  const moveCell = useCallback((path: string, from: number, to: number) => {
    dispatch({ type: 'MOVE_CELL', path, from, to })
  }, [])

  const setCellType = useCallback((path: string, cellId: string, type: CellType) => {
    dispatch({ type: 'SET_CELL_TYPE', path, cellId, cellType: type })
  }, [])

  const removeCell = useCallback((path: string, cellId: string) => {
    dispatch({ type: 'REMOVE_CELL', path, cellId })
  }, [])

  const updateCode = useCallback((path: string, cellId: string, code: string) => {
    dispatch({ type: 'UPDATE_CODE', path, cellId, code })
  }, [])

  // Apply an app-control (MCP tool) edit to a notebook, addressed by 0-based cell
  // index (Claude doesn't know cell ids). `isOpen` (whether the path is currently
  // an open tab in some pane — decided by the caller against the file-browser
  // store, NOT the notebooks cache, which lingers after a tab is closed) picks:
  //  - open     → mutate in memory, mark dirty (yellow ● + Save); NO disk write,
  //    so we never clobber a notebook the user is editing, and the edit shows live
  //    in its pane. The user (or autosave) persists it.
  //  - not open → a "quiet" disk write: read the file, apply the edit by index,
  //    serialize, write. We do NOT open a pane; there's nothing on screen to be
  //    live, so disk is the only sensible target (and nothing to clobber).
  // Returns 'ok…' or 'error: …'.
  const applyAppEdit = useCallback(async (path: string, op: string, args: Record<string, unknown>, isOpen: boolean): Promise<string> => {
    const asType = (v: unknown): CellType => (v === 'markdown' ? 'markdown' : v === 'raw' ? 'raw' : 'code')
    const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))

    if (isOpen) {
      // --- Open in a pane: mutate in memory (live, unsaved). Ensure it's loaded
      // (an open tab normally is; seed from disk otherwise), resolving index→id
      // from `current` because nbRef won't reflect the LOAD synchronously.
      // Sequential dispatches compose — useReducer applies each against the prior.
      let current = nbRef.current[path]?.cells
      if (!current) {
        const res = await window.api.fs.readText(path)
        const text = res.ok ? res.text : ''
        const parsed = parseNotebook(text)
        dispatch({ type: 'LOAD', path, cells: parsed.cells, meta: parsed.meta, baseline: text })
        current = parsed.cells
      }
      const N = current.length
      const inRange = (i: number) => i >= 0 && i < N
      switch (op) {
        case 'edit_cell': {
          const i = num(args.index)
          if (!inRange(i)) return `error: cell index ${i} out of range (0..${N - 1})`
          const cellId = current[i].id
          dispatch({ type: 'UPDATE_CODE', path, cellId, code: String(args.source ?? '') })
          dispatch({ type: 'CLEAR_OUTPUTS', path, cellId })  // source changed → outputs stale
          return `ok (edited cell ${i}; ${N} cells, unsaved in the open pane)`
        }
        case 'add_cell': {
          const c = newCell(asType(args.type)); c.code = String(args.source ?? '')
          dispatch({ type: 'ADD_CELL', path, cell: c })
          return `ok (${N + 1} cells, unsaved in the open pane)`
        }
        case 'insert_cell': {
          const i = Math.max(0, Math.min(num(args.index), N))
          const c = newCell(asType(args.type)); c.code = String(args.source ?? '')
          dispatch({ type: 'INSERT_CELL', path, index: i, cell: c })
          return `ok (${N + 1} cells, unsaved in the open pane)`
        }
        case 'delete_cell': {
          const i = num(args.index)
          if (!inRange(i)) return `error: cell index ${i} out of range (0..${N - 1})`
          dispatch({ type: 'REMOVE_CELL', path, cellId: current[i].id })
          return `ok (${N - 1} cells, unsaved in the open pane)`
        }
        case 'move_cell': {
          const from = num(args.from), to = num(args.to)
          if (!inRange(from) || !inRange(to)) return `error: cell index out of range (0..${N - 1})`
          dispatch({ type: 'MOVE_CELL', path, from, to })
          return `ok (moved cell ${from} → ${to}; unsaved in the open pane)`
        }
        case 'set_cell_type': {
          const i = num(args.index)
          if (!inRange(i)) return `error: cell index ${i} out of range (0..${N - 1})`
          dispatch({ type: 'SET_CELL_TYPE', path, cellId: current[i].id, cellType: asType(args.type) })
          return `ok (cell ${i} → ${asType(args.type)}; unsaved in the open pane)`
        }
        default:
          return `error: unknown notebook op ${op}`
      }
    }

    // --- Quiet disk write (notebook not open): read → apply by index → write.
    const res = await window.api.fs.readText(path)
    if (!res.ok) return `error: could not read ${path}: ${res.error} (use create_notebook to make a new one)`
    const parsed = parseNotebook(res.text)
    const cells = [...parsed.cells]
    const N = cells.length
    const inRange = (i: number) => i >= 0 && i < N
    switch (op) {
      case 'edit_cell': {
        const i = num(args.index)
        if (!inRange(i)) return `error: cell index ${i} out of range (0..${N - 1})`
        cells[i] = { ...cells[i], code: String(args.source ?? ''), outputs: [], executionCount: null }
        break
      }
      case 'add_cell': {
        const c = newCell(asType(args.type)); c.code = String(args.source ?? '')
        cells.push(c)
        break
      }
      case 'insert_cell': {
        const i = Math.max(0, Math.min(num(args.index), N))
        const c = newCell(asType(args.type)); c.code = String(args.source ?? '')
        cells.splice(i, 0, c)
        break
      }
      case 'delete_cell': {
        const i = num(args.index)
        if (!inRange(i)) return `error: cell index ${i} out of range (0..${N - 1})`
        cells.splice(i, 1)
        break
      }
      case 'move_cell': {
        const from = num(args.from), to = num(args.to)
        if (!inRange(from) || !inRange(to)) return `error: cell index out of range (0..${N - 1})`
        const [moved] = cells.splice(from, 1)
        cells.splice(to, 0, moved)
        break
      }
      case 'set_cell_type': {
        const i = num(args.index)
        if (!inRange(i)) return `error: cell index ${i} out of range (0..${N - 1})`
        cells[i] = { ...cells[i], type: asType(args.type), outputs: [], executionCount: null }
        break
      }
      default:
        return `error: unknown notebook op ${op}`
    }
    const wr = await window.api.fs.writeFile(path, serializeNotebook(cells, parsed.meta))
    if (!wr.ok) return `error: ${wr.error}`
    return `ok (${cells.length} cells, written to disk: ${path} — not open, so no pane to update)`
  }, [])

  // Create a new, empty notebook on disk (quietly — not opened in a pane). Fails
  // if the file already exists so we never clobber. The not-open edit path above
  // then targets it by disk write; opening it later loads it fresh.
  const createNotebook = useCallback(async (path: string): Promise<string> => {
    const empty = parseNotebook('')  // baseline nbformat + metadata, zero cells
    const wr = await window.api.fs.writeFile(path, serializeNotebook(empty.cells, empty.meta))
    if (!wr.ok) return `error: ${wr.error}`
    return `ok (created empty notebook: ${path})`
  }, [])

  // Run one code cell, resolving when the kernel replies. `false` means the cell
  // errored (so Run All can stop), `true` means it finished (or was skipped).
  const runCell = useCallback((path: string, cellId: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const client = kernelClients.get(path)
      const nb = nbRef.current[path]
      if (!client || !nb) return resolve(false)
      const cell = nb.cells.find((c) => c.id === cellId)
      if (!cell || cell.type !== 'code' || cell.running) return resolve(true)

      dispatch({ type: 'CLEAR_OUTPUTS', path, cellId })
      dispatch({ type: 'SET_RUNNING', path, cellId, running: true })

      let errored = false
      client.execute(
        cell.code,
        (output) => {
          if (output.type === 'error') errored = true
          dispatch({ type: 'ADD_OUTPUT', path, cellId, output })
        },
        (count) => {
          dispatch({ type: 'SET_EXEC_COUNT', path, cellId, count })
          dispatch({ type: 'SET_RUNNING', path, cellId, running: false })
          resolve(!errored)
        },
      )
    })
  }, [])

  const executeCell = useCallback((path: string, cellId: string) => {
    void runCell(path, cellId)
  }, [runCell])

  // Run every code cell top-to-bottom, stopping at the first error (as Jupyter does).
  const runAll = useCallback(async (path: string) => {
    if (!kernelClients.has(path)) return
    const ids = (nbRef.current[path]?.cells ?? []).filter((c) => c.type === 'code').map((c) => c.id)
    for (const id of ids) {
      if (!(await runCell(path, id))) break
    }
  }, [runCell])

  const clearOutputs = useCallback((path: string, cellId: string) => {
    dispatch({ type: 'CLEAR_OUTPUTS', path, cellId })
  }, [])

  const clearAllOutputs = useCallback((path: string) => {
    for (const c of nbRef.current[path]?.cells ?? []) {
      if (c.type === 'code') dispatch({ type: 'CLEAR_OUTPUTS', path, cellId: c.id })
    }
  }, [])

  const interruptKernel = useCallback((path: string) => {
    kernelClients.get(path)?.interrupt()
  }, [])

  const restartKernel = useCallback(async (path: string) => {
    const client = kernelClients.get(path)
    if (!client) return
    dispatch({ type: 'SET_STATUS', path, status: 'starting' })
    await client.restart()
  }, [])

  // Wait until the kernel reports idle again after a restart (or give up). We set
  // 'starting' before calling this, so we won't read a stale 'idle'.
  const waitForIdle = useCallback((path: string, timeoutMs = 20000): Promise<void> => {
    return new Promise((resolve) => {
      const start = Date.now()
      const tick = () => {
        const st = nbRef.current[path]?.kernelStatus
        if (st === 'idle' || st === 'dead' || Date.now() - start > timeoutMs) return resolve()
        setTimeout(tick, 100)
      }
      setTimeout(tick, 300)
    })
  }, [])

  // Fresh kernel, then run the whole notebook — the reliable "reproduce from scratch".
  const restartAndRunAll = useCallback(async (path: string) => {
    const client = kernelClients.get(path)
    if (!client) return
    dispatch({ type: 'SET_STATUS', path, status: 'starting' })
    await client.restart()
    await waitForIdle(path)
    await runAll(path)
  }, [runAll, waitForIdle])

  const installAndRetry = useCallback(async (path: string) => {
    dispatch({ type: 'SET_STATUS', path, status: 'starting' })
    await window.api.jupyter.install(path)
    // Reset cached server/spec info for this host so the next attempt spawns a
    // fresh server.
    const key = serverKey(path)
    serverInfos.delete(key)
    specsCaches.delete(key)
    kernelClients.get(path)?.dispose()
    kernelClients.delete(path)
    await ensureKernel(path)
  }, [ensureKernel])

  // Follow a file/folder rename: move the running kernel clients (keyed by path)
  // and re-key the notebook state so an open notebook keeps its cells + kernel.
  const renamePath = useCallback((from: string, to: string) => {
    for (const key of [...kernelClients.keys()]) {
      const nk = remapPath(key, from, to)
      if (nk === key) continue
      const client = kernelClients.get(key)!
      kernelClients.delete(key)
      kernelClients.set(nk, client)
    }
    dispatch({ type: 'RENAME', from, to })
  }, [])

  return (
    <NotebookContext.Provider value={{
      notebooks, specs,
      openNotebook, saveNotebook, setKernel, setKernelDir,
      addCell, insertCell, moveCell, setCellType, removeCell, updateCode, applyAppEdit, createNotebook,
      checkExternalChange, reloadFromDisk, dismissConflict,
      executeCell, runAll, restartAndRunAll, clearOutputs, clearAllOutputs,
      interruptKernel, restartKernel, shutdownKernel, installAndRetry,
      renamePath,
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
