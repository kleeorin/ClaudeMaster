export type KernelStatus = 'starting' | 'idle' | 'busy' | 'dead'

export type CellOutput =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'result'; data: Record<string, string>; executionCount: number }
  | { type: 'display'; data: Record<string, string> }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] }

// A `null` count means the execution ended without a real reply (the socket
// dropped mid-run); the cell should just clear its running state, not stamp a
// bogus [n] execution count.
type DoneFn = (count: number | null) => void

// How long to wait between liveness pings, and how long a ping may go unanswered
// before we treat the socket as a dead-but-not-closed half-open connection. The
// browser WebSocket API gives us no ping frame, so we send a kernel_info_request
// and treat *any* inbound traffic as proof the socket is alive.
const HEARTBEAT_MS = 25_000
const HEARTBEAT_TIMEOUT_MS = 8_000
// Cap reconnect attempts before giving up and marking the kernel dead.
const MAX_RECONNECT = 5

export class KernelClient {
  private ws: WebSocket | null = null
  private sessionId = crypto.randomUUID()
  private pending = new Map<string, { onOutput: (o: CellOutput) => void; onDone: DoneFn }>()
  onStatusChange?: (status: KernelStatus) => void

  // Only auto-reconnect after we've had at least one good connection — an initial
  // failure should surface to the caller, not silently retry forever.
  private everConnected = false
  private disposed = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private hbTimer: ReturnType<typeof setInterval> | null = null
  private hbDeadline: ReturnType<typeof setTimeout> | null = null
  // msg_id of the last heartbeat ping, so we can ignore the transient 'busy' it
  // provokes and avoid flickering the status dot every heartbeat.
  private hbMsgId: string | null = null

  constructor(
    private baseUrl: string,
    private token: string,
    readonly kernelId: string,
  ) {}

