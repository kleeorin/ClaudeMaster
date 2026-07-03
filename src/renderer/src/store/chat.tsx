import {
  createContext, useContext, useReducer, useEffect, useCallback, useRef, type ReactNode,
} from 'react'
import type { ClaudeEvent, PermissionRequest, PermissionDecision } from '../../../shared/types'

// One rendered entry in a session's transcript. Built from completed stream-json
// events (assistant / user tool_result / result). Token-level streaming of text
// (via stream_event deltas) is layered on in step 2; step 1 renders per block.
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string; streaming?: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming?: boolean }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; toolUseId: string; isError: boolean; content: string }
  | { kind: 'result'; id: string; isError: boolean; costUsd?: number; durationMs?: number; errorText?: string }
  | { kind: 'notice'; id: string; text: string }

export interface RateLimitInfo {
  status?: string          // 'allowed' | 'warning' | 'rejected' | …
  resetsAt?: number        // epoch seconds when this window resets
  rateLimitType?: string   // 'five_hour' | 'weekly' | 'seven_day' | …
  overageStatus?: string
  isUsingOverage?: boolean
  percentUsed?: number     // only present on some tiers; shown when available
}
export interface SessionMeta {
  model?: string
  contextTokens?: number
  contextWindow?: number
  costUsd?: number
  // Keyed by rateLimitType so the 5-hour (session) and weekly windows coexist
  // instead of overwriting each other.
  limits?: Record<string, RateLimitInfo>
}

interface State {
  transcripts: Record<string, TranscriptItem[]>
  pending: Record<string, PermissionRequest | undefined>
  slash: Record<string, string[]>            // slash_commands from each session's init event
  open: Record<string, Record<number, string>>  // session → (stream block index → item id)
  meta: Record<string, SessionMeta>
}

type Action =
  | { type: 'APPEND'; sessionId: string; items: TranscriptItem[] }
  | { type: 'LOAD'; sessionId: string; items: TranscriptItem[] }   // replace (resume)
  | { type: 'STREAM_START'; sessionId: string; index: number; kind: 'text' | 'thinking' }
  | { type: 'STREAM_DELTA'; sessionId: string; index: number; text: string }
  | { type: 'STREAM_STOP'; sessionId: string; index: number }
  | { type: 'SET_PENDING'; sessionId: string; req: PermissionRequest }
  | { type: 'CLEAR_PENDING'; sessionId: string }
  | { type: 'SET_SLASH'; sessionId: string; commands: string[] }
  | { type: 'SET_META'; sessionId: string; meta: Partial<SessionMeta> }
  | { type: 'SET_LIMIT'; sessionId: string; limitType: string; info: RateLimitInfo }
  | { type: 'CLEAR'; sessionId: string }

let seq = 0
const nextId = () => `i${++seq}`

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'APPEND': {
      const prev = state.transcripts[action.sessionId] ?? []
      return { ...state, transcripts: { ...state.transcripts, [action.sessionId]: [...prev, ...action.items] } }
    }
    case 'LOAD': {
      const open = { ...state.open }; delete open[action.sessionId]
      return { ...state, open, transcripts: { ...state.transcripts, [action.sessionId]: action.items } }
    }
    case 'STREAM_START': {
      const id = nextId()
      const prev = state.transcripts[action.sessionId] ?? []
      return {
        ...state,
        transcripts: { ...state.transcripts, [action.sessionId]: [...prev, { kind: action.kind, id, text: '', streaming: true }] },
        open: { ...state.open, [action.sessionId]: { ...(state.open[action.sessionId] ?? {}), [action.index]: id } },
      }
    }
    case 'STREAM_DELTA': {
      const id = state.open[action.sessionId]?.[action.index]
      if (!id) return state
      const prev = state.transcripts[action.sessionId] ?? []
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [action.sessionId]: prev.map((it) =>
            it.id === id && (it.kind === 'text' || it.kind === 'thinking') ? { ...it, text: it.text + action.text } : it),
        },
      }
    }
    case 'STREAM_STOP': {
      const openS = { ...(state.open[action.sessionId] ?? {}) }
      const id = openS[action.index]
      delete openS[action.index]
      const prev = state.transcripts[action.sessionId] ?? []
      return {
        ...state,
        open: { ...state.open, [action.sessionId]: openS },
        transcripts: {
          ...state.transcripts,
          [action.sessionId]: prev.map((it) =>
            it.id === id && (it.kind === 'text' || it.kind === 'thinking') ? { ...it, streaming: false } : it),
        },
      }
    }
    case 'SET_META':
      return { ...state, meta: { ...state.meta, [action.sessionId]: { ...(state.meta[action.sessionId] ?? {}), ...action.meta } } }
    case 'SET_LIMIT': {
      const m = state.meta[action.sessionId] ?? {}
      return {
        ...state,
        meta: { ...state.meta, [action.sessionId]: { ...m, limits: { ...(m.limits ?? {}), [action.limitType]: action.info } } },
      }
    }
    case 'SET_PENDING':
      return { ...state, pending: { ...state.pending, [action.sessionId]: action.req } }
    case 'CLEAR_PENDING': {
      const pending = { ...state.pending }
      delete pending[action.sessionId]
      return { ...state, pending }
    }
    case 'SET_SLASH':
      return { ...state, slash: { ...state.slash, [action.sessionId]: action.commands } }
    case 'CLEAR': {
      const transcripts = { ...state.transcripts }; delete transcripts[action.sessionId]
      const pending = { ...state.pending }; delete pending[action.sessionId]
      const slash = { ...state.slash }; delete slash[action.sessionId]
      const open = { ...state.open }; delete open[action.sessionId]
      const meta = { ...state.meta }; delete meta[action.sessionId]
      return { transcripts, pending, slash, open, meta }
    }
    default:
      return state
  }
}

