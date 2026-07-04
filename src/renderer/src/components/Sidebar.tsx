import { useEffect, useState, useCallback } from 'react'
import { useSessions } from '../store/sessions'
import { useFileBrowser } from '../store/fileBrowser'
import { useNotebooks } from '../store/notebooks'
import { RemotesModal } from './RemotesModal'
import { RemoteDirPicker } from './RemoteDirPicker'
import { parseTarget } from '../../../shared/remotePath'
import type { SessionInfo, RemoteConfig } from '../../../shared/types'

const STATE_CLASS: Record<SessionInfo['state'], string> = {
  idle:    'bg-[#6e5800]',
  running: 'bg-ctp-green',
  waiting: 'bg-ctp-red animate-blink',
  exited:  'bg-ctp-overlay',
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

interface DirPick {
  remote: RemoteConfig
  initialDir: string
  title: string
  onChoose: (dir: string) => void
}

export function Sidebar({ width }: { width?: number }) {
  const {
    sessions, activeId, attention, createSession, createRemoteSession, addSubsession, closeSession, setActive,
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
  const [newMenu, setNewMenu] = useState(false)
  const [remotes, setRemotes] = useState<RemoteConfig[]>([])
  const [showRemotes, setShowRemotes] = useState(false)
  const [dirPick, setDirPick] = useState<DirPick | null>(null)
  // Role + model pickers for the New Session / New subsession menus. `*Role`/`*Model`
  // hold the current choice; the sentinel first option ('general' role, 'default'
  // model) → undefined, i.e. a plain session on the account default.
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([])
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [newRole, setNewRole] = useState('general')
  const [newModel, setNewModel] = useState('default')
  const [subRole, setSubRole] = useState('general')
  const [subModel, setSubModel] = useState('default')
  const roleArg = (r: string) => (r === 'general' ? undefined : r)
  const modelArg = (m: string) => (m === 'default' ? undefined : m)
  // Prepend the 'default' (account setting) sentinel to the fetched model list.
  const modelOptions = [{ id: 'default', name: 'Default' }, ...models]
  useEffect(() => {
    void window.api.agents.list().then(setAgents)
    void window.api.models.list().then(setModels)
  }, [])

  // Whole-app frontend toggle. `window.api.frontend` is the one currently RUNNING
  // (chosen at startup); `pendingFrontend` is what the next launch will use. They
  // diverge once toggled, which raises the restart notice — switching backend + chat
  // surface mid-run isn't supported, so it applies on relaunch.
  const runningFrontend = window.api.frontend
  const [pendingFrontend, setPendingFrontend] = useState<'native' | 'tui'>(runningFrontend)
  const toggleFrontend = useCallback(() => {
    setPendingFrontend((cur) => {
      const next = cur === 'tui' ? 'native' : 'tui'
      void window.api.settings.setFrontend(next)
      return next
    })
  }, [])
  const restartNeeded = pendingFrontend !== runningFrontend
  const frontendLabel = (f: 'native' | 'tui') => (f === 'tui' ? 'Claude Code TUI' : 'Native chat')
  const attentionCount = Object.keys(attention).length

  const loadRemotes = useCallback(async () => {
    setRemotes(await window.api.remotes.list())
  }, [])
  useEffect(() => { void loadRemotes() }, [loadRemotes])

  const remoteLabel = (id?: string) => remotes.find((r) => r.id === id)?.label

  // Start a new session on `remote`: pick a directory on that host, then create.
  const startRemoteSession = (remote: RemoteConfig) => {
    setNewMenu(false)
    setDirPick({
      remote,
      // Empty hint → the picker starts from the remote's live home directory and
      // you browse to the project folder (nothing decided a priori).
      initialDir: remote.defaultDir,
      title: 'New session — choose a folder',
      onChoose: (dir) => { setDirPick(null); void createRemoteSession(remote, dir, roleArg(newRole), modelArg(newModel)) },
    })
  }

  // "Add Subsession": remote parents need the remote folder picker; local parents
  // use the native dialog inside addSubsession.
  const startSubsession = (session: SessionInfo, agentId?: string, model?: string) => {
    const remote = remotes.find((r) => r.id === session.remoteId)
    if (remote) {
      setDirPick({
        remote,
        initialDir: parseTarget(session.rootDir).path,
        title: 'Add subsession — choose a folder',
        onChoose: (dir) => { setDirPick(null); void addSubsession(session.id, dir, agentId, model) },
      })
    } else {
      void addSubsession(session.id, undefined, agentId, model)
    }
  }

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

  // Close the New Session dropdown on any outside click / Escape.
  useEffect(() => {
    if (!newMenu) return
    const close = () => setNewMenu(false)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNewMenu(false) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [newMenu])

  const openMenu = (ev: React.MouseEvent, session: SessionInfo) => {
    ev.preventDefault()
    ev.stopPropagation()
    // Beat the global (terminal) context menu listening on `document`.
    ev.nativeEvent.stopImmediatePropagation()
    const MENU_W = 160, MENU_H = 150
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
        {/* Whole-app frontend: native chat (chat bubble) vs Claude Code TUI (terminal).
            Restart to apply — see the notice below the header. */}
        <HeaderToggle
          on={pendingFrontend === 'tui'}
          onClick={toggleFrontend}
          title={`Frontend: ${frontendLabel(pendingFrontend)} — click to switch to ${frontendLabel(pendingFrontend === 'tui' ? 'native' : 'tui')} (restart to apply)`}
        >
          {pendingFrontend === 'tui' ? (
            <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>
          ) : (
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          )}
        </HeaderToggle>
      </div>

      {restartNeeded && (
        <div className="px-3 py-1.5 flex items-start gap-1.5 bg-ctp-yellow/10 border-b border-ctp-yellow/30 text-[11px] text-ctp-yellow">
          <span className="mt-px">⟳</span>
          <span className="flex-1">Frontend set to <span className="font-medium">{frontendLabel(pendingFrontend)}</span> — restart ClaudeMaster to apply.</span>
        </div>
      )}

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
            <span
              className="flex-1 truncate"
              title={s.state === 'exited'
                ? `Claude not running${s.exitError ? ` — ${s.exitError}` : ''}`
                : (s.parentId ? s.rootDir : s.cwd)}
            >
              {s.name}
            </span>
            {s.agentId && s.agentId !== 'general' && (
              <span
                title={`Agent: ${s.agentId}`}
                className="shrink-0 max-w-16 truncate px-1 rounded bg-ctp-surface1 text-ctp-peach text-[9px] leading-4 font-medium"
              >
                {s.agentId}
              </span>
            )}
            {s.remoteId && (
              <span
                title={`Remote: ${remoteLabel(s.remoteId) ?? s.remoteId}`}
                className="shrink-0 max-w-16 truncate px-1 rounded bg-ctp-surface1 text-ctp-blue text-[9px] leading-4 font-medium"
              >
                {remoteLabel(s.remoteId) ?? 'ssh'}
              </span>
            )}
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

      <div className="p-2 border-t border-ctp-surface0 relative">
        {newMenu && (
          <div
            className="absolute bottom-full left-2 right-2 mb-1 bg-ctp-surface0 border border-ctp-surface1 rounded shadow-lg py-1 select-none z-50"
            onClick={(e) => e.stopPropagation()}
          >
            <MenuSelect label="Role" value={newRole} onChange={setNewRole} options={agents} />
            <MenuSelect label="Model" value={newModel} onChange={setNewModel} options={modelOptions} />
            <div className="mx-2 my-0.5 border-t border-ctp-surface1" />
            <button
              onClick={() => { setNewMenu(false); void createSession(roleArg(newRole), modelArg(newModel)) }}
              className="w-full text-left px-3 py-1.5 text-xs text-ctp-text hover:bg-ctp-surface1 transition-colors"
            >
              Local…
            </button>
            {remotes.length > 0 && <div className="mx-2 my-0.5 border-t border-ctp-surface1" />}
            {remotes.map((r) => (
              <button
                key={r.id}
                onClick={() => startRemoteSession(r)}
                className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs text-ctp-text hover:bg-ctp-surface1 transition-colors"
              >
                <span className="text-ctp-blue">🖧</span>
                <span className="truncate">{r.label}</span>
              </button>
            ))}
            <div className="mx-2 my-0.5 border-t border-ctp-surface1" />
            <button
              onClick={() => { setNewMenu(false); setShowRemotes(true) }}
              className="w-full text-left px-3 py-1.5 text-xs text-ctp-subtext hover:bg-ctp-surface1 transition-colors"
            >
              Manage remotes…
            </button>
          </div>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); setNewMenu((v) => !v) }}
          className="w-full px-3 py-2 text-sm text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 rounded transition-colors border border-ctp-surface0 hover:border-ctp-surface1"
        >
          + New Session
        </button>
      </div>

      {showRemotes && (
        <RemotesModal onClose={() => setShowRemotes(false)} onChanged={loadRemotes} />
      )}
      {dirPick && (
        <RemoteDirPicker
          remote={dirPick.remote}
          initialDir={dirPick.initialDir}
          title={dirPick.title}
          onChoose={dirPick.onChoose}
          onCancel={() => setDirPick(null)}
        />
      )}

      {menu && (
        <div
          style={{ top: menu.y, left: menu.x }}
          className="fixed z-50 w-40 bg-ctp-surface0 border border-ctp-surface1 rounded shadow-lg py-1 select-none"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuSelect label="Role" value={subRole} onChange={setSubRole} options={agents} />
          <MenuSelect label="Model" value={subModel} onChange={setSubModel} options={modelOptions} />
          <div className="mx-2 my-0.5 border-t border-ctp-surface1" />
          <button
            onClick={() => { const s = menu.session; setMenu(null); startSubsession(s, roleArg(subRole), modelArg(subModel)) }}
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

// A labelled <select> row shared by the New Session dropdown and the New subsession
// menu — used for both the agent Role and the Model. The first option is the
// sentinel default (general role / account-default model). stopPropagation keeps a
// click on the select from dismissing the surrounding menu.
function MenuSelect({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ id: string; name: string }>
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
      <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-ctp-overlay">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 bg-ctp-surface1 text-ctp-text text-xs rounded px-1 py-0.5 outline-none cursor-pointer"
      >
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
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
