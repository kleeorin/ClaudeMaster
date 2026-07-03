import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { editorTheme, editorHighlight } from '../lib/editorTheme'
import { languageForFilename } from '../lib/codeLanguages'

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
}

// A CodeMirror editor for file previews: syntax-highlighted by filename,
// editable (unless readOnly), with Cmd/Ctrl-S wired to onSave.
export function CodeEditor({ initialDoc, filename, readOnly, onChange, onSave, externalDoc, externalDocVersion }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep callbacks in a ref so the editor is built once, not on every render.
  const cbRef = useRef({ onChange, onSave })
  cbRef.current = { onChange, onSave }

  useEffect(() => {
    if (!hostRef.current) return
    const lang = languageForFilename(filename)
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          ...(lang ? [lang] : []),
          editorTheme,
          editorHighlight,
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { cbRef.current.onSave(); return true } },
            indentWithTab,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbRef.current.onChange(u.state.doc.toString())
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent: hostRef.current,
    })
    viewRef.current = view
    view.focus()
    return () => { view.destroy(); viewRef.current = null }
    // Build once per mounted file; initialDoc/filename are stable for a preview.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Replace the whole document when the caller signals an external update. Guarded
  // on version (not value) so it only fires on an explicit reload, never on typing.
  useEffect(() => {
    const view = viewRef.current
    if (!view || externalDoc == null) return
    if (view.state.doc.toString() === externalDoc) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: externalDoc } })
  }, [externalDocVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="h-full overflow-auto" />
}
