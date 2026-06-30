// Minimal nbformat v4 reader/writer. Code cells are loaded fully (source, outputs,
// execution count); markdown/raw cells are preserved verbatim so notebooks
// round-trip without data loss even though only code cells are executable.
import type { CellOutput } from './kernelClient'
import type { Cell, CellType } from '../store/notebooks'

export interface NotebookMeta {
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

// nbformat stores multi-line strings as arrays of lines; collapse to a string.
function srcToString(source: unknown): string {
  if (Array.isArray(source)) return source.join('')
  if (typeof source === 'string') return source
  return ''
}

// Inverse: split into nbformat's line array (each line keeps its trailing "\n"
// except the last). An empty string serializes to [].
function splitLines(s: string): string[] {
  if (s === '') return []
  const parts = s.split('\n')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i < parts.length - 1) out.push(parts[i] + '\n')
    else if (parts[i] !== '') out.push(parts[i])
  }
  return out
}

function dataToStrings(data: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = Array.isArray(v) ? v.join('') : String(v)
    }
  }
  return out
}

function serializeData(data: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) out[k] = splitLines(v)
  return out
}

function parseOutputs(outputs: unknown): CellOutput[] {
  if (!Array.isArray(outputs)) return []
  const res: CellOutput[] = []
  for (const raw of outputs) {
    const o = raw as Record<string, unknown>
    switch (o.output_type) {
      case 'stream':
        res.push({ type: 'stream', name: o.name === 'stderr' ? 'stderr' : 'stdout', text: srcToString(o.text) })
        break
      case 'execute_result':
        res.push({ type: 'result', data: dataToStrings(o.data), executionCount: (o.execution_count as number) ?? 0 })
        break
      case 'display_data':
        res.push({ type: 'display', data: dataToStrings(o.data) })
        break
      case 'error':
        res.push({ type: 'error', ename: (o.ename as string) ?? '', evalue: (o.evalue as string) ?? '', traceback: (o.traceback as string[]) ?? [] })
        break
    }
  }
  return res
}

function serializeOutputs(outputs: CellOutput[]): unknown[] {
  return outputs.map((o) => {
    switch (o.type) {
      case 'stream':
        return { output_type: 'stream', name: o.name, text: splitLines(o.text) }
      case 'result':
        return { output_type: 'execute_result', data: serializeData(o.data), execution_count: o.executionCount, metadata: {} }
      case 'display':
        return { output_type: 'display_data', data: serializeData(o.data), metadata: {} }
      case 'error':
        return { output_type: 'error', ename: o.ename, evalue: o.evalue, traceback: o.traceback }
    }
  })
}

function makeCell(type: CellType, code: string, outputs: CellOutput[], executionCount: number | null, metadata: Record<string, unknown>): Cell {
  return { id: crypto.randomUUID(), type, code, outputs, executionCount, running: false, metadata }
}

export function parseNotebook(text: string): { cells: Cell[]; meta: NotebookMeta } {
  let nb: Record<string, unknown>
  try { nb = JSON.parse(text) } catch { nb = {} }

  const rawCells = Array.isArray(nb.cells) ? nb.cells : []
  const cells: Cell[] = rawCells.map((raw) => {
    const c = raw as Record<string, unknown>
    const type: CellType = c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'raw' ? 'raw' : 'code'
    const metadata = c.metadata && typeof c.metadata === 'object' ? (c.metadata as Record<string, unknown>) : {}
    return makeCell(
      type,
      srcToString(c.source),
      type === 'code' ? parseOutputs(c.outputs) : [],
      type === 'code' ? ((c.execution_count as number) ?? null) : null,
      metadata,
    )
  })
  if (cells.length === 0) cells.push(makeCell('code', '', [], null, {}))

  return {
    cells,
    meta: {
      metadata: nb.metadata && typeof nb.metadata === 'object' ? (nb.metadata as Record<string, unknown>) : {},
      nbformat: typeof nb.nbformat === 'number' ? nb.nbformat : 4,
      nbformat_minor: typeof nb.nbformat_minor === 'number' ? nb.nbformat_minor : 5,
    },
  }
}

export function serializeNotebook(cells: Cell[], meta: NotebookMeta): string {
  const nb = {
    cells: cells.map((c) => {
      const out: Record<string, unknown> = {
        cell_type: c.type,
        metadata: c.metadata ?? {},
        source: splitLines(c.code),
      }
      if (c.type === 'code') {
        out.execution_count = c.executionCount
        out.outputs = serializeOutputs(c.outputs)
      }
      return out
    }),
    metadata: meta.metadata,
    nbformat: meta.nbformat,
    nbformat_minor: meta.nbformat_minor,
  }
  // Jupyter writes notebooks with single-space indentation.
  return JSON.stringify(nb, null, 1) + '\n'
}

// JSON for a fresh notebook with one empty code cell and a python3 kernelspec.
export function emptyNotebookJSON(): string {
  return serializeNotebook(
    [makeCell('code', '', [], null, {})],
    {
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
  )
}
