import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { Cell as CellData } from '../../store/notebooks'
import { Output } from './Output'

const editorTheme = EditorView.theme({
  '&': { backgroundColor: '#181825', color: '#cdd6f4', borderRadius: '4px' },
  '.cm-content': { padding: '8px 4px', fontFamily: '"JetBrains Mono","Fira Code",monospace', fontSize: '13px' },
  '.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: '#f5c2e7' },
  '.cm-selectionBackground, ::selection': { backgroundColor: '#45475a88 !important' },
  '.cm-activeLine': { backgroundColor: '#1e1e2e66' },
  '.cm-gutters': { backgroundColor: '#181825', borderRight: '1px solid #313244', color: '#585b70', minWidth: '2rem' },
  '.cm-activeLineGutter': { backgroundColor: '#1e1e2e66' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px' },
})

const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: '#6c7086', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#cba6f7' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a6e3a1' },
  { tag: tags.number, color: '#fab387' },
  { tag: tags.operator, color: '#89dceb' },
  { tag: tags.function(tags.variableName), color: '#89b4fa' },
  { tag: tags.className, color: '#f9e2af' },
  { tag: tags.bool, color: '#fab387' },
  { tag: tags.null, color: '#fab387' },
  { tag: tags.punctuation, color: '#cdd6f4' },
  { tag: tags.self, color: '#f38ba8' },
]))

interface Props {
  cell: CellData
  index: number
  onCodeChange: (code: string) => void
  onExecute: () => void
  onRemove: () => void
}

export function Cell({ cell, index, onCodeChange, onExecute, onRemove }: Props) {
  const editorRef = useRef<HTMLDivElement>(null)
  const cbRef = useRef({ onCodeChange, onExecute })
  cbRef.current = { onCodeChange, onExecute }

  useEffect(() => {
    if (!editorRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: cell.code,
        extensions: [
          lineNumbers(),
          python(),
          editorTheme,
          highlight,
          keymap.of([
            { key: 'Shift-Enter', run: () => { cbRef.current.onExecute(); return true } },
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbRef.current.onCodeChange(u.state.doc.toString())
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent: editorRef.current,
    })
    return () => view.destroy()
  }, [cell.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const countLabel = cell.running ? '*' : (cell.executionCount ?? ' ')

  return (
    <div className="group flex gap-2">
      <div className="w-12 shrink-0 text-right pt-2 text-xs text-ctp-overlay font-mono select-none">
        [{countLabel}]:
      </div>

      <div className="flex-1 min-w-0 space-y-1">
        <div className={`rounded border ${cell.running ? 'border-ctp-yellow' : 'border-ctp-surface1 focus-within:border-ctp-mauve'} transition-colors`}>
          <div ref={editorRef} />
        </div>

        {cell.outputs.length > 0 && (
          <div className="pl-1 border-l-2 border-ctp-surface1 space-y-1 py-1">
            {cell.outputs.map((o, i) => <Output key={i} output={o} />)}
          </div>
        )}
      </div>

      <button
        onClick={onRemove}
        className="opacity-0 group-hover:opacity-100 self-start mt-2 text-ctp-overlay hover:text-ctp-red transition-opacity text-xs px-0.5"
      >
        ✕
      </button>
    </div>
  )
}
