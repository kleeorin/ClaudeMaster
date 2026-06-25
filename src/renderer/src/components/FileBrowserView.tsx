import { lazy, Suspense, useEffect, useState } from 'react'
import { useFileBrowser } from '../store/fileBrowser'
import type { DirEntry, FilePreview as Preview } from '../../../shared/types'

// Code-split: the editor pulls in all the CodeMirror language packs, so load it
// only when a file is actually previewed.
const FilePreview = lazy(() => import('./FilePreview').then(m => ({ default: m.FilePreview })))

interface Props {
  sessionId: string
  cwd: string  // session root — navigation is constrained to this subtree
}

export function FileBrowserView({ sessionId, cwd }: Props) {
  const { browsers, navigate } = useFileBrowser()
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ data: Preview; path: string } | null>(null)

  const path = browsers[sessionId]?.path ?? cwd
  const atRoot = path === cwd

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

  const rel = atRoot ? '' : path.slice(cwd.length).replace(/^\/+/, '')

  const goUp = () => {
    if (atRoot) return
    const parent = path.slice(0, path.lastIndexOf('/')) || '/'
    // Don't escape above the session root
    navigate(sessionId, parent.length < cwd.length ? cwd : parent)
  }

  const onEntry = async (e: DirEntry) => {
    const full = `${path}/${e.name}`
    if (e.isDir) {
      navigate(sessionId, full)
      return
    }
    // Preview in-app so it works over VNC on remote launches.
    setPreview({ data: await window.api.fs.readFile(full), path: full })
  }

  return (
    <div className="flex flex-col h-full bg-ctp-base border-l border-ctp-surface0 overflow-hidden">
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <button
          onClick={goUp}
          disabled={atRoot}
          title="Up"
          className="flex items-center justify-center w-5 h-5 rounded text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
        <span className="text-xs text-ctp-subtext truncate" title={path}>
          {cwd.split('/').pop()}{rel && `/${rel}`}
        </span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1 select-none">
        {loading ? null : entries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-ctp-overlay">Empty folder</div>
        ) : (
          entries.map((e) => (
            <button
              key={e.name}
              onDoubleClick={e.isDir ? undefined : () => onEntry(e)}
              onClick={e.isDir ? () => onEntry(e) : undefined}
              title={e.isDir ? `Open ${e.name}` : `Preview ${e.name}`}
              className="w-full flex items-center gap-2 px-3 py-1 text-xs text-left text-ctp-text hover:bg-ctp-surface0"
            >
              {e.isDir ? (
                <svg className="shrink-0 text-ctp-blue" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
              ) : (
                <svg className="shrink-0 text-ctp-overlay" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
              )}
              <span className="truncate">{e.name}</span>
            </button>
          ))
        )}
      </div>

      {preview && (
        <Suspense fallback={null}>
          <FilePreview
            key={preview.path}
            preview={preview.data}
            path={preview.path}
            onClose={() => setPreview(null)}
            onOpenExternal={() => {
              window.api.shell.openPath(preview.path)
              setPreview(null)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
