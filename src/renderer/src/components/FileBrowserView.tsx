import { useEffect, useMemo, useRef, useState } from 'react'
import { useFileBrowser } from '../store/fileBrowser'
import { useNotebooks } from '../store/notebooks'
import { emptyNotebookJSON } from '../lib/ipynb'
import type { DirEntry } from '../../../shared/types'

const isNotebook = (name: string) => name.endsWith('.ipynb')

interface Props {
  sessionId: string
  cwd: string  // session root — navigation is constrained to this subtree
}

interface Menu {
  x: number
  y: number
  entry: DirEntry | null  // null = background (empty area) — paste target is the current dir
}

// Inline editing: renaming an existing entry, or naming a new file/folder.
type Editing =
  | { mode: 'rename'; original: string }
  | { mode: 'newFile' }
  | { mode: 'newFolder' }

type SortKey = 'name' | 'size' | 'modified' | 'type'
interface Sort { key: SortKey; dir: 1 | -1 }

const ext = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : '' }

// Within a group, sort by the chosen key and direction, falling back to name so
// the order is stable. When `foldersFirst`, directories are grouped above files.
function sortEntries(entries: DirEntry[], { key, dir }: Sort, foldersFirst: boolean): DirEntry[] {
  const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name)
  return [...entries].sort((a, b) => {
    if (foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1
    let cmp = 0
    switch (key) {
      case 'name': cmp = byName(a, b); break
      case 'size': cmp = a.size - b.size || byName(a, b); break
      case 'modified': cmp = a.mtimeMs - b.mtimeMs || byName(a, b); break
      case 'type': cmp = ext(a.name).localeCompare(ext(b.name)) || byName(a, b); break
    }
    return cmp * dir
  })
}

