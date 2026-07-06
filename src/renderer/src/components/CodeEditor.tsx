import { forwardRef, useEffect, useImperativeHandle, useRef, type RefObject } from 'react'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
} from '@codemirror/view'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { editorTheme, editorHighlight } from '../lib/editorTheme'
import { languageForFilename } from '../lib/codeLanguages'

// Imperative controls a host toolbar can drive (see EditorTools). Keyboard
// shortcuts for the same actions are always wired regardless of the toolbar.
export interface EditorHandle {
  undo: () => void
  redo: () => void
  openSearch: () => void
  focus: () => void
}

interface Props {
  initialDoc: string
  filename: string
  readOnly: boolean
  onChange: (text: string) => void
  onSave: () => void
  // Bump `externalDocVersion` to force the editor's content to `externalDoc`
  // (e.g. a live reload after an app-control edit changed the file on disk).
  externalDoc?: string
  externalDocVersion?: number
  // Soft-wrap long lines (default true). Toggled live via the toolbar.
  wrap?: boolean
  // Extra CodeMirror extensions (e.g. diff line colouring). Read once at mount,
  // so pass a stable value.
  extensions?: Extension[]
}

// A CodeMirror editor for file previews: syntax-highlighted by filename,
// editable (unless readOnly), with Cmd/Ctrl-S save, undo/redo history, find &
// replace (Cmd/Ctrl-F), bracket matching + auto-close, code folding, and live
// word-wrap toggling. Imperative actions are exposed via ref for a host toolbar.
export const CodeEditor = forwardRef<EditorHandle, Props>(function CodeEditor(
  { initialDoc, filename, readOnly, onChange, onSave, externalDoc, externalDocVersion, wrap = true, extensions },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep callbacks in a ref so the editor is built once, not on every render.
  const cbRef = useRef({ onChange, onSave })
  cbRef.current = { onChange, onSave }
  // A compartment lets us reconfigure line wrapping without rebuilding the editor.
  const wrapComp = useRef(new Compartment()).current

  useImperativeHandle(ref, () => ({
    undo: () => { const v = viewRef.current; if (v) { undo(v); v.focus() } },
    redo: () => { const v = viewRef.current; if (v) { redo(v); v.focus() } },
    openSearch: () => { const v = viewRef.current; if (v) { openSearchPanel(v); v.focus() } },
    focus: () => viewRef.current?.focus(),
  }), [wrapComp])

  useEffect(() => {
    if (!hostRef.current) return
    const lang = languageForFilename(filename)
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          foldGutter(),
          drawSelection(),
          history(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          highlightSelectionMatches(),
          search({ top: true }),
          ...(lang ? [lang] : []),
          ...(extensions ?? []),
          editorTheme,
          editorHighlight,
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { cbRef.current.onSave(); return true } },
            indentWithTab,
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbRef.current.onChange(u.state.doc.toString())
          }),
          wrapComp.of(wrap ? EditorView.lineWrapping : []),
        ],
      }),
      parent: hostRef.current,
    })
    viewRef.current = view
    view.focus()
    return () => { view.destroy(); viewRef.current = null }
    // Build once per mounted file; initialDoc/filename are stable for a preview.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle soft-wrap live via the compartment (no rebuild, edits/history intact).
  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap, wrapComp])

  // Replace the whole document when the caller signals an external update. Guarded
  // on version (not value) so it only fires on an explicit reload, never on typing.
  useEffect(() => {
    const view = viewRef.current
    if (!view || externalDoc == null) return
    if (view.state.doc.toString() === externalDoc) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: externalDoc } })
  }, [externalDocVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="h-full overflow-auto" />
})

// A compact toolbar of editor actions, shared by the file/virtual views. `editor`
// is the CodeEditor's ref; `wrap`/`onToggleWrap` control soft-wrap (kept in the
// host so the button reflects state). Undo/redo are always enabled — a no-op when
// there's nothing to undo, matching how most editors present them.
export function EditorTools({ editor, wrap, onToggleWrap }: {
  editor: RefObject<EditorHandle | null>
  wrap: boolean
  onToggleWrap: () => void
}) {
  const btn = 'text-xs w-6 h-6 flex items-center justify-center rounded bg-ctp-surface0 text-ctp-subtext hover:bg-ctp-surface1 hover:text-ctp-text'
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button className={btn} title="Undo (Ctrl/Cmd+Z)" onClick={() => editor.current?.undo()}>↶</button>
      <button className={btn} title="Redo (Ctrl/Cmd+Shift+Z)" onClick={() => editor.current?.redo()}>↷</button>
      <button className={btn} title="Find / replace (Ctrl/Cmd+F)" onClick={() => editor.current?.openSearch()}>⌕</button>
      <button
        className={`${btn} ${wrap ? 'text-ctp-blue' : ''}`}
        title={wrap ? 'Word wrap: on' : 'Word wrap: off'}
        onClick={onToggleWrap}
      >
        ⏎
      </button>
    </div>
  )
}
