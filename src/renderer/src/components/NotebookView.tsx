import { useNotebooks } from '../store/notebooks'
import { Cell } from './notebook/Cell'

const STATUS_DOT: Record<string, string> = {
  idle:     'bg-ctp-green',
  busy:     'bg-ctp-yellow animate-pulse',
  starting: 'bg-ctp-overlay animate-pulse',
  dead:     'bg-ctp-red',
}

interface Props {
  sessionId: string
}

export function NotebookView({ sessionId }: Props) {
  const {
    notebooks,
    addCell, removeCell, updateCode, executeCell,
    interruptKernel, restartKernel, installAndRetry,
  } = useNotebooks()

  const nb = notebooks[sessionId]
  if (!nb) return null

  const { cells, kernelStatus } = nb
  const isStarting = kernelStatus === 'starting'
  const isDead = kernelStatus === 'dead'

  return (
    <div className="flex flex-col h-full bg-ctp-base border-l border-ctp-surface0 overflow-hidden">
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[kernelStatus ?? 'dead']}`} />
        <span className="text-xs text-ctp-subtext">
          {isDead ? 'Kernel unavailable — is jupyter installed?' : `python3 · ${kernelStatus}`}
        </span>
        <div className="flex-1" />
        {kernelStatus === 'busy' && (
          <button
            onClick={() => interruptKernel(sessionId)}
            className="text-xs text-ctp-overlay hover:text-ctp-red px-2 py-0.5 rounded transition-colors"
          >
            interrupt
          </button>
        )}
        <button
          onClick={() => restartKernel(sessionId)}
          disabled={isStarting}
          className="text-xs text-ctp-overlay hover:text-ctp-text px-2 py-0.5 rounded transition-colors disabled:opacity-40"
        >
          restart
        </button>
        <button
          onClick={() => addCell(sessionId)}
          className="text-xs text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 px-2 py-0.5 rounded transition-colors"
        >
          + cell
        </button>
      </div>

      {/* Cells */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {isStarting && cells.length === 1 && cells[0].code === '' ? (
          <p className="text-xs text-ctp-overlay text-center pt-8">Starting kernel…</p>
        ) : isDead ? (
          <div className="flex flex-col items-center gap-3 pt-8">
            <p className="text-xs text-ctp-red text-center">
              Could not start Jupyter kernel.
            </p>
            <button
              onClick={() => installAndRetry(sessionId)}
              className="text-xs px-3 py-1.5 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 transition-colors"
            >
              Install jupyter &amp; retry
            </button>
          </div>
        ) : null}

        {cells.map((cell, i) => (
          <Cell
            key={cell.id}
            cell={cell}
            index={i}
            onCodeChange={(code) => updateCode(sessionId, cell.id, code)}
            onExecute={() => executeCell(sessionId, cell.id)}
            onRemove={() => removeCell(sessionId, cell.id)}
          />
        ))}

        {cells.length === 0 && (
          <button
            onClick={() => addCell(sessionId)}
            className="w-full text-xs text-ctp-overlay hover:text-ctp-text text-center py-4 border border-dashed border-ctp-surface1 rounded transition-colors"
          >
            + Add cell
          </button>
        )}
      </div>
    </div>
  )
}
