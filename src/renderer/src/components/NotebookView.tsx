import { useCallback, useEffect, useRef, useState } from 'react'
import { useNotebooks } from '../store/notebooks'
import { Cell } from './notebook/Cell'
import { RemoteDirPicker } from './RemoteDirPicker'
import { parseTarget } from '../../../shared/remotePath'
import type { RemoteConfig } from '../../../shared/types'

const STATUS_DOT: Record<string, string> = {
  idle:     'bg-ctp-green',
  busy:     'bg-ctp-yellow animate-pulse',
  starting: 'bg-ctp-overlay animate-pulse',
  dead:     'bg-ctp-red',
}

interface Props {
  path: string
  // Reports unsaved-edit state up so the tab can show a dirty dot and confirm on close.
  onDirtyChange?: (dirty: boolean) => void
}

export function NotebookView({ path, onDirtyChange }: Props) {
  const {
    notebooks, specs,
    addCell, insertCell, moveCell, setCellType, removeCell, updateCode, revealCell, executeCell,
    saveNotebook, setKernel, setKernelDir,
    runAll, restartAndRunAll, clearAllOutputs,
    interruptKernel, restartKernel, installAndRetry,
    checkExternalChange, reloadFromDisk, dismissConflict,
  } = useNotebooks()
  const [saveError, setSaveError] = useState<string | null>(null)
  // Pending remote directory pick (custom kernel env dir on a remote notebook).
  const [remotePick, setRemotePick] = useState<{ remote: RemoteConfig; initialDir: string } | null>(null)
  // Command-mode selection (Jupyter-style): set on click / Esc out of the editor.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const lastD = useRef(0)  // for the `dd` delete chord

  const onKernelChange = async (value: string) => {
    if (value === '__pick__') {
      // A remote notebook's kernel runs on the remote host, so its env directory
      // must be browsed there — Electron's native dialog is local-only. Fall back
      // to the native dialog for local notebooks (or if the remote is unknown).
      const { remoteId } = parseTarget(path)
      if (remoteId) {
        const remote = (await window.api.remotes.list()).find((r) => r.id === remoteId)
        if (remote) {
          const remotePath = parseTarget(path).path
          setRemotePick({ remote, initialDir: remotePath.slice(0, remotePath.lastIndexOf('/')) || '/' })
          return
        }
      }
      const dir = await window.api.dialog.openDir()
      if (dir) await setKernelDir(path, dir)
      return
    }
    await setKernel(path, value)
  }

  const nb = notebooks[path]

  const save = async () => {
    const res = await saveNotebook(path)
    setSaveError(res && !res.ok ? res.error : null)
  }

  // Focus a cell's CodeMirror editor by id (rAF retry covers a just-inserted cell).
  const focusCell = useCallback((id: string, retry = true) => {
    const el = document.querySelector(`[data-cell-id="${id}"] .cm-content`) as HTMLElement | null
    if (el) el.focus()
    else if (retry) requestAnimationFrame(() => focusCell(id, false))
  }, [])

  const enterCommandMode = useCallback((id: string) => {
    setSelectedId(id)
    listRef.current?.focus()
  }, [])

  // Scroll a cell into view + briefly flash it, so a change isn't missed off-screen
  // (a fresh cell, or a Claude/app edit). rAF retry covers a just-inserted cell not
  // yet in the DOM. Scoped to this pane's list so two panes on the same notebook
  // don't fight.
  const revealInView = useCallback((id: string, retry = true) => {
    const el = listRef.current?.querySelector(`[data-cell-id="${id}"]`) as HTMLElement | null
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      el.classList.remove('nb-flash')
      void el.offsetWidth  // reflow so re-adding the class restarts the animation
      el.classList.add('nb-flash')
    } else if (retry) {
      requestAnimationFrame(() => revealInView(id, false))
    }
  }, [])

  // Ctrl/Cmd+S saves. Re-bound each render so it sees the current notebook.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Keep the tab's dirty indicator / close-confirm in sync.
  useEffect(() => {
    onDirtyChange?.(nb?.dirty ?? false)
  }, [nb?.dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  // Watch the file for EXTERNAL writes (Bash, git, a sibling agent) — the
  // conflict backstop. Our own MCP edits are in-memory (no disk write) and our
  // own saves are echo-filtered in the store, so this only fires on real
  // outside changes: a clean pane adopts disk, a dirty pane shows the banner.
  useEffect(() => {
    window.api.fs.watch(path)
    const off = window.api.on.fileChanged((p) => { if (p === path) checkExternalChange(path) })
    return () => { off(); window.api.fs.unwatch(path) }
  }, [path, checkExternalChange])

  // The store asks us to jump to a cell (a new cell, an app-control edit from
  // Claude). The nonce changes even when the same cell is touched twice.
  useEffect(() => {
    if (nb?.reveal) revealInView(nb.reveal.cellId)
  }, [nb?.reveal?.nonce, revealInView]) // eslint-disable-line react-hooks/exhaustive-deps

  const name = path.split('/').pop()

  if (!nb) {
    return (
      <div className="flex flex-col h-full bg-ctp-base border-l border-ctp-surface0 overflow-hidden">
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
          <span className="text-xs text-ctp-subtext truncate" title={path}>{name}</span>
        </div>
        <p className="text-xs text-ctp-overlay text-center pt-8">Loading…</p>
      </div>
    )
  }

  const { cells, kernelStatus, kernelName, kernelCwd, dirty, conflict } = nb
  const isStarting = kernelStatus === 'starting'
  const isDead = kernelStatus === 'dead'
  const hasCells = cells.some((c) => c.type === 'code' && c.code.trim())
  // Reflect a pending choice from metadata before the kernel reports back.
  const selectedKernel = kernelName ?? (nb.meta.metadata?.kernelspec as { name?: string } | undefined)?.name ?? ''
  const dropdownValue = kernelCwd ? '__custom__' : selectedKernel
  const customDirName = kernelCwd ? (kernelCwd.split('/').filter(Boolean).pop() ?? kernelCwd) : ''

  // Shift+Enter: run, then move to the next cell (creating one if at the end).
  const runAdvance = (i: number, id: string) => {
    executeCell(path, id)
    if (i < cells.length - 1) focusCell(cells[i + 1].id)
    else { const nid = insertCell(path, 'code', cells.length); focusCell(nid); revealCell(path, nid) }
  }

  // "+ code" / "+ md": insert right AFTER the cell you're in (the selected one,
  // which is set on cell mousedown), matching Jupyter's `b` — not at the very end.
  // Falls back to appending when nothing is selected. Focus + select the new cell.
  const addAfterCurrent = (type: 'code' | 'markdown') => {
    const idx = selectedId ? cells.findIndex((c) => c.id === selectedId) : -1
    const id = insertCell(path, type, idx >= 0 ? idx + 1 : cells.length)
    setSelectedId(id)
    focusCell(id)
    revealCell(path, id)
  }

  // Command-mode keys, active only when the cell list (not an editor) has focus.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('.cm-editor')) return  // editing — let CodeMirror handle it
    if (!selectedId) return
    const idx = cells.findIndex((c) => c.id === selectedId)
    if (idx < 0) return
    const select = (j: number) => { const c = cells[j]; if (c) setSelectedId(c.id) }

    switch (e.key) {
      case 'ArrowDown': case 'j': e.preventDefault(); select(idx + 1); break
      case 'ArrowUp':   case 'k': e.preventDefault(); select(idx - 1); break
      case 'Enter':               e.preventDefault(); focusCell(selectedId); break
      case 'a': { e.preventDefault(); const id = insertCell(path, 'code', idx); setSelectedId(id); revealCell(path, id); break }
      case 'b': { e.preventDefault(); const id = insertCell(path, 'code', idx + 1); setSelectedId(id); revealCell(path, id); break }
      case 'm': e.preventDefault(); setCellType(path, selectedId, 'markdown'); break
      case 'y': e.preventDefault(); setCellType(path, selectedId, 'code'); break
      case 'd': {
        e.preventDefault()
        const now = Date.now()
        if (now - lastD.current < 500) {
          lastD.current = 0
          removeCell(path, selectedId)
          const next = cells[idx + 1] ?? cells[idx - 1]
          setSelectedId(next ? next.id : null)
        } else {
          lastD.current = now
        }
        break
      }
    }
  }

  return (
    <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
      {remotePick && (
        <RemoteDirPicker
          remote={remotePick.remote}
          initialDir={remotePick.initialDir}
          title="Kernel environment directory"
          onChoose={(dir) => { setRemotePick(null); void setKernelDir(path, dir) }}
          onCancel={() => setRemotePick(null)}
        />
      )}
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[kernelStatus ?? 'dead']}`} />
        <span className="text-xs text-ctp-text truncate" title={path}>
          {name}
          {dirty && <span className="text-ctp-yellow" title="Unsaved changes"> ●</span>}
        </span>

        <select
          value={dropdownValue}
          onChange={(e) => onKernelChange(e.target.value)}
          disabled={isStarting}
          title={kernelCwd ? `Custom env dir: ${kernelCwd}` : 'Kernel / environment'}
          className="text-[10px] bg-ctp-surface0 text-ctp-subtext rounded px-1 py-0.5 max-w-[160px] outline-none hover:text-ctp-text disabled:opacity-50"
        >
          {specs.length === 0 && !kernelCwd && <option value="">{selectedKernel || 'kernel'}</option>}
          {specs.map((s) => (
            <option key={s.name} value={s.name}>{s.displayName}</option>
          ))}
          {kernelCwd && <option value="__custom__">📁 {customDirName}</option>}
          <option value="__pick__">Custom directory…</option>
        </select>
        <span className="text-[10px] text-ctp-overlay shrink-0">
          {isDead ? 'unavailable' : kernelStatus}
        </span>
        {saveError && <span className="text-[10px] text-ctp-red shrink-0" title={saveError}>save failed</span>}

        <div className="flex-1" />

        {kernelStatus === 'busy' && (
          <button onClick={() => interruptKernel(path)} className="text-xs text-ctp-overlay hover:text-ctp-red px-1.5 py-0.5 rounded transition-colors">
            interrupt
          </button>
        )}
        <button onClick={() => runAll(path)} disabled={!hasCells || kernelStatus !== 'idle'} title="Run all cells" className="text-xs text-ctp-green hover:text-ctp-text hover:bg-ctp-surface0 px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent">
          ▶ run all
        </button>
        <button onClick={() => restartAndRunAll(path)} disabled={!hasCells || isStarting} title="Restart kernel and run all cells" className="text-xs text-ctp-overlay hover:text-ctp-text px-1.5 py-0.5 rounded transition-colors disabled:opacity-40">
          ⟳ run all
        </button>
        <button onClick={() => clearAllOutputs(path)} disabled={!hasCells} title="Clear all outputs" className="text-xs text-ctp-overlay hover:text-ctp-text px-1.5 py-0.5 rounded transition-colors disabled:opacity-40">
          clear
        </button>
        <button onClick={() => restartKernel(path)} disabled={isStarting} className="text-xs text-ctp-overlay hover:text-ctp-text px-1.5 py-0.5 rounded transition-colors disabled:opacity-40">
          restart
        </button>
        <button onClick={() => addAfterCurrent('code')} title="Add code cell after the current one" className="text-xs text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 px-1.5 py-0.5 rounded transition-colors">
          + code
        </button>
        <button onClick={() => addAfterCurrent('markdown')} title="Add markdown cell after the current one" className="text-xs text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 px-1.5 py-0.5 rounded transition-colors">
          + md
        </button>
        <button onClick={save} disabled={!dirty} title="Save (Ctrl/Cmd+S)" className="text-xs px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
          Save
        </button>
      </div>

      {/* Conflict banner: the file changed on disk while this pane had unsaved
          edits. Never clobber silently — let the user choose. */}
      {conflict && (
        <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 bg-ctp-yellow/15 border-b border-ctp-yellow/40 text-xs text-ctp-yellow">
          <span className="flex-1">This notebook changed on disk while you have unsaved edits.</span>
          <button onClick={() => reloadFromDisk(path)} className="px-1.5 py-0.5 rounded hover:bg-ctp-yellow/20 transition-colors" title="Discard your edits and load the on-disk version">
            Reload from disk
          </button>
          <button onClick={() => dismissConflict(path)} className="px-1.5 py-0.5 rounded hover:bg-ctp-yellow/20 transition-colors" title="Keep your edits; the next save overwrites disk">
            Keep mine
          </button>
        </div>
      )}

      {/* Cells. tabIndex makes the list focusable so command-mode keys (a/b/dd/j/k)
          work after Esc-ing out of an editor. */}
      <div
        ref={listRef}
        tabIndex={-1}
        onKeyDown={onListKeyDown}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-4 outline-none"
      >
        {isStarting && cells.length === 1 && cells[0].code === '' ? (
          <p className="text-xs text-ctp-overlay text-center pt-8">Starting kernel…</p>
        ) : isDead ? (
          <div className="flex flex-col items-center gap-3 pt-8">
            <p className="text-xs text-ctp-red text-center">Could not start Jupyter kernel.</p>
            <button onClick={() => installAndRetry(path)} className="text-xs px-3 py-1.5 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 transition-colors">
              Install jupyter &amp; retry
            </button>
          </div>
        ) : null}

        {cells.map((cell, i) => (
          <Cell
            key={cell.id}
            cell={cell}
            index={i}
            selected={selectedId === cell.id}
            onSelect={() => setSelectedId(cell.id)}
            onCodeChange={(code) => updateCode(path, cell.id, code)}
            onRun={() => executeCell(path, cell.id)}
            onRunAdvance={() => runAdvance(i, cell.id)}
            onEscape={() => enterCommandMode(cell.id)}
            onInsertBelow={() => { executeCell(path, cell.id); const nid = insertCell(path, 'code', i + 1); focusCell(nid); revealCell(path, nid) }}
            onMoveUp={() => moveCell(path, i, i - 1)}
            onMoveDown={() => moveCell(path, i, i + 1)}
            onToggleType={() => setCellType(path, cell.id, cell.type === 'code' ? 'markdown' : 'code')}
            onRemove={() => removeCell(path, cell.id)}
            onReorder={(from) => moveCell(path, from, i)}
          />
        ))}

        {cells.length === 0 && (
          <button onClick={() => addCell(path, 'code')} className="w-full text-xs text-ctp-overlay hover:text-ctp-text text-center py-4 border border-dashed border-ctp-surface1 rounded transition-colors">
            + Add cell
          </button>
        )}
      </div>
    </div>
  )
}
