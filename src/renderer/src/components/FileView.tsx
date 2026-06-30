import { useEffect, useState } from 'react'
import type { FilePreview as Preview } from '../../../shared/types'
import { CodeEditor } from './CodeEditor'

interface Props {
  path: string
  // Reports unsaved-edit state up so the tab can show a dirty dot and confirm on
  // close. Optional so the component still works standalone.
  onDirtyChange?: (dirty: boolean) => void
}

// File opened as a tab in the main column (non-notebook). Mirrors NotebookView's
// look so every file type shares the same slot: text/code is an editable, syntax-
// highlighted editor; images preview inline; binaries fall back to the OS app.
// Renders inside the Electron window (via IPC), so it travels over VNC for
// remote launches — no external viewer / window manager required.
export function FileView({ path, onDirtyChange }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null)

  // Load (and reload on path change) from disk, mirroring how NotebookView is
  // driven purely by its `path`.
  useEffect(() => {
    let cancelled = false
    setPreview(null)
    window.api.fs.readFile(path).then((data) => {
      if (!cancelled) setPreview(data)
    })
    return () => { cancelled = true }
  }, [path])

  const name = path.split('/').pop() ?? path
  const isText = preview?.kind === 'text'
  const editable = isText && !preview.truncated

  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = editable && content !== savedContent

  // Keep the tab's dirty indicator / close-confirm in sync.
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // Clear the dirty flag if this view unmounts (e.g. the tab is closed).
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  // Seed editor state once the text loads.
  useEffect(() => {
    if (preview?.kind === 'text') {
      setContent(preview.text)
      setSavedContent(preview.text)
    }
    setError(null)
  }, [preview])

  const save = async () => {
    if (!editable || !dirty || saving) return
    setSaving(true)
    setError(null)
    const res = await window.api.fs.writeFile(path, content)
    setSaving(false)
    if (res.ok) setSavedContent(content)
    else setError(res.error)
  }

  // Ctrl/Cmd+S saves. Re-bound each render so it sees current `dirty`/`content`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!preview) {
    return (
      <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
          <span className="text-xs text-ctp-subtext truncate" title={path}>{name}</span>
        </div>
        <p className="text-xs text-ctp-overlay text-center pt-8">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className="text-xs text-ctp-text truncate flex-1" title={path}>
          {preview.name}
          {dirty && <span className="text-ctp-yellow" title="Unsaved changes"> ●</span>}
        </span>

        {error && <span className="text-[10px] text-ctp-red shrink-0" title={error}>save failed</span>}
        {isText && preview.truncated && (
          <span className="text-[10px] text-ctp-yellow shrink-0">truncated · read-only</span>
        )}
        {editable && (
          <button
            onClick={save}
            disabled={!dirty || saving}
            title="Save (Ctrl/Cmd+S)"
            className="text-[11px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto min-h-0">
        {preview.kind === 'image' && (
          <div className="flex items-center justify-center p-4 h-full">
            <img
              src={preview.dataUrl}
              alt={preview.name}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        )}

        {preview.kind === 'pdf' && (
          <iframe
            src={preview.dataUrl}
            title={preview.name}
            className="w-full h-full border-0"
          />
        )}

        {preview.kind === 'text' && (
          <CodeEditor
            initialDoc={preview.text}
            filename={preview.name}
            readOnly={!editable}
            onChange={setContent}
            onSave={save}
          />
        )}

        {(preview.kind === 'binary' || preview.kind === 'error') && (
          <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
            <span className="text-xs text-ctp-subtext">
              {preview.kind === 'error'
                ? `Couldn't read this file: ${preview.message}`
                : 'No in-app preview for this file type.'}
            </span>
            {preview.kind === 'binary' && (
              <button
                onClick={() => window.api.shell.openPath(path)}
                className="text-xs px-3 py-1 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1"
              >
                Open with default app
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
