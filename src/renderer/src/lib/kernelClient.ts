export type KernelStatus = 'starting' | 'idle' | 'busy' | 'dead'

export type CellOutput =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'result'; data: Record<string, string>; executionCount: number }
  | { type: 'display'; data: Record<string, string> }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] }

export class KernelClient {
  private ws: WebSocket | null = null
  private sessionId = crypto.randomUUID()
  private pending = new Map<string, { onOutput: (o: CellOutput) => void; onDone: (n: number) => void }>()
  onStatusChange?: (status: KernelStatus) => void

  constructor(
    private baseUrl: string,
    private token: string,
    readonly kernelId: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws')
      this.ws = new WebSocket(`${wsUrl}/api/kernels/${this.kernelId}/channels?token=${this.token}`)
      this.ws.onopen = () => resolve()
      this.ws.onerror = (e) => reject(e)
      this.ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data))
    })
  }

  private handleMessage(msg: Record<string, unknown>) {
    const header = msg.header as Record<string, string>
    const content = msg.content as Record<string, unknown>
    const parentId = (msg.parent_header as Record<string, string>)?.msg_id
    const entry = parentId ? this.pending.get(parentId) : undefined

    switch (header.msg_type) {
      case 'status':
        this.onStatusChange?.(content.execution_state as KernelStatus)
        break
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
    }
  }

  execute(code: string, onOutput: (o: CellOutput) => void, onDone: (count: number) => void): string {
    const msgId = crypto.randomUUID()
    this.pending.set(msgId, { onOutput, onDone })
    this.ws?.send(JSON.stringify({
      header: { msg_id: msgId, msg_type: 'execute_request', session: this.sessionId, username: '', date: new Date().toISOString(), version: '5.3' },
      parent_header: {},
      metadata: {},
      content: { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true },
      buffers: [],
      channel: 'shell',
    }))
    return msgId
  }

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
    this.ws?.close()
    this.ws = null
    this.pending.clear()
  }
}
