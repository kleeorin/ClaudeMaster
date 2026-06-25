import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import type { Cell as CellData } from '../../store/notebooks'
import { editorTheme, editorHighlight } from '../../lib/editorTheme'
import { Output } from './Output'

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
          editorHighlight,
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
