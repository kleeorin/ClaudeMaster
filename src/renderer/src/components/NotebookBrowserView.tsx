import { useEffect, useState } from 'react'
import { useFileBrowser } from '../store/fileBrowser'
import { useNotebooks } from '../store/notebooks'
import type { KernelStatus } from '../lib/kernelClient'
import { KernelDot } from './FileBrowserView'

// Kernels we consider "live" — a notebook with one of these shows up here.
const LIVE: KernelStatus[] = ['starting', 'idle', 'busy']

// Is `path` inside (or equal to) the `root` directory subtree?
const isUnder = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

const STATUS_LABEL: Record<string, string> = {
  starting: 'starting…',
  idle: 'idle',
  busy: 'running',
}

interface Props {
  sessionId: string
  rootDir: string  // session root — only notebooks under here belong to this session
}

// Lists every notebook in this session that currently has a live kernel (a
// Jupyter-style "Running" panel). Clicking one opens/focuses its tab; the ⏻
// button shuts its kernel down.
export function NotebookBrowserView({ sessionId, rootDir }: Props) {
  const { notebooks, openNotebook, shutdownKernel } = useNotebooks()
  const { openFile } = useFileBrowser()
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)

  const live = Object.values(notebooks)
    .filter((nb) => nb.kernelStatus && LIVE.includes(nb.kernelStatus) && isUnder(nb.path, rootDir))
    .sort((a, b) => a.path.localeCompare(b.path))

  // Re-open the tab (idempotent if already open) and attach/reuse its kernel.
  const focus = (path: string) => {
    openFile(sessionId, path, true)
    void openNotebook(path)
  }

  const openMenu = (ev: React.MouseEvent, path: string) => {
    ev.preventDefault()
    ev.stopPropagation()
    ev.nativeEvent.stopImmediatePropagation()  // beat the global terminal context menu
    setMenu({ x: Math.min(ev.clientX, window.innerWidth - 160), y: ev.clientY, path })
  }

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

  const relDir = (path: string) => {
    const dir = path.slice(0, path.lastIndexOf('/'))
    const rel = isUnder(dir, rootDir) ? dir.slice(rootDir.length).replace(/^\/+/, '') : dir
    return rel || '.'
  }

  return (
    <div className="flex flex-col h-full bg-ctp-base border-l border-ctp-surface0 overflow-hidden">
      <div className="h-9 shrink-0 flex items-center px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className="text-xs text-ctp-subtext">
          Live kernels{live.length > 0 && <span className="text-ctp-overlay"> · {live.length}</span>}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-1 select-none">
        {live.length === 0 ? (
          <div className="px-3 py-2 text-xs text-ctp-overlay">No running kernels</div>
        ) : (
          live.map((nb) => (
            <div
              key={nb.path}
              onContextMenu={(ev) => openMenu(ev, nb.path)}
              className="group w-full flex items-center gap-2 px-3 py-1 text-xs text-ctp-text hover:bg-ctp-surface0"
            >
              <KernelDot status={nb.kernelStatus} />
              <button
                onClick={() => focus(nb.path)}
                title={`Open ${nb.path}`}
                className="flex-1 min-w-0 flex flex-col items-start text-left"
              >
                <span className="truncate max-w-full">{nb.path.split('/').pop()}</span>
                <span className="truncate max-w-full text-[10px] text-ctp-overlay">{relDir(nb.path)}</span>
              </button>
              <span className="shrink-0 text-[10px] text-ctp-overlay tabular-nums">
                {STATUS_LABEL[nb.kernelStatus!] ?? nb.kernelStatus}
              </span>
              <button
                onClick={() => void shutdownKernel(nb.path)}
                title="Shut down kernel"
                className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-ctp-overlay opacity-0 group-hover:opacity-100 hover:text-ctp-red hover:bg-ctp-surface1"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v10" />
                  <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>

      {menu && (
        <div
          style={{ top: menu.y, left: menu.x }}
          className="fixed z-50 w-40 bg-ctp-surface0 border border-ctp-surface1 rounded shadow-lg py-1 select-none text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { focus(menu.path); setMenu(null) }}
            className="w-full text-left px-3 py-1.5 text-ctp-text hover:bg-ctp-surface1"
          >
            Open
          </button>
          <div className="mx-2 my-0.5 border-t border-ctp-surface1" />
          <button
            onClick={() => { void shutdownKernel(menu.path); setMenu(null) }}
            className="w-full text-left px-3 py-1.5 text-ctp-red hover:bg-ctp-surface1"
          >
            Kill kernel
          </button>
        </div>
      )}
    </div>
  )
}
