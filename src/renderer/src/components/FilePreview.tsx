import { useEffect, useState } from 'react'
import type { FilePreview as Preview } from '../../../shared/types'
import { CodeEditor } from './CodeEditor'

interface Props {
  preview: Preview
  path: string
  onClose: () => void
  // Fall back to the OS default app (used for binaries we can't render in-app).
  onOpenExternal: () => void
}

// Full-window overlay that renders the file inside the Electron window, so it
// travels over VNC for remote launches — no external viewer / WM required.
// Text files are editable and saved back to disk via fs:writeFile.
export function FilePreview({ preview, path, onClose, onOpenExternal }: Props) {
  const isText = preview.kind === 'text'
  const editable = isText && !preview.truncated

  const [content, setContent] = useState(isText ? preview.text : '')
  const [savedContent, setSavedContent] = useState(isText ? preview.text : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = editable && content !== savedContent

  const save = async () => {
    if (!editable || !dirty || saving) return
    setSaving(true)
    setError(null)
    const res = await window.api.fs.writeFile(path, content)
    setSaving(false)
    if (res.ok) setSavedContent(content)
    else setError(res.error)
  }

  const requestClose = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }) // re-bind each render so the handler sees current `dirty`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
      onClick={requestClose}
    >
      <div
        className="flex flex-col max-w-[90vw] max-h-[90vh] w-full bg-ctp-base border border-ctp-surface0 rounded-md shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
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
          <button
            onClick={requestClose}
            title="Close (Esc)"
            className="flex items-center justify-center w-5 h-5 rounded text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
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
                  onClick={onOpenExternal}
                  className="text-xs px-3 py-1 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1"
                >
                  Open with default app
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