  // Initial connection. Rejects if the very first open fails (caller marks the
  // kernel dead); once open, later drops are handled by auto-reconnect instead.
  connect(): Promise<void> {
    return this.openSocket()
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws')
      const ws = new WebSocket(`${wsUrl}/api/kernels/${this.kernelId}/channels?token=${this.token}`)
      this.ws = ws
      ws.onopen = () => {
        this.everConnected = true
        this.reconnectAttempts = 0
        this.startHeartbeat() // also pings immediately, restoring status after a reconnect
        resolve()
      }
      // onerror fires just before onclose; let handleClose own the recovery so we
      // don't schedule a reconnect twice. Only reject the (initial) connect promise.
      ws.onerror = (e) => reject(e)
      ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data))
      ws.onclose = () => this.handleClose()
    })
  }

  private handleMessage(msg: Record<string, unknown>) {
    // Any inbound frame proves the socket is alive — clear the pending liveness
    // deadline (see ping()).
    this.clearHeartbeatDeadline()

    const header = msg.header as Record<string, string>
    const content = msg.content as Record<string, unknown>
    const parentId = (msg.parent_header as Record<string, string>)?.msg_id
    const entry = parentId ? this.pending.get(parentId) : undefined

    switch (header.msg_type) {
      case 'status': {
        const state = content.execution_state as KernelStatus
        // Skip the momentary 'busy' our own heartbeat causes (its 'idle' still
        // passes through, reflecting the kernel's real state).
        if (state === 'busy' && parentId && parentId === this.hbMsgId) break
        this.onStatusChange?.(state)
        break
      }
      case 'stream':
        entry?.onOutput({ type: 'stream', name: content.name as 'stdout' | 'stderr', text: content.text as string })
        break
      case 'execute_result':
        entry?.onOutput({ type: 'result', data: content.data as Record<string, string>, executionCount: content.execution_count as number })
        break
      case 'display_data':
        entry?.onOutput({ type: 'display', data: content.data as Record<string, string> })
        break
      case 'error':
        entry?.onOutput({ type: 'error', ename: content.ename as string, evalue: content.evalue as string, traceback: content.traceback as string[] })
        break
      case 'execute_reply':
        if (entry && parentId) {
          entry.onDone(content.execution_count as number)
          this.pending.delete(parentId)
        }
        break
      // kernel_info_reply is our heartbeat's response — handled purely by the
      // clearHeartbeatDeadline() above; nothing else to do.
    }
  }

  execute(code: string, onOutput: (o: CellOutput) => void, onDone: DoneFn): string {
    const msgId = crypto.randomUUID()
    // Guard: a null/closed socket would otherwise silently swallow the request (or
    // throw), leaving the cell spinning forever. Fail it visibly instead.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      onOutput({
        type: 'error',
        ename: 'KernelConnectionError',
        evalue: 'The kernel connection is not open. Try Restart kernel.',
        traceback: [],
      })
      onDone(null)
      return msgId
    }
    this.pending.set(msgId, { onOutput, onDone })
    try {
      this.ws.send(JSON.stringify({
        header: { msg_id: msgId, msg_type: 'execute_request', session: this.sessionId, username: '', date: new Date().toISOString(), version: '5.3' },
        parent_header: {},
        metadata: {},
        content: { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true },
        buffers: [],
        channel: 'shell',
      }))
    } catch (err) {
      this.pending.delete(msgId)
      onOutput({ type: 'error', ename: 'KernelSendError', evalue: `Failed to send to kernel: ${String(err)}`, traceback: [] })
      onDone(null)
    }
    return msgId
  }

  // ---- Connection health -------------------------------------------------

  private startHeartbeat() {
    this.stopHeartbeat()
    this.hbTimer = setInterval(() => this.ping(), HEARTBEAT_MS)
    this.ping() // fire one now so a reconnected kernel promptly re-reports its status
  }

  private stopHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null }
    this.clearHeartbeatDeadline()
  }

  private clearHeartbeatDeadline() {
    if (this.hbDeadline) { clearTimeout(this.hbDeadline); this.hbDeadline = null }
  }

  // Send a cheap request and expect *some* traffic back shortly. Silence past the
  // timeout means a half-open socket (e.g. a dead SSH tunnel) — force a reconnect.
  private ping() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const msgId = crypto.randomUUID()
    this.hbMsgId = msgId
    try {
      this.ws.send(JSON.stringify({
        header: { msg_id: msgId, msg_type: 'kernel_info_request', session: this.sessionId, username: '', date: new Date().toISOString(), version: '5.3' },
        parent_header: {},
        metadata: {},
        content: {},
        buffers: [],
        channel: 'shell',
      }))
    } catch {
      this.forceReconnect()
      return
    }
    this.clearHeartbeatDeadline()
    this.hbDeadline = setTimeout(() => this.forceReconnect(), HEARTBEAT_TIMEOUT_MS)
  }

  // Tear down a socket we believe is dead and drive the reconnect path ourselves
  // (a half-open socket may never emit 'close' on its own).
  private forceReconnect() {
    if (this.disposed) return
    const ws = this.ws
    if (ws) {
      ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.onopen = null
      try { ws.close() } catch { /* already closing */ }
    }
    this.ws = null
    this.handleClose()
  }

  private handleClose() {
    this.stopHeartbeat()
    if (this.disposed || !this.everConnected) return // deliberate close, or never got up
    // Surface the drop: clear any spinning cells with an error, show reconnecting,
    // and start trying to get back.
    this.failPending('Kernel connection lost — reconnecting…')
    this.onStatusChange?.('starting')
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      this.onStatusChange?.('dead')
      return
    }
    const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disposed) return
      this.openSocket().catch(() => this.scheduleReconnect())
    }, delay)
  }

  private failPending(message: string) {
    for (const { onOutput, onDone } of this.pending.values()) {
      onOutput({ type: 'error', ename: 'KernelConnectionError', evalue: message, traceback: [] })
      onDone(null)
    }
    this.pending.clear()
  }

  // ---- Server-side actions (unchanged) -----------------------------------

  interrupt(): Promise<void> {
    return fetch(`${this.baseUrl}/api/kernels/${this.kernelId}/interrupt`, {
      method: 'POST',
      headers: { Authorization: `token ${this.token}` },
    }).then(() => undefined)
  }

  restart(): Promise<void> {
    return fetch(`${this.baseUrl}/api/kernels/${this.kernelId}/restart`, {
      method: 'POST',
      headers: { Authorization: `token ${this.token}` },
    }).then(() => undefined)
  }

  // Ask the server to shut the kernel down (best-effort). Use before dispose()
  // when permanently discarding a kernel, e.g. switching to another kernelspec.
  shutdown(): Promise<void> {
    return fetch(`${this.baseUrl}/api/kernels/${this.kernelId}`, {
      method: 'DELETE',
      headers: { Authorization: `token ${this.token}` },
    }).then(() => undefined).catch(() => undefined)
  }

  dispose(): void {
    this.disposed = true
    this.stopHeartbeat()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null }
    this.failPending('Kernel disposed.')
  }
}