// Normalize a tool_result's `content` (string | block array) to display text.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('')
  }
  return content == null ? '' : JSON.stringify(content)
}

// Best-effort human message for an errored result event. The CLI puts the reason
// in different places depending on the failure (API error vs max-turns vs limit),
// so we probe several fields and phrase common cases in plain language.
function resultErrorText(e: ClaudeEvent): string {
  const r = e as Record<string, unknown>
  const raw = [r.result, r.api_error_status, r.error, r.subtype]
    .map((v) => (typeof v === 'string' ? v : v ? JSON.stringify(v) : ''))
    .find((s) => s && s !== 'success' && s !== 'null') ?? 'The turn ended with an error.'
  const s = String(raw)
  if (/usage limit|rate.?limit|429|quota/i.test(s)) return `Usage limit reached — ${s}`
  if (/overloaded|529|503/i.test(s)) return `The model is overloaded right now — ${s}`
  if (/max.?turns/i.test(s)) return 'Stopped: reached the maximum number of turns for one request.'
  if (/error_during_execution/i.test(s)) return 'Claude hit an internal error partway through this turn (error_during_execution). This is usually transient — send the message again.'
  if (/error_max_output|max.?tokens/i.test(s)) return 'Stopped: hit the maximum output length for one turn.'
  // Unknown subtype like "some_error_code" → a readable sentence.
  return /^[a-z0-9_]+$/i.test(s) ? `The turn ended with an error (${s}).` : s
}

// Turn one raw stream-json event into transcript items (may be several, e.g. an
// assistant message with multiple content blocks).
function itemsFromEvent(e: ClaudeEvent, fromReplay = false): TranscriptItem[] {
  const out: TranscriptItem[] = []
  if (e.type === 'assistant') {
    const content = (e as { message?: { content?: unknown[] } }).message?.content ?? []
    for (const b of content as Array<Record<string, unknown>>) {
      // text/thinking arrive token-by-token via stream_event (see handler); take
      // only tool_use here to avoid double-rendering. `fromReplay` (resume) has no
      // stream events, so it re-enables text/thinking (see loadTranscript).
      if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: nextId(), name: String(b.name), input: b.input })
      else if (fromReplay && b.type === 'text' && b.text) out.push({ kind: 'text', id: nextId(), text: String(b.text) })
      else if (fromReplay && b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', id: nextId(), text: String(b.thinking) })
    }
  } else if (e.type === 'user') {
    const content = (e as { message?: { content?: unknown[] } }).message?.content ?? []
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_result') {
        out.push({
          kind: 'tool_result', id: nextId(),
          toolUseId: String(b.tool_use_id), isError: b.is_error === true, content: resultText(b.content),
        })
      }
    }
  } else if (e.type === 'result') {
    const isError = (e as { is_error?: boolean }).is_error === true
      || /error/i.test(String((e as { subtype?: string }).subtype ?? ''))
    out.push({
      kind: 'result', id: nextId(),
      isError,
      costUsd: (e as { total_cost_usd?: number }).total_cost_usd,
      durationMs: (e as { duration_ms?: number }).duration_ms,
      errorText: isError ? resultErrorText(e) : undefined,
    })
  } else if (e.type === 'stderr' && e.text) {
    out.push({ kind: 'notice', id: nextId(), text: String(e.text) })
  }
  return out
}

