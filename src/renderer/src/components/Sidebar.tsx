import { useSessions } from '../store/sessions'
import type { SessionInfo } from '../../../../shared/types'

const STATE_CLASS: Record<SessionInfo['state'], string> = {
  idle:    'bg-ctp-green',
  running: 'bg-ctp-red',
  waiting: 'bg-ctp-red animate-blink',
}

function StatusDot({ state }: { state: SessionInfo['state'] }) {
  return (
    <span className={`shrink-0 w-2 h-2 rounded-full transition-colors duration-300 ${STATE_CLASS[state]}`} />
  )
}

export function Sidebar() {
  const { sessions, activeId, createSession, closeSession, setActive } = useSessions()

  return (
    <div className="w-52 shrink-0 flex flex-col bg-ctp-mantle border-r border-ctp-surface0">
      <div className="px-3 py-3 flex items-center gap-2 border-b border-ctp-surface0">
        <span className="text-ctp-mauve font-semibold text-sm tracking-wide">ClaudeMaster</span>
      </div>

      <div className="px-2 pt-2 pb-1">
        <span className="text-[10px] font-semibold text-ctp-overlay uppercase tracking-widest px-1">
          Sessions
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            className={`group w-full flex items-center gap-2 px-2 py-2 rounded text-sm text-left transition-colors ${
              s.id === activeId
                ? 'bg-ctp-surface0 text-ctp-text'
                : 'text-ctp-subtext hover:bg-ctp-surface0/50 hover:text-ctp-text'
            }`}
          >
            <StatusDot state={s.state} />
            <span className="flex-1 truncate">{s.name}</span>
            <span
              role="button"
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(`Remove session "${s.name}"?`)) {
                  closeSession(s.id)
                }
              }}
              className="opacity-0 group-hover:opacity-100 text-ctp-overlay hover:text-ctp-red transition-opacity text-xs leading-none px-0.5"
            >
              ✕
            </span>
          </button>
        ))}

        {sessions.length === 0 && (
          <p className="text-xs text-ctp-overlay px-2 py-3 text-center">No sessions yet</p>
        )}
      </div>

      <div className="p-2 border-t border-ctp-surface0">
        <button
          onClick={createSession}
          className="w-full px-3 py-2 text-sm text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors border border-ctp-surface0 hover:border-ctp-surface1"
        >
          + New Session
        </button>
      </div>
    </div>
  )
}