const humanSize = (n: number): string => {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

// Compact, sortable-looking date: "Jun 29" within this year, else "2024-12".
const shortDate = (ms: number): string => {
  if (!ms) return ''
  const d = new Date(ms)
  return d.getFullYear() === new Date().getFullYear()
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function FileBrowserView({ sessionId, cwd }: Props) {
  const { browsers, navigate, openFile, clipboard, setClipboard, renamePath } = useFileBrowser()
  const { openNotebook, renamePath: renameNotebookPath } = useNotebooks()
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 1 })
  const [query, setQuery] = useState('')
  const [foldersFirst, setFoldersFirst] = useState(true)
  const [showHidden, setShowHidden] = useState(false)

  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = entries.filter((e) =>
      (showHidden || !e.name.startsWith('.')) &&
      (!q || e.name.toLowerCase().includes(q))
    )
    return sortEntries(filtered, sort, foldersFirst)
  }, [entries, sort, query, foldersFirst, showHidden])

  const path = browsers[sessionId]?.path ?? cwd
  const atRoot = path === cwd
  // Whether the viewed dir is still inside the session root (vs. escaped above it).
  const inRoot = path === cwd || path.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)
  const fullOf = (name: string) => (path === '/' ? `/${name}` : `${path}/${name}`)

  const refresh = () => window.api.fs.readDir(path).then(setEntries)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.fs.readDir(path).then((list) => {
      if (cancelled) return
      setEntries(list)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [path])

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const rel = inRoot && !atRoot ? path.slice(cwd.length).replace(/^\/+/, '') : ''
  // Within the root, show "rootName/sub/dir"; once escaped above it, the abs path.
  const label = inRoot ? `${cwd.split('/').pop()}${rel ? `/${rel}` : ''}` : path

  // Up now walks the whole filesystem (down to "/"); Home jumps back to the root.
  const goUp = () => {
    if (path === '/') return
    navigate(sessionId, path.slice(0, path.lastIndexOf('/')) || '/')
  }

  const goHome = () => navigate(sessionId, cwd)

  const onEntry = async (e: DirEntry) => {
    const full = fullOf(e.name)
    if (e.isDir) {
      navigate(sessionId, full)
      return
    }
    if (isNotebook(e.name)) {
      // Open natively in the main column (loads cells + attaches/reuses a kernel).
      openFile(sessionId, full, true)
      await openNotebook(full)
      return
    }
    // Open in the main column too — code/text gets a syntax-highlighted editor,
    // images a preview. In-app render so it works over VNC on remote launches.
    openFile(sessionId, full, false)
  }

  const createNotebook = async () => {
    // Auto-name like Jupyter (Untitled.ipynb, Untitled1.ipynb, …) since Electron
    // has no window.prompt; pick the first name not already in this directory.
    const taken = new Set(entries.map((e) => e.name))
    let name = 'Untitled.ipynb'
    for (let i = 1; taken.has(name); i++) name = `Untitled${i}.ipynb`
    const full = `${path}/${name}`
    const res = await window.api.fs.writeFile(full, emptyNotebookJSON())
    if (!res.ok) { window.alert(`Could not create notebook: ${res.error}`); return }
    await refresh()
    openFile(sessionId, full, true)
    await openNotebook(full)
  }

  // ---- Context menu + clipboard operations -------------------------------

  const openMenu = (ev: React.MouseEvent, entry: DirEntry | null) => {
    ev.preventDefault()
    ev.stopPropagation()
    // Beat the global (terminal) context menu listening on `document`.
    ev.nativeEvent.stopImmediatePropagation()
    const MENU_W = 160, MENU_H = 210
    setMenu({
      x: Math.min(ev.clientX, window.innerWidth - MENU_W),
      y: Math.min(ev.clientY, window.innerHeight - MENU_H),
      entry,
    })
  }

  const doDelete = async (e: DirEntry) => {
    setMenu(null)
    if (!window.confirm(`Move "${e.name}" to Trash?`)) return
    const res = await window.api.fs.delete(fullOf(e.name))
    if (!res.ok) { window.alert(`Delete failed: ${res.error}`); return }
    await refresh()
  }

  const doPaste = async (destDir: string) => {
    setMenu(null)
    if (!clipboard) return
    const res = clipboard.mode === 'copy'
      ? await window.api.fs.copy(clipboard.path, destDir)
      : await window.api.fs.move(clipboard.path, destDir)
    if (!res.ok) { window.alert(`Paste failed: ${res.error}`); return }
    if (clipboard.mode === 'cut') setClipboard(null)
    await refresh()
  }

  // ---- Inline create / rename --------------------------------------------

  const startNew = (mode: 'newFile' | 'newFolder') => { setMenu(null); setEditing({ mode }) }
  const startRename = (e: DirEntry) => { setMenu(null); setEditing({ mode: 'rename', original: e.name }) }

  const commitRename = async (original: string, name: string) => {
    setEditing(null)
    if (!name || name === original) return
    const oldPath = fullOf(original)
    const res = await window.api.fs.rename(oldPath, name)
    if (!res.ok) { window.alert(`Rename failed: ${res.error}`); return }
    // Make any open tabs (and a renamed notebook's loaded cells/kernel) follow.
    const newPath = fullOf(name)
    renamePath(oldPath, newPath)
    renameNotebookPath(oldPath, newPath)
    await refresh()
  }

  const commitNew = async (mode: 'newFile' | 'newFolder', name: string) => {
    setEditing(null)
    if (!name) return
    try {
      const res = mode === 'newFolder'
        ? await window.api.fs.mkdir(fullOf(name))
        : await window.api.fs.createFile(fullOf(name))
      if (!res.ok) { window.alert(`Could not create: ${res.error}`); return }
      await refresh()
    } catch (err) {
      window.alert(`Could not create: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---- Drag-in from the OS -----------------------------------------------

  // Only works for local launches — over VNC the bytes don't cross machines, so
  // use copy+paste instead.
  const onDrop = async (ev: React.DragEvent) => {
    ev.preventDefault()
    setDragOver(false)
    const files = Array.from(ev.dataTransfer.files)
    if (files.length === 0) return
    try {
      let failed = 0
      for (const f of files) {
        const src = window.api.fs.pathForFile(f)
        if (!src) { failed++; continue }
        const res = await window.api.fs.copy(src, path)
        if (!res.ok) failed++
      }
      await refresh()
      if (failed) {
        window.alert(`${failed} item(s) couldn't be copied. Dragging files from another machine over VNC isn't supported — copy them onto this machine first.`)
      }
    } catch (err) {
      window.alert(`Drop failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const onDragOver = (ev: React.DragEvent) => {
    if (!Array.from(ev.dataTransfer.types).includes('Files')) return
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  const newRow = editing && editing.mode !== 'rename'

  return (
    <div className="flex flex-col h-full bg-ctp-base border-l border-ctp-surface0 overflow-hidden">
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <button
          onClick={goUp}
          disabled={path === '/'}
          title="Up"
          className="flex items-center justify-center w-5 h-5 rounded text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
        <button
          onClick={goHome}
          disabled={atRoot}
          title="Back to session folder"
          className={`flex items-center justify-center w-5 h-5 rounded hover:bg-ctp-surface0 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent ${inRoot ? 'text-ctp-subtext hover:text-ctp-text' : 'text-ctp-yellow hover:text-ctp-yellow'}`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 11l9-8 9 8" />
            <path d="M5 10v10h14V10" />
          </svg>
        </button>
        <span className={`flex-1 text-xs truncate ${inRoot ? 'text-ctp-subtext' : 'text-ctp-yellow'}`} title={path}>
          {label}
        </span>
        <HeaderButton onClick={() => startNew('newFile')} title="New file">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6M12 12v6M9 15h6" />
          </svg>
        </HeaderButton>
        <HeaderButton onClick={() => startNew('newFolder')} title="New folder">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="M12 11v4M10 13h4" />
          </svg>
        </HeaderButton>
        <HeaderButton onClick={createNotebook} title="New notebook">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <path d="M12 7v6M9 10h6" />
          </svg>
        </HeaderButton>
      </div>

      {/* Filter box */}
      <div className="shrink-0 px-2 py-1 bg-ctp-mantle border-b border-ctp-surface0">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="w-full bg-ctp-surface0 text-ctp-text text-[11px] px-2 py-0.5 rounded outline-none placeholder:text-ctp-overlay focus:ring-1 focus:ring-ctp-blue"
        />
      </div>

      {/* Sort bar + view toggles */}
      <SortBar
        sort={sort}
        onChange={setSort}
        foldersFirst={foldersFirst}
        onFoldersFirst={() => setFoldersFirst((v) => !v)}
        showHidden={showHidden}
        onShowHidden={() => setShowHidden((v) => !v)}
      />

      {/* List — also the drop target for dragging files in from the OS, and the
          background context-menu target (paste / new into the current folder). */}
      <div
        className={`flex-1 overflow-y-auto py-1 select-none ${dragOver ? 'ring-2 ring-inset ring-ctp-blue bg-ctp-surface0/40' : ''}`}
        onContextMenu={(ev) => openMenu(ev, null)}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {newRow && (
          <div className="flex items-center gap-2 px-3 py-1 text-xs">
            <EntryIcon isDir={editing!.mode === 'newFolder'} isNb={false} />
            <InlineInput
              initial=""
              placeholder={editing!.mode === 'newFolder' ? 'Folder name' : 'File name'}
              onCommit={(name) => commitNew(editing!.mode as 'newFile' | 'newFolder', name)}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}

        {loading ? null : sorted.length === 0 && !newRow ? (
          <div className="px-3 py-2 text-xs text-ctp-overlay">
            {dragOver ? 'Drop to copy here' : query.trim() ? 'No matches' : 'Empty folder'}
          </div>
        ) : (
          sorted.map((e) => {
            if (editing?.mode === 'rename' && editing.original === e.name) {
              return (
                <div key={e.name} className="flex items-center gap-2 px-3 py-1 text-xs">
                  <EntryIcon isDir={e.isDir} isNb={isNotebook(e.name)} />
                  <InlineInput
                    initial={e.name}
                    onCommit={(name) => commitRename(e.name, name)}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              )
            }
            const cut = clipboard?.mode === 'cut' && clipboard.path === fullOf(e.name)
            return (
              <button
                key={e.name}
                onDoubleClick={e.isDir ? undefined : () => onEntry(e)}
                onClick={e.isDir ? () => onEntry(e) : undefined}
                onContextMenu={(ev) => openMenu(ev, e)}
                title={e.isDir || isNotebook(e.name) ? `Open ${e.name}` : `Preview ${e.name}`}
                className={`w-full flex items-center gap-2 px-3 py-1 text-xs text-left text-ctp-text hover:bg-ctp-surface0 ${cut ? 'opacity-50' : ''}`}
              >
                <EntryIcon isDir={e.isDir} isNb={isNotebook(e.name)} />
                <span className="truncate flex-1">{e.name}</span>
                {sort.key === 'size' && !e.isDir && (
                  <span className="shrink-0 text-[10px] text-ctp-overlay tabular-nums">{humanSize(e.size)}</span>
                )}
                {sort.key === 'modified' && (
                  <span className="shrink-0 text-[10px] text-ctp-overlay tabular-nums">{shortDate(e.mtimeMs)}</span>
                )}
              </button>
            )
          })
        )}
      </div>

      {menu && (
        <FileMenu
          menu={menu}
          hasClipboard={!!clipboard}
          pasteDir={menu.entry?.isDir ? fullOf(menu.entry.name) : path}
          onCopy={(e) => { setClipboard({ path: fullOf(e.name), mode: 'copy' }); setMenu(null) }}
          onCut={(e) => { setClipboard({ path: fullOf(e.name), mode: 'cut' }); setMenu(null) }}
          onRename={startRename}
          onDelete={doDelete}
          onPaste={doPaste}
          onNewFile={() => startNew('newFile')}
          onNewFolder={() => startNew('newFolder')}
        />
      )}
    </div>
  )
}

const SORT_LABELS: Record<SortKey, string> = { name: 'Name', size: 'Size', modified: 'Modified', type: 'Type' }

interface SortBarProps {
  sort: Sort
  onChange: (s: Sort) => void
  foldersFirst: boolean
  onFoldersFirst: () => void
  showHidden: boolean
  onShowHidden: () => void
}

// Clicking the active key flips direction; clicking another switches to it (asc).
function SortBar({ sort, onChange, foldersFirst, onFoldersFirst, showHidden, onShowHidden }: SortBarProps) {
  const pick = (key: SortKey) =>
    onChange(key === sort.key ? { key, dir: (sort.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 })
  return (
    <div className="h-6 shrink-0 flex items-center gap-1 px-2 bg-ctp-mantle border-b border-ctp-surface0 text-[10px]">
      <span className="text-ctp-overlay mr-0.5">Sort</span>
      {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => {
        const active = sort.key === key
        return (
          <button
            key={key}
            onClick={() => pick(key)}
            title={`Sort by ${SORT_LABELS[key].toLowerCase()}`}
            className={`px-1.5 py-0.5 rounded transition-colors ${active ? 'text-ctp-blue bg-ctp-surface0' : 'text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0'}`}
          >
            {SORT_LABELS[key]}{active && (sort.dir === 1 ? ' ↑' : ' ↓')}
          </button>
        )
      })}
      <div className="flex-1" />
      <Toggle on={foldersFirst} onClick={onFoldersFirst} title="Group folders first">📁</Toggle>
      <Toggle on={showHidden} onClick={onShowHidden} title="Show hidden files (dotfiles)">.*</Toggle>
    </div>
  )
}

function Toggle({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-1.5 py-0.5 rounded transition-colors ${on ? 'text-ctp-blue bg-ctp-surface0' : 'text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0'}`}
    >
      {children}
    </button>
  )
}

function EntryIcon({ isDir, isNb }: { isDir: boolean; isNb: boolean }) {
  if (isDir) {
    return (
      <svg className="shrink-0 text-ctp-blue" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    )
  }
  if (isNb) {
    return (
      <svg className="shrink-0 text-ctp-peach" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    )
  }
  return (
    <svg className="shrink-0 text-ctp-overlay" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

function HeaderButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center justify-center w-5 h-5 rounded text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0"
    >
      {children}
    </button>
  )
}

// Inline text field for renaming / naming a new entry. Commits on Enter or blur,
// cancels on Escape; the `done` guard stops Enter→blur from firing twice.
function InlineInput({ initial, placeholder, onCommit, onCancel }: {
  initial: string
  placeholder?: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(value.trim())
    else onCancel()
  }
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true) }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
      }}
      onBlur={() => finish(true)}
      className="flex-1 min-w-0 bg-ctp-surface0 text-ctp-text text-xs px-1 py-0.5 rounded outline-none border border-ctp-blue"
    />
  )
}

interface MenuProps {
  menu: Menu
  hasClipboard: boolean
  pasteDir: string
  onCopy: (e: DirEntry) => void
  onCut: (e: DirEntry) => void
  onRename: (e: DirEntry) => void
  onDelete: (e: DirEntry) => void
  onPaste: (destDir: string) => void
  onNewFile: () => void
  onNewFolder: () => void
}

function FileMenu({ menu, hasClipboard, pasteDir, onCopy, onCut, onRename, onDelete, onPaste, onNewFile, onNewFolder }: MenuProps) {
  const { entry } = menu
  const pasteLabel = entry?.isDir ? `Paste into "${entry.name}"` : 'Paste'
  return (
    <div
      style={{ top: menu.y, left: menu.x }}
      className="fixed z-50 w-40 bg-ctp-surface0 border border-ctp-surface1 rounded shadow-lg py-1 select-none"
      onClick={(e) => e.stopPropagation()}
    >
      {entry ? (
        <>
          <Item onClick={() => onCopy(entry)}>Copy</Item>
          <Item onClick={() => onCut(entry)}>Cut</Item>
          <Item onClick={() => onRename(entry)}>Rename</Item>
          <Item disabled={!hasClipboard} onClick={() => onPaste(pasteDir)}>{pasteLabel}</Item>
          <div className="mx-2 my-0.5 border-t border-ctp-surface1" />
          <Item danger onClick={() => onDelete(entry)}>Delete</Item>
        </>
      ) : (
        <>
          <Item onClick={onNewFile}>New File</Item>
          <Item onClick={onNewFolder}>New Folder</Item>
          <div className="mx-2 my-0.5 border-t border-ctp-surface1" />
          <Item disabled={!hasClipboard} onClick={() => onPaste(pasteDir)}>{pasteLabel}</Item>
        </>
      )}
    </div>
  )
}

function Item({ children, onClick, disabled, danger }: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-default ${
        danger ? 'text-ctp-red hover:bg-ctp-surface1' : 'text-ctp-text hover:bg-ctp-surface1'
      }`}
    >
      {children}
    </button>
  )
}
