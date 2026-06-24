import type { Terminal } from '@xterm/xterm'

interface TerminalEntry {
  term: Terminal
  sendInput: (data: string) => void
}

export const terminalRegistry = new WeakMap<HTMLElement, TerminalEntry>()