// Translate one wrapped Anthropic streaming event into stream actions.
function handleStreamEvent(dispatch: (a: Action) => void, sessionId: string, ev?: Record<string, unknown>): void {
  if (!ev) return
  const index = ev.index as number
  if (ev.type === 'content_block_start') {
    const bt = (ev.content_block as { type?: string })?.type
    if (bt === 'text' || bt === 'thinking') dispatch({ type: 'STREAM_START', sessionId, index, kind: bt })
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta as { type?: string; text?: string; thinking?: string }
    if (d?.type === 'text_delta' && d.text) dispatch({ type: 'STREAM_DELTA', sessionId, index, text: d.text })
    else if (d?.type === 'thinking_delta' && d.thinking) dispatch({ type: 'STREAM_DELTA', sessionId, index, text: d.thinking })
  } else if (ev.type === 'content_block_stop') {
    dispatch({ type: 'STREAM_STOP', sessionId, index })
  }
}

// Cost (cumulative — correct) + context window size from a result event. NOTE:
// context *fill* is NOT taken here — result.usage is cumulative over a turn's many
// internal model calls, and cache_read re-counts the whole prefix each call, so the
// sum runs far past the window (the "1280k / 1000k" bug). Fill comes per assistant
// message instead (contextFromAssistant).
function metaFromResult(e: ClaudeEvent): Partial<SessionMeta> {
  const meta: Partial<SessionMeta> = {}
  const cost = (e as { total_cost_usd?: unknown }).total_cost_usd
  if (typeof cost === 'number') meta.costUsd = cost
  const mu = (e as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage
  if (mu && typeof mu === 'object') {
    const cw = Object.values(mu)[0]?.contextWindow
    if (typeof cw === 'number') meta.contextWindow = cw
  }
  return meta
}

// Context fill = tokens the model processed as context on the LATEST call (input +
// both cache buckets), read from that assistant message's own usage. This is a
// single real request, so it can't exceed the window — the right gauge.
function contextFromAssistant(e: ClaudeEvent): Partial<SessionMeta> | null {
  const u = (e as { message?: { usage?: Record<string, number> } }).message?.usage
  if (!u) return null
  return { contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) }
}

interface ContextValue {
  transcriptFor: (sessionId: string) => TranscriptItem[]
  pendingFor: (sessionId: string) => PermissionRequest | undefined
  slashCommandsFor: (sessionId: string) => string[]
  metaFor: (sessionId: string) => SessionMeta
  hydrateMeta: (sessionId: string, claudeSessionId: string) => void
  sendTurn: (sessionId: string, text: string) => void
  interrupt: (sessionId: string) => void
  respond: (sessionId: string, requestId: string, decision: PermissionDecision) => void
  loadTranscript: (sessionId: string, events: ClaudeEvent[]) => void
  clearTranscript: (sessionId: string) => void
}

