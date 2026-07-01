import { useEffect, useState } from 'react'
import { useSessions } from '../store/sessions'
import { useFileBrowser } from '../store/fileBrowser'
import { useNotebooks } from '../store/notebooks'
import type { SessionInfo } from '../../../shared/types'

const STATE_CLASS: Record<SessionInfo['state'], string> = {
  idle:    'bg-[#6e5800]',
  running: 'bg-ctp-green',
  waiting: 'bg-ctp-red animate-blink',
}

// A notebook executing in this session takes over the dot with a flashing green,
// regardless of the session's own state.
function StatusDot({ state, notebookRunning }: { state: SessionInfo['state']; notebookRunning?: boolean }) {
  const cls = notebookRunning ? 'bg-ctp-green animate-blink' : STATE_CLASS[state]
  return (
    <span className={`shrink-0 w-2 h-2 rounded-full transition-colors duration-300 ${cls}`} />
  )
}

interface Menu {
  x: number
  y: number
  session: SessionInfo
}

export function Sidebar({ width }: { width?: number }) {
  const {
    sessions, activeId, attention, createSession, addSubsession, closeSession, setActive,
    notifyEnabled, soundEnabled, setNotifyEnabled, setSoundEnabled,
  } = useSessions()
  const { browsers } = useFileBrowser()
  const { notebooks } = useNotebooks()
  // True when this session has an open notebook whose kernel is mid-execution.
  const hasRunningNotebook = (sessionId: string) =>
    (browsers[sessionId]?.openFiles ?? []).some(
      (f) => f.isNotebook && notebooks[f.path]?.kernelStatus === 'busy',
    )
  const [menu, setMenu] = useState<Menu | null>(null)
  const attentionCount = Object.keys(attention).length

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
    <div
      style={{ width: width ?? 208 }}
      className="shrink-0 flex flex-col bg-ctp-mantle border-r border-ctp-surface0"
    >
      <div className="px-3 py-3 flex items-center gap-2 border-b border-ctp-surface0">
        <span className="flex-1 text-ctp-mauve font-semibold text-sm tracking-wide">ClaudeMaster</span>
        <HeaderToggle on={notifyEnabled} onClick={() => setNotifyEnabled(!notifyEnabled)} title={notifyEnabled ? 'Desktop notifications on' : 'Desktop notifications off'}>
          {notifyEnabled ? (
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          ) : (
            <>
              <path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17 17 0 0 1 18 8M6 8a6 6 0 0 1 9.33-5M18 17H3s3-2 3-9" />
              <path d="m2 2 20 20" />
            </>
          )}
        </HeaderToggle>
        <HeaderToggle on={soundEnabled} onClick={() => setSoundEnabled(!soundEnabled)} title={soundEnabled ? 'Sound on' : 'Sound off'}>
          {soundEnabled ? (
            <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
          ) : (
            <><path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" /></>
          )}
        </HeaderToggle>
      </div>

      <div className="px-2 pt-2 pb-1 flex items-center gap-2">
        <span className="text-[10px] font-semibold text-ctp-overlay uppercase tracking-widest px-1">
          Sessions
        </span>
        {attentionCount > 0 && (
          <span
            title={`${attentionCount} session${attentionCount > 1 ? 's' : ''} need you`}
            className="ml-auto mr-1 min-w-4 px-1 h-4 flex items-center justify-center rounded-full bg-ctp-mauve text-ctp-base text-[10px] font-semibold tabular-nums"
          >
            {attentionCount}
          </span>
        )}
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
            <StatusDot state={s.state} notebookRunning={hasRunningNotebook(s.id)} />
            <span className="flex-1 truncate" title={s.parentId ? s.rootDir : s.cwd}>{s.name}</span>
            {attention[s.id] && (
              <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-ctp-mauve group-hover:hidden" title="Needs you" />
            )}
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

// A small icon toggle for the sidebar header (notifications / sound). Children
// are the inner <svg> paths; the icon dims when off.
function HeaderToggle({ on, onClick, title, children }: {
  on: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`shrink-0 p-1 rounded transition-colors hover:bg-ctp-surface0 ${
        on ? 'text-ctp-subtext hover:text-ctp-text' : 'text-ctp-overlay/60 hover:text-ctp-subtext'
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}
