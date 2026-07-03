import { useEffect, useRef, useState } from 'react'
import { useChat, type TranscriptItem, type SessionMeta, type RateLimitInfo } from '../store/chat'
import { useSessions } from '../store/sessions'
import { ToolDetail, toolHeadline } from '../lib/toolFormat'
import { Markdown } from './Markdown'
import { ResumePicker } from './ResumePicker'
import type { ConversationMeta } from '../../../shared/types'

// Native chat frontend for a Claude session — the replacement for the embedded
// TUI terminal. Renders the structured transcript, surfaces permission prompts
// as native UI, and submits whole user turns over stream-json. Rich per-tool
// widgets and token streaming arrive in step 2; this is the functional slice.
export function ChatView({ sessionId, isActive }: { sessionId: string; isActive: boolean }) {
  const { transcriptFor, pendingFor, slashCommandsFor, metaFor, hydrateMeta, sendTurn, interrupt, respond, loadTranscript, clearTranscript } = useChat()
  const { sessions } = useSessions()
  const session = sessions.find((s) => s.id === sessionId)
  const state = session?.state ?? 'idle'
  const cwd = session?.cwd ?? ''
  const items = transcriptFor(sessionId)
  const pending = pendingFor(sessionId)
  const meta = metaFor(sessionId)
  const [draft, setDraft] = useState('')
  const [showResume, setShowResume] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const running = state === 'running' || state === 'waiting'

  // Keep the newest content in view while this session is the one on screen.
  useEffect(() => {
    if (isActive) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [items.length, pending, isActive])

  // Populate the status bar from the last-known snapshot right away — the CLI only
  // emits the model/context on init/result (after the first turn), so without this
  // a freshly-loaded or restored session would show an empty bar until you type.
  useEffect(() => {
    let live = true
    window.api.session.claudeId(sessionId).then((sid) => { if (live && sid) hydrateMeta(sessionId, sid) })
    return () => { live = false }
  }, [sessionId, hydrateMeta])

  // Slash-command menu, sourced from the session's init `slash_commands` plus the
  // two natively-handled ones (/resume, /clear). Interactive commands the headless
  // channel can't run are handled here; the rest pass through as a normal turn.
  const showSlash = draft.startsWith('/') && !draft.includes(' ') && !draft.includes('\n')
  const q = draft.slice(1).toLowerCase()
  const suggestions = showSlash
    ? ['resume', 'clear', ...slashCommandsFor(sessionId)]
        .filter((c, i, a) => a.indexOf(c) === i)
        .filter((c) => c.toLowerCase().startsWith(q))
        .slice(0, 8)
    : []

  // Returns true if the command was handled natively (don't send as a turn).
  const runNative = (cmd: string): boolean => {
    if (cmd === '/resume') { setDraft(''); setShowResume(true); return true }
    if (cmd === '/clear') { setDraft(''); clearTranscript(sessionId); window.api.session.clear(sessionId); return true }
    return false
  }

  const submit = () => {
    const t = draft.trim()
    if (!t) return
    if (t.startsWith('/') && runNative(t)) return
    sendTurn(sessionId, draft)   // passthrough (incl. content slash commands)
    setDraft('')
  }

  const pickResume = async (meta: ConversationMeta) => {
    setShowResume(false)
    const events = await window.api.session.readConversation(cwd, meta.id)
    loadTranscript(sessionId, events)
    window.api.session.resumeInto(sessionId, meta.id)
  }

  return (
    <div className="relative flex flex-col h-full bg-ctp-base text-ctp-text">
      {showResume && <ResumePicker cwd={cwd} onPick={pickResume} onClose={() => setShowResume(false)} />}
      <MetaBar meta={meta} />
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        {items.length === 0 && (
          <div className="text-ctp-overlay text-xs select-none pt-6 text-center">
            Send a message to start the conversation.
          </div>
        )}
        {items.map((it) => <Item key={it.id} item={it} />)}

        {pending && (pending.toolName === 'AskUserQuestion' ? (
          <AskUserQuestionCard
            input={pending.input}
            // The answer rides back as updatedInput.answers — a record keyed by each
            // question's TEXT → the chosen label(s) as a string (verified against the
            // CLI). The CLI then completes the tool with those answers.
            onAnswer={(answers) => respond(sessionId, pending.requestId, { behavior: 'allow', updatedInput: { ...(pending.input as Record<string, unknown>), answers } })}
            onDismiss={() => respond(sessionId, pending.requestId, { behavior: 'deny', message: 'Dismissed by user' })}
          />
        ) : (
          <PermissionCard
            toolName={pending.toolName}
            description={pending.description}
            input={pending.input}
            suggestions={pending.suggestions}
            onAllow={() => respond(sessionId, pending.requestId, { behavior: 'allow' })}
            onAllowAlways={() => respond(sessionId, pending.requestId, { behavior: 'allow', updatedPermissions: pending.suggestions })}
            onDeny={() => respond(sessionId, pending.requestId, { behavior: 'deny', message: 'Denied by user' })}
          />
        ))}

        {state === 'running' && !pending && (
          <div className="flex items-center gap-2 text-ctp-overlay text-xs">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-ctp-green animate-pulse" />
            Working… <span className="text-ctp-surface2">(Esc to interrupt)</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="relative shrink-0 border-t border-ctp-surface0 p-2">
        {suggestions.length > 0 && (
          <div className="absolute bottom-full left-2 mb-1 w-64 rounded border border-ctp-surface1 bg-ctp-mantle shadow-lg overflow-hidden z-10">
            {suggestions.map((c) => {
              const native = c === 'resume' || c === 'clear'
              return (
                <button
                  key={c}
                  onClick={() => { if (!runNative('/' + c)) setDraft('/' + c + ' ') }}
                  className="w-full text-left px-3 py-1 text-xs hover:bg-ctp-surface0/60 flex justify-between"
                >
                  <span className="font-mono text-ctp-text">/{c}</span>
                  {native && <span className="text-[10px] text-ctp-overlay">native</span>}
                </button>
              )
            })}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            else if (e.key === 'Escape' && running) { e.preventDefault(); interrupt(sessionId) }
          }}
          rows={2}
          placeholder={running ? 'Claude is working… (Esc to interrupt)' : 'Message Claude…  (Enter to send, Shift+Enter for newline, / for commands)'}
          className="w-full resize-none rounded bg-ctp-mantle border border-ctp-surface0 focus:border-ctp-blue/60 outline-none px-3 py-2 text-sm placeholder:text-ctp-overlay"
        />
        <div className="flex justify-between items-center mt-1 px-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ctp-overlay">{state}</span>
            <button onClick={() => setShowResume(true)} className="text-[10px] text-ctp-overlay hover:text-ctp-text">
              ⟲ Resume
            </button>
          </div>
          <div className="flex gap-2">
            {running && (
              <button onClick={() => interrupt(sessionId)} className="text-xs px-2 py-0.5 rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-subtext">
                Interrupt
              </button>
            )}
            <button
              onClick={submit}
              disabled={!draft.trim()}
              className="text-xs px-3 py-0.5 rounded bg-ctp-blue/80 hover:bg-ctp-blue text-ctp-base font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg bg-ctp-blue/15 border border-ctp-blue/20 px-3 py-2 whitespace-pre-wrap">
            {item.text}
          </div>
        </div>
      )
    case 'text':
      return (
        <div className="leading-relaxed break-words">
          <Markdown text={item.text} />
          {item.streaming && <span className="inline-block w-1.5 h-3.5 -mb-0.5 ml-0.5 bg-ctp-text/70 animate-pulse" />}
        </div>
      )
    case 'thinking':
      // While streaming, show the reasoning live (dim); once done, collapse it.
      return item.streaming
        ? <div className="text-ctp-overlay italic whitespace-pre-wrap text-xs">{item.text}<span className="inline-block w-1 h-3 ml-0.5 bg-ctp-overlay animate-pulse" /></div>
        : <Collapsible label="Thinking" tone="overlay" body={item.text} />
    case 'tool_use':
      return (
        <div className="rounded border border-ctp-surface0 bg-ctp-mantle/60 px-3 py-1.5 text-xs space-y-1">
          <div className="text-ctp-mauve font-medium">
            ⚙ {toolHeadline(item.name, (item.input ?? {}) as Record<string, unknown>)}
            <span className="text-ctp-overlay font-normal ml-1.5">· {item.name}</span>
          </div>
          <ToolDetail name={item.name} input={item.input} />
        </div>
      )
    case 'tool_result':
      return (
        <Collapsible
          label={item.isError ? 'Tool error' : 'Tool result'}
          tone={item.isError ? 'red' : 'subtext'}
          body={item.content}
        />
      )
    case 'result':
      return (
        <div className="border-t border-ctp-surface0/60 pt-1.5 space-y-1">
          {item.errorText && (
            <div className="rounded border border-ctp-red/40 bg-ctp-red/10 px-2.5 py-1.5 text-xs text-ctp-red whitespace-pre-wrap">
              ⚠ {item.errorText}
            </div>
          )}
          <div className="text-[10px] text-ctp-overlay">
            {item.durationMs != null ? `${(item.durationMs / 1000).toFixed(1)}s` : ''}
            {item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ''}
          </div>
        </div>
      )
    case 'notice':
      return <div className="text-[11px] text-ctp-red/80 whitespace-pre-wrap font-mono">{item.text}</div>
  }
}

function Collapsible({ label, body, tone }: { label: string; body: string; tone: 'overlay' | 'subtext' | 'red' }) {
  const [open, setOpen] = useState(false)
  const color = tone === 'red' ? 'text-ctp-red/80' : tone === 'subtext' ? 'text-ctp-subtext' : 'text-ctp-overlay'
  const preview = body.length > 120 ? body.slice(0, 120) + '…' : body
  return (
    <div className={`text-xs ${color}`}>
      <button onClick={() => setOpen((v) => !v)} className="hover:text-ctp-text">
        {open ? '▾' : '▸'} {label}
      </button>
      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] pl-4 opacity-90">
        {open ? body : preview}
      </pre>
    </div>
  )
}

// Compact token count: 210_234 → "210k", 1_000_000 → "1000k" (matches the CLI's
// own phrasing). Sub-1k values are shown as-is.
function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// A friendly name for a rate-limit window. 'five_hour' is the rolling session
// budget; 'weekly'/'seven_day' the weekly one.
function limitLabel(type?: string): string {
  if (type === 'five_hour') return 'Session'
  if (type === 'weekly' || type === 'seven_day') return 'Weekly'
  return (type ?? 'limit').replace(/_/g, ' ')
}
const LIMIT_RANK: Record<string, number> = { five_hour: 0, weekly: 1, seven_day: 1 }

// Always-visible status bar: model, real context usage (tokens + %), cost, and a
// chip per rate-limit window (session / weekly) with reset time + warnings.
function MetaBar({ meta }: { meta: SessionMeta }) {
  const tokens = meta.contextTokens
  const win = meta.contextWindow
  const pct = win && tokens != null ? Math.min(100, Math.round((tokens / win) * 100)) : undefined
  const barColor = pct == null ? 'bg-ctp-blue' : pct >= 92 ? 'bg-ctp-red' : pct >= 80 ? 'bg-ctp-yellow' : 'bg-ctp-blue'
  const limits = meta.limits
    ? Object.values(meta.limits).sort((a, b) => (LIMIT_RANK[a.rateLimitType ?? ''] ?? 9) - (LIMIT_RANK[b.rateLimitType ?? ''] ?? 9))
    : []

  return (
    <div className="shrink-0 flex items-center gap-3 px-3 py-1 border-b border-ctp-surface0 text-[10px] text-ctp-overlay">
      <span className="text-ctp-subtext font-mono" title={meta.model ? undefined : 'The model and context appear after your first message this session.'}>
        {meta.model ?? 'model · after first message'}
      </span>

      <span className="flex items-center gap-1.5" title="Context window used (input + cached tokens) vs the model's limit">
        <span className="text-ctp-overlay">ctx</span>
        <span className="inline-block w-16 h-1.5 rounded bg-ctp-surface0 overflow-hidden align-middle">
          {pct !== undefined && <span className={`block h-full ${barColor}`} style={{ width: `${pct}%` }} />}
        </span>
        {tokens != null && win
          ? <span className="font-mono text-ctp-subtext">{fmtTokens(tokens)} / {fmtTokens(win)} ({pct}%)</span>
          : <span className="text-ctp-surface2">—</span>}
      </span>

      {limits.map((rl) => <RateChip key={rl.rateLimitType ?? 'limit'} rl={rl} />)}

      {meta.costUsd !== undefined && (
        <span className="ml-auto text-ctp-overlay" title="Total cost this session">cost ${meta.costUsd.toFixed(4)}</span>
      )}
    </div>
  )
}

function RateChip({ rl }: { rl: RateLimitInfo }) {
  const status = rl.status ?? 'allowed'
  const ok = status === 'allowed'
  const bad = /reject|exceed|block|limit_reached/i.test(status)
  const color = bad ? 'text-ctp-red' : ok ? 'text-ctp-overlay' : 'text-ctp-yellow'
  const resets = rl.resetsAt
    ? `resets ${new Date(rl.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
    : ''
  const usedPct = typeof rl.percentUsed === 'number' ? ` ${Math.round(rl.percentUsed)}%` : ''
  const label = limitLabel(rl.rateLimitType)
  return (
    <span className={color} title={`${label} limit: ${status}${rl.isUsingOverage ? ' (using overage)' : ''}${resets ? ` · ${resets}` : ''}`}>
      {ok ? '●' : '▲'} {label}{usedPct}{rl.isUsingOverage ? ' · overage' : ''}
      {rl.resetsAt ? <span className="text-ctp-surface2"> · {new Date(rl.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span> : null}
    </span>
  )
}

// Interactive AskUserQuestion: Claude asked the user to choose. Unlike other
// tools this isn't allow/deny — the user picks option(s) per question and the
// selection is fed back as the tool's answer (updatedInput.answers, keyed by
// question text). Single-select picks one; multiSelect toggles several; an
// "Other…" field allows a free-text answer (the answer value is a plain string).
interface AskQuestion { question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }
function AskUserQuestionCard({ input, onAnswer, onDismiss }: {
  input: unknown
  onAnswer: (answers: Record<string, string>) => void
  onDismiss: () => void
}) {
  const qs: AskQuestion[] = Array.isArray((input as { questions?: unknown })?.questions)
    ? ((input as { questions: AskQuestion[] }).questions)
    : []
  const [sel, setSel] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const toggle = (qi: number, label: string, multi: boolean) =>
    setSel((s) => {
      const cur = s[qi] ?? []
      if (!multi) return { ...s, [qi]: [label] }
      return { ...s, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })

  // Chosen option label(s) plus any free-text, joined — the CLI wants one string.
  const valueFor = (qi: number): string => {
    const chosen = [...(sel[qi] ?? [])]
    const o = other[qi]?.trim()
    if (o) chosen.push(o)
    return chosen.join(', ')
  }
  const answered = qs.length > 0 && qs.every((_, qi) => valueFor(qi).length > 0)

  const submit = () => {
    const answers: Record<string, string> = {}
    qs.forEach((q, qi) => { answers[q.question] = valueFor(qi) })
    onAnswer(answers)
  }

  return (
    <div className="rounded-lg border border-ctp-blue/50 bg-ctp-blue/10 px-3 py-2.5 space-y-3">
      {qs.map((q, qi) => (
        <div key={qi} className="space-y-1">
          <div className="text-xs text-ctp-text font-medium">{q.question}</div>
          <div className="flex flex-col gap-1">
            {q.options.map((op, oi) => {
              const active = (sel[qi] ?? []).includes(op.label)
              return (
                <button
                  key={oi}
                  onClick={() => toggle(qi, op.label, !!q.multiSelect)}
                  className={`text-left text-xs px-2 py-1 rounded border transition-colors ${active ? 'border-ctp-blue bg-ctp-blue/20 text-ctp-text' : 'border-ctp-surface1 text-ctp-subtext hover:bg-ctp-surface0'}`}
                >
                  <span className="font-medium">{op.label}</span>
                  {op.description ? <span className="text-ctp-overlay"> — {op.description}</span> : null}
                </button>
              )
            })}
            <input
              value={other[qi] ?? ''}
              onChange={(e) => setOther((s) => ({ ...s, [qi]: e.target.value }))}
              placeholder="Other…"
              className="text-xs px-2 py-1 rounded bg-ctp-surface0 text-ctp-text outline-none placeholder:text-ctp-overlay focus:ring-1 focus:ring-ctp-blue"
            />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <button onClick={submit} disabled={!answered} className="text-xs px-3 py-0.5 rounded bg-ctp-blue/80 hover:bg-ctp-blue text-ctp-base font-medium disabled:opacity-40 disabled:cursor-not-allowed">
          Submit
        </button>
        <button onClick={onDismiss} className="text-xs px-3 py-0.5 rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-subtext">
          Dismiss
        </button>
      </div>
    </div>
  )
}

function PermissionCard({
  toolName, description, input, suggestions, onAllow, onAllowAlways, onDeny,
}: {
  toolName: string; description?: string; input: unknown; suggestions: unknown[]
  onAllow: () => void; onAllowAlways: () => void; onDeny: () => void
}) {
  const headline = toolHeadline(toolName, (input ?? {}) as Record<string, unknown>)
  const always = suggestions.length > 0 ? suggestionLabel(suggestions) : undefined
  return (
    <div className="rounded-lg border border-ctp-yellow/50 bg-ctp-yellow/10 px-3 py-2.5">
      <div className="text-xs text-ctp-yellow font-medium mb-0.5">
        {headline}?
      </div>
      <div className="text-[10px] text-ctp-overlay mb-1.5">
        {toolName}{description && description !== headline ? ` · ${description}` : ''}
      </div>
      <div className="text-[11px] text-ctp-subtext max-h-48 overflow-y-auto mb-2 pr-1">
        <ToolDetail name={toolName} input={input} />
      </div>
      <div className="flex gap-2 flex-wrap">
        <button onClick={onAllow} className="text-xs px-3 py-0.5 rounded bg-ctp-green/80 hover:bg-ctp-green text-ctp-base font-medium">
          Allow once
        </button>
        {always && (
          <button onClick={onAllowAlways} className="text-xs px-3 py-0.5 rounded bg-ctp-green/20 hover:bg-ctp-green/30 text-ctp-green font-medium">
            {always}
          </button>
        )}
        <button onClick={onDeny} className="text-xs px-3 py-0.5 rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-subtext">
          Deny
        </button>
      </div>
    </div>
  )
}

// Label the "allow always" button from the request's first permission suggestion.
function suggestionLabel(suggestions: unknown[]): string {
  const s = suggestions[0] as { type?: string; mode?: string; destination?: string; rules?: Array<{ toolName?: string; ruleContent?: string }> }
  if (s?.type === 'setMode') {
    if (s.mode === 'acceptEdits') return 'Accept edits (session)'
    return `Switch to ${s.mode}`
  }
  if (s?.type === 'addRules') {
    const r = s.rules?.[0]
    const name = r ? (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName) : ''
    const persists = s.destination && s.destination !== 'session'
    return `Always allow ${name}${persists ? '' : ' (session)'}`
  }
  return "Allow, don't ask"
}
