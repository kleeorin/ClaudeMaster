import { useEffect, useState } from 'react'
import { useSessions } from '../store/sessions'
import type { SessionInfo } from '../../../shared/types'

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

interface Menu {
  x: number
  y: number
  session: SessionInfo
}

export function Sidebar() {
  const { sessions, activeId, createSession, addSubsession, closeSession, setActive } = useSessions()
  const [menu, setMenu] = useState<Menu | null>(null)

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const openMenu = (ev: React.MouseEvent, session: SessionInfo) => {
    ev.preventDefault()
    ev.stopPropagation()
    // Beat the global (terminal) context menu listening on `document`.
    ev.nativeEvent.stopImmediatePropagation()
    const MENU_W = 160, MENU_H = 80
    setMenu({
      x: Math.min(ev.clientX, window.innerWidth - MENU_W),
      y: Math.min(ev.clientY, window.innerHeight - MENU_H),
      session,
    })
  }

  const remove = (s: SessionInfo) => {
    const isParent = sessions.some((c) => c.parentId === s.id)
    const msg = isParent
      ? `Remove session "${s.name}" and its subsessions?`
      : `Remove session "${s.name}"?`
    if (window.confirm(msg)) closeSession(s.id)
  }

  // Render top-level sessions, each followed by its subsessions (indented).
  const topLevel = sessions.filter((s) => !s.parentId)
  const rows: { session: SessionInfo; depth: number }[] = []
  for (const s of topLevel) {
    rows.push({ session: s, depth: 0 })
    for (const c of sessions.filter((c) => c.parentId === s.id)) {
      rows.push({ session: c, depth: 1 })
    }
  }
  // Subsessions whose parent is gone (shouldn't happen, but stay reachable).
  for (const s of sessions) {
    if (s.parentId && !sessions.some((p) => p.id === s.parentId)) {
      rows.push({ session: s, depth: 0 })
    }
  }

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
        {rows.map(({ session: s, depth }) => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            onContextMenu={(ev) => openMenu(ev, s)}
            style={depth ? { paddingLeft: 8 + depth * 14 } : undefined}
            className={`group w-full flex items-center gap-2 px-2 py-2 rounded text-sm text-left transition-colors ${
              s.id === activeId
                ? 'bg-ctp-surface0 text-ctp-text'
                : 'text-ctp-subtext hover:bg-ctp-surface0/50 hover:text-ctp-text'
            }`}
          >
            {depth > 0 && <span className="shrink-0 text-ctp-overlay text-xs leading-none">↳</span>}
            <StatusDot state={s.state} />
            <span className="flex-1 truncate" title={s.parentId ? s.rootDir : s.cwd}>{s.name}</span>
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); remove(s) }}
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

      {menu && (
        <div
          style={{ top: menu.y, left: menu.x }}
          className="fixed z-50 w-40 bg-ctp-surface0 border border-ctp-surface1 rounded shadow-lg py-1 select-none"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { setMenu(null); addSubsession(menu.session.id) }}
            className="w-full text-left px-3 py-1.5 text-xs text-ctp-text hover:bg-ctp-surface1 transition-colors"
          >
            Add Subsession
          </button>
          <div className="mx-2 my-0.5 border-t border-ctp-surface1" />
          <button
            onClick={() => { setMenu(null); remove(menu.session) }}
            className="w-full text-left px-3 py-1.5 text-xs text-ctp-red hover:bg-ctp-surface1 transition-colors"
          >
            Remove Session
          </button>
        </div>
      )}
    </div>
  )
}
