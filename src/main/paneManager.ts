import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import { homedir } from 'os'

export class PaneManager extends EventEmitter {
  private panes = new Map<string, pty.IPty>()

  create(cwd: string): string {
    const id = crypto.randomUUID()
    const shell = process.env.SHELL || '/bin/bash'

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || homedir(),
      env: process.env as Record<string, string>,
    })

    this.panes.set(id, ptyProcess)
    ptyProcess.onData((data) => this.emit('output', id, data))
    ptyProcess.onExit(() => {
      this.panes.delete(id)
      this.emit('exit', id)
    })

    return id
  }

  sendInput(id: string, data: string): void {
    this.panes.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.panes.get(id)?.resize(cols, rows)
  }

  destroy(id: string): void {
    this.panes.get(id)?.kill()
    this.panes.delete(id)
  }
}
