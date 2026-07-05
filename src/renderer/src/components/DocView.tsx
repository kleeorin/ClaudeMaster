import { useEffect, useRef, useState } from 'react'
import { CodeEditor } from './CodeEditor'
import { Markdown } from './Markdown'
import { onFileTouched } from '../lib/fileEvents'

type Mode = 'preview' | 'source' | 'split'

interface Props {
  path: string
  // The session's root dir, used to resolve/create wikilinks (repo docs/ + the
  // project's memory root). May be a remote:// path.
  rootDir: string
  onDirtyChange?: (dirty: boolean) => void
  // Open another doc as a tab (resolved/created wikilink target).
  onOpenDoc?: (path: string) => void
}

// A markdown file opened as a tab: rendered preview, editable source, or a split
// of both. Mirrors FileView's save / dirty / live-reload / conflict handling, but
// reads the FULL text (fs.readText, no preview size cap) and adds a mode toggle
// and clickable `[[wikilinks]]`. Plain .md edits need no funnel — Claude's native
// Edit writes to disk and we live-reload here, same as FileView.
export function DocView({ path, rootDir, onDirtyChange, onOpenDoc }: Props) {
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [reload, setReload] = useState(0)
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('cm.docMode') as Mode) || 'preview')
  const dirty = loaded && content !== savedContent

  const name = path.split('/').pop() ?? path
  const setModePersist = (m: Mode) => { localStorage.setItem('cm.docMode', m); setMode(m) }

  // Load (and reload on path change) the full text from disk.
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    window.api.fs.readText(path).then((res) => {
      if (cancelled) return
      if (res.ok) { setContent(res.text); setSavedContent(res.text); setError(null) }
      else setError(res.error)
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [path])

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    const res = await window.api.fs.writeFile(path, content)
    setSaving(false)
    if (res.ok) { setSavedContent(content); setConflict(false) }
    else setError(res.error)
  }

  const reloadFromDisk = async () => {
    const res = await window.api.fs.readText(path)
    if (!res.ok) { setError(res.error); return }
    setContent(res.text); setSavedContent(res.text); setConflict(false); setReload((v) => v + 1)
  }

  // React to an external write (Claude's Edit / a sibling process). Clean pane
  // adopts the change; dirty pane raises a conflict banner (don't clobber edits).
  useEffect(() => {
    return onFileTouched(path, () => {
      if (content !== savedContent) setConflict(true)
      else void reloadFromDisk()
    })
  }, [path, content, savedContent])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Wikilink click: resolve to an existing doc, else create it, then open the tab.
  const resolving = useRef(false)
  const openWikiLink = async (target: string) => {
    if (resolving.current || !onOpenDoc) return
    resolving.current = true
    try {
      const found = await window.api.docs.resolve(rootDir, path, target)
      if (found) { onOpenDoc(found); return }
      const created = await window.api.docs.create(rootDir, target)
      if (created.ok) onOpenDoc(created.path)
      else setError(created.error)
    } finally { resolving.current = false }
  }

  const showSource = mode !== 'preview'
  const showPreview = mode !== 'source'

  return (
    <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className="text-xs text-ctp-text truncate flex-1" title={path}>
          {name}
          {dirty && <span className="text-ctp-yellow" title="Unsaved changes"> ●</span>}
        </span>

        {error && <span className="text-[10px] text-ctp-red shrink-0" title={error}>error</span>}

        {/* Mode toggle */}
        <div className="flex items-stretch rounded overflow-hidden border border-ctp-surface0 text-[10px]">
          {(['preview', 'split', 'source'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setModePersist(m)}
              className={`px-2 py-0.5 capitalize ${mode === m ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-subtext hover:bg-ctp-surface0'}`}
            >
              {m}
            </button>
          ))}
        </div>

        <button
          onClick={save}
          disabled={!dirty || saving}
          title="Save (Ctrl/Cmd+S)"
          className="text-[11px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {conflict && (
        <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 bg-ctp-yellow/15 border-b border-ctp-yellow/40 text-[11px] text-ctp-text">
          <span className="flex-1">This doc was changed on disk (e.g. by Claude) while you had unsaved edits.</span>
          <button onClick={reloadFromDisk} className="px-2 py-0.5 rounded bg-ctp-surface0 hover:bg-ctp-surface1">Reload from disk</button>
          <button onClick={() => setConflict(false)} className="px-2 py-0.5 rounded bg-ctp-surface0 hover:bg-ctp-surface1">Keep mine</button>
        </div>
      )}

      {/* Body */}
      {!loaded ? (
        <p className="text-xs text-ctp-overlay text-center pt-8">Loading…</p>
      ) : (
        <div className="flex-1 flex overflow-hidden min-h-0">
          {showSource && (
            <div className={`min-w-0 min-h-0 overflow-hidden ${mode === 'split' ? 'w-1/2 border-r border-ctp-surface0' : 'flex-1'}`}>
              <CodeEditor
                initialDoc={content}
                filename={name}
                readOnly={false}
                onChange={setContent}
                onSave={save}
                externalDoc={content}
                externalDocVersion={reload}
              />
            </div>
          )}
          {showPreview && (
            <div className={`min-w-0 min-h-0 overflow-auto px-6 py-4 text-sm ${mode === 'split' ? 'w-1/2' : 'flex-1'}`}>
              <Markdown text={content} onWikiLink={openWikiLink} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
