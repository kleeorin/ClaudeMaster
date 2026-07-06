import { useEffect, useRef, useState } from 'react'
import type { VirtualDoc } from '../store/fileBrowser'
import { CodeEditor, EditorTools, type EditorHandle } from './CodeEditor'
import { diffHighlighting } from '../lib/diffHighlight'

interface Props {
  label: string          // tab caption, e.g. "foo.ts.diff"
  doc: VirtualDoc        // initial in-memory content (+ highlight hint)
  onDirtyChange?: (dirty: boolean) => void
  // Called after a successful "Save as…" with the chosen on-disk path, so the
  // host can swap this in-memory tab for the real file.
  onSavedAs?: (path: string) => void
}

// An in-memory tab in the main column: text that isn't backed by a file on disk
// (e.g. a git diff sent over from the git panel). It's fully editable and can be
// written to disk via "Save as…", at which point the host replaces it with the
// real file tab. Kept separate from FileView, which is wired directly to disk
// (read/write/live-reload/conflict) — none of which applies here.
export function VirtualFileView({ label, doc, onDirtyChange, onSavedAs }: Props) {
  const isDiff = (doc.language ?? label).toLowerCase().endsWith('.diff')
  const [content, setContent] = useState(doc.content)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<EditorHandle>(null)
  const [wrap, setWrap] = useState(true)
  // Dirty relative to the original in-memory content — the tab shows a dot and
  // confirms on close, matching FileView.
  const dirty = content !== doc.content

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const saveAs = async () => {
    if (saving) return
    setError(null)
    const path = await window.api.dialog.saveFile(label)
    if (!path) return
    setSaving(true)
    const res = await window.api.fs.writeFile(path, content)
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    // Clear dirty so closing the (about-to-be-replaced) tab doesn't prompt, then
    // hand off to the real file on disk.
    onDirtyChange?.(false)
    onSavedAs?.(path)
  }

  // Ctrl/Cmd+S triggers Save as… (re-bound each render for the current content).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveAs() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className="text-xs text-ctp-text truncate flex-1" title={label}>
          {label}
          <span className="ml-1.5 text-[10px] text-ctp-overlay">in memory</span>
          {dirty && <span className="text-ctp-yellow" title="Unsaved changes"> ●</span>}
        </span>
        {error && <span className="text-[10px] text-ctp-red shrink-0" title={error}>save failed</span>}
        <EditorTools editor={editorRef} wrap={wrap} onToggleWrap={() => setWrap((v) => !v)} />
        <button
          onClick={saveAs}
          disabled={saving}
          title="Save as… (Ctrl/Cmd+S)"
          className="text-[11px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save as…'}
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto min-h-0">
        <CodeEditor
          ref={editorRef}
          initialDoc={doc.content}
          filename={doc.language ?? label}
          readOnly={false}
          wrap={wrap}
          onChange={setContent}
          onSave={saveAs}
          extensions={isDiff ? [diffHighlighting] : undefined}
        />
      </div>
    </div>
  )
}
