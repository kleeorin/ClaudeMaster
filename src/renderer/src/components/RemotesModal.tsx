import { useEffect, useState, useCallback } from 'react'
import type { RemoteConfig, SshConfigHost, ResolvedHost } from '../../../shared/types'

type Draft = Omit<RemoteConfig, 'id'> & { id?: string }

const EMPTY: Draft = { label: '', host: '', defaultDir: '', sshOptions: [], pythonPath: '' }

// Render a resolved connection identity as user@host[:port], falling back to the
// raw destination when ssh couldn't resolve anything.
function identity(r: { user?: string; hostName?: string; port?: string }, fallback: string): string {
  if (!r.hostName && !r.user) return fallback
  const base = (r.user ? `${r.user}@` : '') + (r.hostName ?? fallback)
  return r.port ? `${base}:${r.port}` : base
}

// Manage saved SSH remotes: list, add, edit, test, delete. `onChanged` lets the
// opener refresh its own copy of the list (e.g. the New Session menu).
export function RemotesModal({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [remotes, setRemotes] = useState<RemoteConfig[]>([])
  const [sshHosts, setSshHosts] = useState<SshConfigHost[]>([])
  const [resolved, setResolved] = useState<Record<string, ResolvedHost>>({})  // remoteId → real user/host/port
  const [draft, setDraft] = useState<Draft | null>(null)
  const [optsText, setOptsText] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const refresh = useCallback(async () => {
    const list = await window.api.remotes.list()
    setRemotes(list)
    onChanged?.()
    // Resolve each remote's real identity (user/host/port) the way ssh will, so the
    // manager shows who you'll actually connect as — not just the alias.
    const entries = await Promise.all(
      list.map(async (r) => [r.id, await window.api.remotes.resolveHost(r.host, r.sshOptions)] as const),
    )
    setResolved(Object.fromEntries(entries))
  }, [onChanged])

  useEffect(() => { void refresh() }, [refresh])

  // Discover ~/.ssh/config aliases once (they rarely change mid-session).
  useEffect(() => { void window.api.remotes.sshConfigHosts().then(setSshHosts) }, [])

  // Offer only aliases not already saved as a remote (matched on host).
  const quickAddable = sshHosts.filter((h) => !remotes.some((r) => r.host === h.alias))

  const quickAdd = async (h: SshConfigHost) => {
    // ssh resolves the real destination from the config; blank defaultDir ⇒ home.
    await window.api.remotes.add({ label: h.alias, host: h.alias, defaultDir: '', sshOptions: [] })
    await refresh()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const edit = (r: RemoteConfig) => {
    setDraft(r)
    setOptsText((r.sshOptions ?? []).join(' '))
    setResult(null)
  }
  const addNew = () => {
    setDraft({ ...EMPTY })
    setOptsText('')
    setResult(null)
  }

  // sshOptions is stored as argv; the field is a space-separated string.
  const draftWithOpts = (d: Draft): RemoteConfig => ({
    id: d.id ?? '',
    label: d.label.trim() || d.host.trim(),
    host: d.host.trim(),
    // Optional: just where the folder picker opens. Empty ⇒ the remote's home
    // directory, resolved live when you start a session.
    defaultDir: d.defaultDir.trim(),
    sshOptions: optsText.trim() ? optsText.trim().split(/\s+/) : [],
    // Empty ⇒ omit, so the remote falls back to its login-shell python3.
    pythonPath: d.pythonPath?.trim() || undefined,
  })

  const save = async () => {
    if (!draft || !draft.host.trim()) return
    const d = draftWithOpts(draft)
    if (draft.id) await window.api.remotes.update(d)
    else await window.api.remotes.add({ label: d.label, host: d.host, defaultDir: d.defaultDir, sshOptions: d.sshOptions, pythonPath: d.pythonPath })
    setDraft(null)
    await refresh()
  }

  const test = async () => {
    if (!draft) return
    setTesting(true)
    setResult(null)
    const res = await window.api.remotes.test(draftWithOpts(draft))
    setTesting(false)
    setResult(res.ok ? { ok: true, msg: 'Connection OK' } : { ok: false, msg: res.error })
  }

  const del = async (r: RemoteConfig) => {
    if (!window.confirm(`Delete remote "${r.label}"?`)) return
    await window.api.remotes.remove(r.id)
    if (draft?.id === r.id) setDraft(null)
    await refresh()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[560px] max-h-[80vh] flex flex-col bg-ctp-base border border-ctp-surface1 rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 flex items-center border-b border-ctp-surface0">
          <span className="text-sm font-semibold text-ctp-text flex-1">SSH Remotes</span>
          <button onClick={onClose} className="text-ctp-overlay hover:text-ctp-text text-sm">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="space-y-1">
            {remotes.length === 0 && (
              <p className="text-xs text-ctp-overlay py-2">No remotes yet. Add one below.</p>
            )}
            {remotes.map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-ctp-mantle">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-ctp-text truncate">{r.label}</div>
                  <div className="text-[11px] text-ctp-overlay font-mono truncate">
                    {identity(resolved[r.id] ?? {}, r.host)}{r.defaultDir ? `:${r.defaultDir}` : ''}
                  </div>
                </div>
                <button onClick={() => edit(r)} className="px-2 py-1 text-[11px] rounded bg-ctp-surface0 text-ctp-subtext hover:text-ctp-text">Edit</button>
                <button onClick={() => del(r)} className="px-2 py-1 text-[11px] rounded bg-ctp-surface0 text-ctp-red hover:bg-ctp-surface1">Delete</button>
              </div>
            ))}
          </div>

          {!draft && quickAddable.length > 0 && (
            <div className="space-y-1 border-t border-ctp-surface0 pt-3">
              <div className="text-[11px] text-ctp-overlay">From your <span className="font-mono">~/.ssh/config</span> — one click to add:</div>
              <div className="flex flex-wrap gap-1.5">
                {quickAddable.map((h) => (
                  <button
                    key={h.alias}
                    onClick={() => quickAdd(h)}
                    title={`${identity(h, h.alias)} — add as a remote`}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-ctp-surface0 text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface1"
                  >
                    <span className="text-ctp-green">+</span>
                    <span className="font-mono">{h.alias}</span>
                    {(h.hostName || h.user) && <span className="text-ctp-overlay">({identity(h, h.alias)})</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {draft ? (
            <div className="space-y-2 border-t border-ctp-surface0 pt-3">
              <div className="text-xs font-semibold text-ctp-subtext">{draft.id ? 'Edit remote' : 'New remote'}</div>
              <Field label="Label" value={draft.label} onChange={(v) => setDraft({ ...draft, label: v })} placeholder="my-server" />
              <Field label="SSH host" value={draft.host} onChange={(v) => setDraft({ ...draft, host: v })} placeholder="user@host or ssh-config alias" mono />
              <Field label="Start folder (optional)" value={draft.defaultDir} onChange={(v) => setDraft({ ...draft, defaultDir: v })} placeholder="blank = home; you browse from there" mono />
              <Field label="SSH options" value={optsText} onChange={setOptsText} placeholder="-p 2222 -i ~/.ssh/id_ed25519" mono />
              <Field label="Python interpreter (optional)" value={draft.pythonPath ?? ''} onChange={(v) => setDraft({ ...draft, pythonPath: v })} placeholder="blank = python3; e.g. /path/.venv/bin/python3 (Jupyter)" mono />
              {result && (
                <div className={`text-xs ${result.ok ? 'text-ctp-green' : 'text-ctp-red'}`}>{result.msg}</div>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button onClick={test} disabled={testing || !draft.host.trim()} className="px-3 py-1.5 text-xs rounded bg-ctp-surface0 text-ctp-subtext hover:text-ctp-text disabled:opacity-40">
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
                <div className="flex-1" />
                <button onClick={() => setDraft(null)} className="px-3 py-1.5 text-xs rounded text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0">Cancel</button>
                <button onClick={save} disabled={!draft.host.trim()} className="px-3 py-1.5 text-xs rounded bg-ctp-mauve text-ctp-base font-medium hover:bg-ctp-mauve/90 disabled:opacity-40">Save</button>
              </div>
            </div>
          ) : (
            <button onClick={addNew} className="w-full px-3 py-2 text-xs text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 rounded border border-ctp-surface0">
              + Add remote
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, mono }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-ctp-overlay">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full mt-0.5 px-2 py-1 text-xs bg-ctp-mantle border border-ctp-surface0 rounded text-ctp-text focus:outline-none focus:border-ctp-mauve ${mono ? 'font-mono' : ''}`}
      />
    </label>
  )
}
