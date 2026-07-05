import { useCallback, useEffect, useState } from 'react'
import type { EffectivePermissions, PermissionMode, PermissionAction, PermissionScope } from '../../../shared/types'
import { usePermsPanel } from '../store/permsPanel'
import { useSessions } from '../store/sessions'

interface Props {
  sessionId: string
  cwd: string                    // session root (remote-encoded ok) — settings files resolve from here
  agentId?: string               // the session's role, for the read-only agent-scope section
  sessionMode?: PermissionMode   // the session's chosen launch mode (overrides the file defaultMode at runtime)
}

// How each permission mode reads + its badge colour. `default` = ordinary
// prompt-on-each-tool; the others progressively loosen (accept edits / plan-only)
// or, for bypass, remove the guardrails (shown red).
const MODE_META: Record<PermissionMode, { label: string; hint: string; cls: string; on: string }> = {
  default: { label: 'Default', hint: 'Prompts for each tool that needs approval.', cls: 'text-ctp-subtext', on: 'bg-ctp-surface1 text-ctp-text' },
  acceptEdits: { label: 'Accept Edits', hint: 'Auto-approves file edits; still prompts for other tools.', cls: 'text-ctp-green', on: 'bg-ctp-green/20 text-ctp-green' },
  plan: { label: 'Plan', hint: 'Read-only planning; no edits or commands run.', cls: 'text-ctp-blue', on: 'bg-ctp-blue/20 text-ctp-blue' },
  bypassPermissions: { label: 'Bypass', hint: 'Skips ALL permission prompts — use with care.', cls: 'text-ctp-red', on: 'bg-ctp-red/25 text-ctp-red' },
}
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

const ACTION_META: Record<PermissionAction, { label: string; cls: string }> = {
  deny: { label: 'Deny', cls: 'text-ctp-red' },
  ask: { label: 'Ask', cls: 'text-ctp-peach' },
  allow: { label: 'Allow', cls: 'text-ctp-green' },
}

const SCOPE_LABEL: Record<PermissionScope, string> = { user: 'user', project: 'project', local: 'local' }

