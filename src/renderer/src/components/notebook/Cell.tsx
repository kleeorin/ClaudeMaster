import { useEffect, useRef, useState } from 'react'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import type { Cell as CellData } from '../../store/notebooks'
import { editorTheme, editorHighlight } from '../../lib/editorTheme'
import { Output } from './Output'

interface Props {
  cell: CellData
  index: number
  selected: boolean
  onSelect: () => void
  onCodeChange: (code: string) => void
  onRun: () => void           // Ctrl/Cmd+Enter — run in place
  onRunAdvance: () => void    // Shift+Enter — run, then move to next cell
  onEscape: () => void        // leave the editor (enter command mode)
  onInsertBelow: () => void   // Alt+Enter — run and insert a cell below
  onMoveUp: () => void
  onMoveDown: () => void
  onToggleType: () => void
  onRemove: () => void
  onReorder: (fromIndex: number) => void
}

export function Cell(props: Props) {
  const { cell, index, selected, onSelect, onMoveUp, onMoveDown, onToggleType, onRemove, onReorder } = props
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Latest callbacks, read inside the (once-built) CodeMirror keymap.
  const cbRef = useRef(props)
  cbRef.current = props
  const isCode = cell.type === 'code'
  // Collapse a cell's output so a big result (long stream, tall table) doesn't
  // fill the notebook. Persists across re-runs (Cell keyed by cell.id).
  const [outputCollapsed, setOutputCollapsed] = useState(false)

  useEffect(() => {
    if (!editorRef.current) return
    const lang: Extension[] = cell.type === 'markdown' ? [markdown()] : cell.type === 'code' ? [python()] : []
    const runKeys = [
      { key: 'Shift-Enter', run: () => { cbRef.current.onRunAdvance(); return true } },
      { key: 'Mod-Enter', run: () => { cbRef.current.onRun(); return true } },
      { key: 'Alt-Enter', run: () => { cbRef.current.onInsertBelow(); return true } },
      { key: 'Escape', run: (v: EditorView) => { v.contentDOM.blur(); cbRef.current.onEscape(); return true } },
    ]

    const view = new EditorView({
      state: EditorState.create({
        doc: cell.code,
        extensions: [
          lineNumbers(),
          ...lang,
          editorTheme,
          editorHighlight,
          keymap.of([...runKeys, indentWithTab, ...defaultKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbRef.current.onCodeChange(u.state.doc.toString())
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent: editorRef.current,
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, [cell.id, cell.type]) // eslint-disable-line react-hooks/exhaustive-deps

  // Push EXTERNAL code changes (e.g. app-control edit_cell writing to the store)
  // into the already-built editor. The editor is otherwise the source of truth —
  // user typing flows store-ward via onCodeChange, keeping doc === cell.code — so
  // this only fires for changes that didn't originate here, and the equality guard
  // means it never clobbers what the user is typing.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() === cell.code) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: cell.code } })
  }, [cell.code])

  const label = isCode
    ? `[${cell.running ? '*' : (cell.executionCount ?? ' ')}]:`
    : cell.type === 'markdown' ? 'md' : 'raw'

  return (
    <div
      className={`group flex gap-2 rounded ${selected ? 'ring-1 ring-ctp-mauve/60' : ''}`}
      onMouseDown={onSelect}
      // Also select on focus (React's onFocus bubbles) so keyboard navigation —
      // e.g. Shift+Enter advancing into this cell — keeps "the cell I'm in" current.
      onFocus={onSelect}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
      onDrop={(e) => {
        const from = Number(e.dataTransfer.getData('application/x-cell-index'))
        if (!Number.isNaN(from)) { e.preventDefault(); onReorder(from) }
      }}
    >
      {/* Gutter: execution label + drag handle for reordering */}
      <div
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-cell-index', String(index)) }}
        title="Drag to reorder"
        className="w-12 shrink-0 text-right pt-2 text-xs text-ctp-overlay font-mono select-none cursor-grab active:cursor-grabbing"
      >
        {label}
      </div>

      <div className="flex-1 min-w-0 space-y-1">
        <div
          data-cell-id={cell.id}
          className={`rounded border ${cell.running ? 'border-ctp-yellow' : 'border-ctp-surface1 focus-within:border-ctp-mauve'} transition-colors`}
        >
          <div ref={editorRef} />
        </div>

        {isCode && cell.outputs.length > 0 && (
          <div className="flex gap-1.5">
            {/* Jupyter-style collapse gutter: click the LEFT EDGE of the output
                (full height) to hide/show it — no scrolling up to a toolbar. It
                also replaces the old left border as the output's visual margin. */}
            <button
              onClick={() => setOutputCollapsed((v) => !v)}
              title={outputCollapsed ? 'Show output' : 'Hide output (click this bar)'}
              aria-label={outputCollapsed ? 'Show output' : 'Hide output'}
              className="shrink-0 w-2.5 self-stretch rounded-sm bg-ctp-surface1 hover:bg-ctp-mauve/70 transition-colors"
            />
            {outputCollapsed ? (
              <button
                onClick={() => setOutputCollapsed(false)}
                className="text-[10px] text-ctp-overlay hover:text-ctp-text py-0.5"
              >
                {cell.outputs.length} output{cell.outputs.length > 1 ? 's' : ''} hidden — show
              </button>
            ) : (
              // Cap the height so even a large output scrolls in a bounded box
              // instead of pushing the rest of the notebook away.
              <div className="min-w-0 flex-1 space-y-1 pb-1 max-h-96 overflow-auto">
                {cell.outputs.map((o, i) => <Output key={i} output={o} />)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Per-cell actions — appear on hover */}
      <div className="w-5 shrink-0 self-start mt-1.5 flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-ctp-overlay">
        <CellBtn onClick={onMoveUp} title="Move up">↑</CellBtn>
        <CellBtn onClick={onMoveDown} title="Move down">↓</CellBtn>
        <CellBtn onClick={onToggleType} title={isCode ? 'Convert to markdown' : 'Convert to code'}>{isCode ? 'M' : '{}'}</CellBtn>
        <CellBtn onClick={onRemove} title="Delete cell" danger>✕</CellBtn>
      </div>
    </div>
  )
}

function CellBtn({ children, onClick, title, danger }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className={`text-[10px] leading-none px-0.5 py-0.5 rounded hover:bg-ctp-surface0 ${danger ? 'hover:text-ctp-red' : 'hover:text-ctp-text'}`}
    >
      {children}
    </button>
  )
}