const ChatContext = createContext<ContextValue | null>(null)

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { transcripts: {}, pending: {}, slash: {}, open: {}, meta: {} })
  const stateRef = useRef(state); stateRef.current = state
  // live session id → claude session id (from every event's session_id). Lets us
  // persist/restore the status-bar meta by the durable conversation id, since the
  // model/context only reach us on init/result — after the first turn.
  const claudeSidRef = useRef<Record<string, string>>({})

  useEffect(() => {
    const offEvent = window.api.on.event((id, e) => {
      const sid = (e as { session_id?: unknown }).session_id
      if (typeof sid === 'string') claudeSidRef.current[id] = sid
      // init: capture slash-command catalog + model.
      if (e.type === 'system' && (e as { subtype?: string }).subtype === 'init') {
        const cmds = (e as { slash_commands?: unknown }).slash_commands
        if (Array.isArray(cmds)) dispatch({ type: 'SET_SLASH', sessionId: id, commands: cmds.map(String) })
        const model = (e as { model?: unknown }).model
        if (typeof model === 'string') dispatch({ type: 'SET_META', sessionId: id, meta: { model } })
        return
      }
      // Token-level streaming of text/thinking blocks.
      if (e.type === 'stream_event') {
        handleStreamEvent(dispatch, id, (e as { event?: Record<string, unknown> }).event)
        return
      }
      // App-control channel status (e.g. remote reverse tunnel failed). Surfaced
      // as a notice; the conversation itself is unaffected.
      if (e.type === 'app_control') {
        const reason = (e as { reason?: string }).reason
        if (reason) dispatch({ type: 'APPEND', sessionId: id, items: [{ kind: 'notice', id: nextId(), text: `⚠ ${reason}` }] })
        return
      }
      // Proactive rate/usage limit info (drives the session/weekly chips). Keyed
      // by window type so five_hour and weekly don't overwrite each other.
      if (e.type === 'rate_limit_event') {
        const info = (e as { rate_limit_info?: RateLimitInfo }).rate_limit_info
        if (info) dispatch({ type: 'SET_LIMIT', sessionId: id, limitType: info.rateLimitType ?? 'limit', info })
        return
      }
      // Each assistant message reports the context size of that model call.
      if (e.type === 'assistant') {
        const cm = contextFromAssistant(e)
        if (cm) dispatch({ type: 'SET_META', sessionId: id, meta: cm })
      }
      // Turn end: cumulative cost + context-window size.
      if (e.type === 'result') {
        dispatch({ type: 'SET_META', sessionId: id, meta: metaFromResult(e) })
      }
      const items = itemsFromEvent(e)
      if (items.length) dispatch({ type: 'APPEND', sessionId: id, items })
    })
    const offPerm = window.api.on.permission((id, req) => {
      dispatch({ type: 'SET_PENDING', sessionId: id, req })
    })
    // A finished/interrupted turn clears any stale prompt defensively.
    const offState = window.api.on.stateChange((id, state) => {
      if (state === 'idle' && stateRef.current.pending[id]) dispatch({ type: 'CLEAR_PENDING', sessionId: id })
    })
    return () => { offEvent(); offPerm(); offState() }
  }, [])

  // Persist each session's status-bar meta by its durable claude session id, so a
  // reload/restore can show model + context + limits immediately (before the first
  // turn re-emits init/result). Cheap; meta is tiny.
  useEffect(() => {
    for (const [liveId, m] of Object.entries(state.meta)) {
      const sid = claudeSidRef.current[liveId]
      if (sid && m.model) { try { localStorage.setItem(`cm.meta.${sid}`, JSON.stringify(m)) } catch { /* quota */ } }
    }
  }, [state.meta])

  // Populate a session's meta from the last persisted snapshot for its claude
  // session id. No-op once live data has arrived (don't clobber a fresh init).
  const hydrateMeta = useCallback((sessionId: string, claudeSessionId: string) => {
    if (stateRef.current.meta[sessionId]?.model) return
    let raw: string | null = null
    try { raw = localStorage.getItem(`cm.meta.${claudeSessionId}`) } catch { /* ignore */ }
    if (!raw) return
    try {
      const m = JSON.parse(raw) as SessionMeta
      claudeSidRef.current[sessionId] = claudeSessionId
      dispatch({ type: 'SET_META', sessionId, meta: m })
    } catch { /* stale/corrupt entry */ }
  }, [])

  const sendTurn = useCallback((sessionId: string, text: string) => {
    const t = text.trim()
    if (!t) return
    // Optimistic local echo (we don't pass --replay-user-messages, so no dup).
    dispatch({ type: 'APPEND', sessionId, items: [{ kind: 'user', id: nextId(), text: t }] })
    window.api.session.sendTurn(sessionId, t)
  }, [])

  const interrupt = useCallback((sessionId: string) => {
    window.api.session.interrupt(sessionId)
  }, [])

  const respond = useCallback((sessionId: string, requestId: string, decision: PermissionDecision) => {
    window.api.session.respondPermission(sessionId, requestId, decision)
    dispatch({ type: 'CLEAR_PENDING', sessionId })
  }, [])

  // Replace a session's transcript with a resumed conversation's history. Replay
  // has no stream events, so text/thinking are taken from the assistant blocks.
  const loadTranscript = useCallback((sessionId: string, events: ClaudeEvent[]) => {
    const items = events.flatMap((e) => itemsFromEvent(e, true))
    dispatch({ type: 'LOAD', sessionId, items })
  }, [])

  // Full reset for /clear: wipe transcript, pending, and meta (context/cost). A
  // fresh init event (from the restarted engine) repopulates model + slash list.
  const clearTranscript = useCallback((sessionId: string) => {
    dispatch({ type: 'CLEAR', sessionId })
  }, [])

  const transcriptFor = useCallback((sessionId: string) => state.transcripts[sessionId] ?? [], [state.transcripts])
  const pendingFor = useCallback((sessionId: string) => state.pending[sessionId], [state.pending])
  const slashCommandsFor = useCallback((sessionId: string) => state.slash[sessionId] ?? [], [state.slash])
  const metaFor = useCallback((sessionId: string) => state.meta[sessionId] ?? {}, [state.meta])

  return (
    <ChatContext.Provider value={{ transcriptFor, pendingFor, slashCommandsFor, metaFor, hydrateMeta, sendTurn, interrupt, respond, loadTranscript, clearTranscript }}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChat(): ContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within ChatProvider')
  return ctx
}
