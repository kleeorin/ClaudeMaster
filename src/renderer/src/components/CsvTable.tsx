import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { parseCsv, serializeCsv } from '../lib/csv'

// Imperative history controls a host toolbar can drive. Keyboard shortcuts
// (Mod-Z / Mod-Shift-Z / Mod-Y) are wired on the grid itself regardless.
export interface CsvTableHandle {
  undo: () => void
  redo: () => void
}

interface Props {
  // The raw CSV/TSV text, kept in sync with the host's editor content so the
  // existing save / dirty / conflict pipeline works unchanged.
  value: string
  delimiter: ',' | '\t'
  readOnly: boolean
  onChange: (text: string) => void
}

const HISTORY_LIMIT = 200

// An editable spreadsheet-style grid over CSV/TSV text. The first row is treated
// as a header (sticky, emphasised) but stays fully editable, matching how pandas
// and spreadsheet apps present a CSV. Every edit re-serialises the whole grid and
// pushes the string up via onChange, so FileView owns saving/dirty exactly as it
// does for the text editor — this component holds no persistence of its own.
//
// It keeps its own undo/redo history so a mis-click (deleting a row/column) or a
// stray cell edit can be reverted without leaving the table. Consecutive typing in
// one cell coalesces into a single undo step; structural ops each get their own.
export const CsvTable = forwardRef<CsvTableHandle, Props>(function CsvTable(
  { value, delimiter, readOnly, onChange },
  ref,
) {
  const [grid, setGrid] = useState<string[][]>(() => parseCsv(value, delimiter))
  // Mirror the live grid + callbacks in refs so the (stable) history methods
  // always read current values without being rebuilt.
  const gridRef = useRef(grid)
  gridRef.current = grid
  const cbRef = useRef({ onChange, delimiter })
  cbRef.current = { onChange, delimiter }

  const undoStack = useRef<string[][][]>([])
  const redoStack = useRef<string[][][]>([])
  // Groups consecutive edits: same tag ⇒ same undo step. `null` (structural ops,
  // undo/redo) always starts a fresh step.
  const lastTag = useRef<string | null>(null)
  // The last string we emitted (or parsed from). Lets us tell our own edits apart
  // from an external change (reload from disk / mode switch) so we only re-parse —
  // and reset history — when the text really changed underneath us.
  const lastValue = useRef(value)

  useEffect(() => {
    if (value !== lastValue.current) {
      const g = parseCsv(value, delimiter)
      setGrid(g)
      gridRef.current = g
      undoStack.current = []
      redoStack.current = []
      lastTag.current = null
      lastValue.current = value
    }
  }, [value, delimiter])

  // Apply a new grid and push the serialised text up (no history bookkeeping).
  const emit = (g: string[][]) => {
    setGrid(g)
    gridRef.current = g
    const text = serializeCsv(g, cbRef.current.delimiter)
    lastValue.current = text
    cbRef.current.onChange(text)
  }

  // A user edit. `tag` coalesces a run of edits into one undo step (pass null for
  // structural changes so each is independently undoable).
  const commit = (next: string[][], tag: string | null = null) => {
    if (tag == null || tag !== lastTag.current) {
      undoStack.current.push(gridRef.current)
      if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
      redoStack.current = []
    }
    lastTag.current = tag
    emit(next)
  }

  const undo = () => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(gridRef.current)
    lastTag.current = null
    emit(prev)
  }

  const redo = () => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(gridRef.current)
    lastTag.current = null
    emit(next)
  }

  useImperativeHandle(ref, () => ({ undo, redo }), [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (readOnly || !(e.metaKey || e.ctrlKey)) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo() }
  }

  const colCount = Math.max(1, ...grid.map((r) => r.length))
  const bodyRows = grid.slice(1)

  const cellAt = (r: number, c: number) => grid[r]?.[c] ?? ''

  const setCell = (r: number, c: number, val: string) => {
    const next = grid.map((row) => row.slice())
    while (next.length <= r) next.push([])
    const row = next[r]
    while (row.length <= c) row.push('')
    row[c] = val
    commit(next, `cell:${r}:${c}`)
  }

  const addRow = () => commit([...grid.map((row) => row.slice()), Array(colCount).fill('')])

  const deleteRow = (r: number) => commit(grid.filter((_, i) => i !== r))

  const addColumn = () => commit(grid.length ? grid.map((row) => [...row, '']) : [['']])

  const deleteColumn = (c: number) => commit(grid.map((row) => row.filter((_, i) => i !== c)))

  // A single editable cell. Read-only renders plain text (with a non-breaking
  // space so empty cells still occupy a row of height).
  const Cell = ({ r, c, header: isHeader }: { r: number; c: number; header?: boolean }) => {
    const val = cellAt(r, c)
    if (readOnly) {
      return (
        <span className={`block px-2 py-1 whitespace-pre truncate ${isHeader ? 'font-medium text-ctp-text' : 'text-ctp-subtext'}`}>
          {val || ' '}
        </span>
      )
    }
    return (
      <input
        value={val}
        onChange={(e) => setCell(r, c, e.target.value)}
        spellCheck={false}
        className={`w-full min-w-[6rem] bg-transparent px-2 py-1 outline-none focus:bg-ctp-surface0/60 ${
          isHeader ? 'font-medium text-ctp-text' : 'text-ctp-subtext focus:text-ctp-text'
        }`}
      />
    )
  }

  const iconBtn =
    'flex items-center justify-center w-5 h-5 rounded text-ctp-overlay hover:text-ctp-red hover:bg-ctp-surface0 text-xs'

  return (
    <div className="h-full overflow-auto text-xs" onKeyDown={onKeyDown}>
      <table className="border-collapse">
        <thead className="sticky top-0 z-10 bg-ctp-mantle">
          <tr>
            {/* Row-number gutter corner */}
            <th className="sticky left-0 z-20 bg-ctp-mantle border-b border-r border-ctp-surface0 w-10" />
            {Array.from({ length: colCount }, (_, c) => (
              <th key={c} className="border-b border-r border-ctp-surface0 text-left align-top group">
                <div className="flex items-center">
                  <div className="flex-1"><Cell r={0} c={c} header /></div>
                  {!readOnly && colCount > 1 && (
                    <button
                      onClick={() => deleteColumn(c)}
                      title="Delete column"
                      className={`${iconBtn} mr-1 opacity-0 group-hover:opacity-100`}
                    >
                      ×
                    </button>
                  )}
                </div>
              </th>
            ))}
            {!readOnly && (
              <th className="border-b border-ctp-surface0 px-1">
                <button onClick={addColumn} title="Add column" className={iconBtn.replace('hover:text-ctp-red', 'hover:text-ctp-green')}>
                  ＋
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((_, i) => {
            const r = i + 1 // grid index (row 0 is the header)
            return (
              <tr key={r} className="group hover:bg-ctp-surface0/30">
                <td className="sticky left-0 z-10 bg-ctp-mantle group-hover:bg-ctp-surface0 border-b border-r border-ctp-surface0 text-center text-ctp-overlay select-none w-10">
                  <div className="flex items-center justify-center gap-0.5">
                    {!readOnly ? (
                      <button onClick={() => deleteRow(r)} title="Delete row" className={`${iconBtn} opacity-0 group-hover:opacity-100`}>
                        ×
                      </button>
                    ) : null}
                    <span className={readOnly ? '' : 'group-hover:hidden'}>{r}</span>
                  </div>
                </td>
                {Array.from({ length: colCount }, (_, c) => (
                  <td key={c} className="border-b border-r border-ctp-surface0 align-top p-0">
                    <Cell r={r} c={c} />
                  </td>
                ))}
                {!readOnly && <td className="border-b border-ctp-surface0" />}
              </tr>
            )
          })}
        </tbody>
      </table>

      {!readOnly && (
        <button
          onClick={addRow}
          className="m-2 px-2 py-1 rounded bg-ctp-surface0 text-ctp-subtext hover:bg-ctp-surface1 hover:text-ctp-text"
        >
          ＋ Add row
        </button>
      )}
    </div>
  )
})