export function PermissionsPanel({ sessionId, cwd, agentId, sessionMode }: Props) {
  const { closePerms } = usePermsPanel()
  const { setSessionMode } = useSessions()
  const [perms, setPerms] = useState<EffectivePermissions | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!cwd) return
    setLoading(true)
    void window.api.perms.get(cwd, agentId).then((p) => { setPerms(p); setLoading(false) })
  }, [cwd, agentId])

  useEffect(() => { load() }, [load])

  // The active mode is the session's launch/override mode if set, else whatever
  // the settings files default to.
  const activeMode: PermissionMode = sessionMode ?? perms?.mode ?? 'default'

  const chooseMode = async (mode: PermissionMode) => {
    if (mode === activeMode) return
    if (mode === 'bypassPermissions'
      && !window.confirm('Bypass skips ALL permission prompts for this session — Claude can edit files and run commands with no approval. Continue?')) return
    setNotice(null)
    const r = await setSessionMode(sessionId, mode)
    if (r.applied === 'live') setNotice(`Switched to ${MODE_META[mode].label} live.`)
    else if (r.applied === 'relaunched') setNotice(`Relaunched this session in ${MODE_META[mode].label} mode (conversation kept).`)
    else if (r.applied === 'restart') setNotice(`${MODE_META[mode].label} saved — applies on the next launch (finish the current turn first).`)
    else setNotice(`Couldn’t set mode: ${r.error}`)
  }

  // Rules ordered deny → ask → allow (most-restrictive first).
  const order: PermissionAction[] = ['deny', 'ask', 'allow']
  const grouped = order
    .map((action) => ({ action, rules: perms?.rules.filter((r) => r.action === action) ?? [] }))
    .filter((g) => g.rules.length > 0)
  const agentScoped = perms?.agent && perms.agent.id !== 'general'
    && ((perms.agent.allowedTools?.length ?? 0) > 0 || (perms.agent.disallowedTools?.length ?? 0) > 0)

  const removeRule = async (scope: PermissionScope, action: PermissionAction, value: string) => {
    setNotice(null)
    const r = await window.api.perms.removeRule(cwd, scope, action, value)
    if (!r.ok) { setNotice(`Couldn’t remove rule: ${r.error}`); return }
    load()
  }

  return (
    <div className="h-full flex flex-col bg-ctp-mantle text-sm">
      {/* header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-ctp-surface0">
        <span className="text-xs font-semibold uppercase tracking-wide text-ctp-subtext">Permissions</span>
        <div className="flex-1" />
        <button onClick={load} title="Refresh" className="text-ctp-overlay hover:text-ctp-text p-1 disabled:opacity-40" disabled={loading}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
          </svg>
        </button>
        <button onClick={() => closePerms(sessionId)} title="Close" className="text-ctp-overlay hover:text-ctp-text p-1">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {perms?.error && (
          <div className="text-xs text-ctp-red border border-ctp-red/40 rounded p-2">Couldn’t read settings: {perms.error}</div>
        )}
        {notice && (
          <div className="text-xs text-ctp-subtext border border-ctp-surface1 rounded p-2">{notice}</div>
        )}

        {/* mode switcher */}
        <section>
          <SectionLabel>Mode</SectionLabel>
          <div className="grid grid-cols-2 gap-1.5">
            {MODES.map((m) => {
              const meta = MODE_META[m]
              const active = m === activeMode
              return (
                <button
                  key={m}
                  onClick={() => chooseMode(m)}
                  title={meta.hint}
                  className={`px-2 py-1 rounded text-xs font-medium text-left transition-colors ${
                    active ? meta.on : `bg-ctp-surface0/50 ${meta.cls} hover:bg-ctp-surface0`
                  }`}
                >
                  {meta.label}{active ? ' ✓' : ''}
                </button>
              )
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-ctp-overlay leading-snug">{MODE_META[activeMode].hint}</p>
          {perms?.modeScope && !sessionMode && (
            <p className="mt-0.5 text-[11px] text-ctp-overlay">Default from {SCOPE_LABEL[perms.modeScope]} settings.</p>
          )}
        </section>

        {/* effective rules + add */}
        <section>
          <SectionLabel>Rules ({perms?.rules.length ?? 0})</SectionLabel>
          {grouped.length === 0 ? (
            <p className="text-[11px] text-ctp-overlay mb-2">No allow / deny / ask rules in this session’s settings files yet.</p>
          ) : (
            <div className="space-y-2 mb-2">
              {grouped.map(({ action, rules }) => (
                <div key={action}>
                  <div className={`text-[11px] font-semibold mb-0.5 ${ACTION_META[action].cls}`}>{ACTION_META[action].label}</div>
                  <div className="space-y-0.5">
                    {rules.map((r, i) => (
                      <div key={`${r.value}-${r.scope}-${i}`} className="group flex items-center gap-2 text-xs">
                        <code className="flex-1 truncate font-mono text-ctp-text" title={r.value}>{r.value}</code>
                        <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-ctp-surface0 text-ctp-overlay">{SCOPE_LABEL[r.scope]}</span>
                        <button
                          onClick={() => removeRule(r.scope, r.action, r.value)}
                          title="Remove rule"
                          className="opacity-0 group-hover:opacity-100 shrink-0 text-ctp-overlay hover:text-ctp-red leading-none px-0.5"
                        >×</button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <AddRule cwd={cwd} onAdded={load} onError={setNotice} />
        </section>

        {/* settings files */}
        <section>
          <SectionLabel>Settings files</SectionLabel>
          <div className="space-y-1">
            {(perms?.files ?? []).map((f) => (
              <div key={f.scope} className="flex items-center gap-2 text-xs">
                <span className="shrink-0 w-14 text-ctp-subtext">{SCOPE_LABEL[f.scope]}</span>
                <code className="flex-1 truncate font-mono text-ctp-overlay" title={f.path}>{f.path}</code>
                <span className={`shrink-0 text-[10px] ${f.unreadable ? 'text-ctp-red' : f.exists ? 'text-ctp-green' : 'text-ctp-overlay'}`}>
                  {f.unreadable ? 'invalid' : f.exists ? 'present' : 'none'}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* read-only "system" rules: notebook funnel + agent scoping */}
        <section>
          <SectionLabel>System (read-only)</SectionLabel>
          <div className="text-[11px] text-ctp-overlay mb-1">ClaudeMaster always denies native notebook edits (funnelled to its own tools):</div>
          <div className="space-y-0.5">
            {(perms?.notebookFunnel ?? []).map((v) => (
              <code key={v} className="block truncate font-mono text-xs text-ctp-subtext" title={v}>{v}</code>
            ))}
          </div>
          {agentScoped && perms?.agent && (
            <div className="mt-2">
              <div className="text-[11px] text-ctp-overlay mb-1">Agent <span className="text-ctp-mauve">{perms.agent.name}</span> tool scope:</div>
              {perms.agent.allowedTools?.length ? (
                <div className="text-xs"><span className="text-ctp-green">allow </span><span className="font-mono text-ctp-subtext">{perms.agent.allowedTools.join(', ')}</span></div>
              ) : null}
              {perms.agent.disallowedTools?.length ? (
                <div className="text-xs"><span className="text-ctp-red">deny </span><span className="font-mono text-ctp-subtext">{perms.agent.disallowedTools.join(', ')}</span></div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

// Inline "add a rule" form: action + scope pickers + a value like Bash(npm run test:*).
function AddRule({ cwd, onAdded, onError }: { cwd: string; onAdded: () => void; onError: (m: string) => void }) {
  const [action, setAction] = useState<PermissionAction>('allow')
  const [scope, setScope] = useState<PermissionScope>('local')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const v = value.trim()
    if (!v || busy) return
    setBusy(true)
    const r = await window.api.perms.addRule(cwd, scope, action, v)
    setBusy(false)
    if (!r.ok) { onError(`Couldn’t add rule: ${r.error}`); return }
    setValue('')
    onAdded()
  }

  const selCls = 'bg-ctp-surface0 text-ctp-text text-xs rounded px-1.5 py-1 border border-ctp-surface1 focus:outline-none'
  return (
    <div className="flex items-center gap-1.5 pt-1 border-t border-ctp-surface0">
      <select value={action} onChange={(e) => setAction(e.target.value as PermissionAction)} className={selCls}>
        <option value="allow">Allow</option>
        <option value="deny">Deny</option>
        <option value="ask">Ask</option>
      </select>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
        placeholder="Bash(npm run test:*)"
        className="flex-1 min-w-0 bg-ctp-surface0 text-ctp-text text-xs font-mono rounded px-1.5 py-1 border border-ctp-surface1 focus:outline-none focus:border-ctp-mauve"
      />
      <select value={scope} onChange={(e) => setScope(e.target.value as PermissionScope)} className={selCls} title="Which settings file to write">
        <option value="local">local</option>
        <option value="project">project</option>
        <option value="user">user</option>
      </select>
      <button
        onClick={() => void submit()}
        disabled={!value.trim() || busy}
        className="shrink-0 text-xs px-2 py-1 rounded bg-ctp-surface1 text-ctp-text hover:bg-ctp-surface2 disabled:opacity-40"
      >Add</button>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wide text-ctp-subtext mb-1.5">{children}</div>
}
