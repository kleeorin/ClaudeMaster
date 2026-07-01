import { useCallback, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { terminalRegistry } from '../lib/terminalRegistry'

export const CONTAINER_STYLE = { padding: '6px' } as const

const THEME = {
  background:          '#1e1e2e',
  foreground:          '#cdd6f4',
  cursor:              '#f5c2e7',
  cursorAccent:        '#1e1e2e',
  selectionBackground: '#45475a88',
  black:               '#45475a',
  red:                 '#f38ba8',
  green:               '#a6e3a1',
  yellow:              '#f9e2af',
  blue:                '#89b4fa',
  magenta:             '#f5c2e7',
  cyan:                '#94e2d5',
  white:               '#bac2de',
  brightBlack:         '#585b70',
  brightRed:           '#f38ba8',
  brightGreen:         '#a6e3a1',
  brightYellow:        '#f9e2af',
  brightBlue:          '#89b4fa',
  brightMagenta:       '#f5c2e7',
  brightCyan:          '#94e2d5',
  brightWhite:         '#a6adc8',
}

const OPTIONS = {
  theme: THEME,
  fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  cursorBlink: true,
  allowTransparency: false,
  scrollback: 50000,
} as const

export interface TerminalAPI {
  sendInput: (data: string) => void
  sendResize: (cols: number, rows: number) => void
  subscribeOutput: (cb: (data: string) => void) => () => void
}

interface TerminalOptions {
  /** Called whenever the viewport moves to / away from the bottom of the buffer. */
  onAtBottomChange?: (atBottom: boolean) => void
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  api: TerminalAPI,
  options: TerminalOptions = {},
): {
  fitRef: React.RefObject<FitAddon | null>
  focus: () => void
  scrollToBottom: () => void
} {
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const apiRef = useRef(api)
  apiRef.current = api
  const onAtBottomRef = useRef(options.onAtBottomChange)
  onAtBottomRef.current = options.onAtBottomChange

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal(OPTIONS)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const rafId = requestAnimationFrame(() => { fit.fit(); reportAtBottom() })
    fitRef.current = fit
    termRef.current = term

    term.onData((data) => apiRef.current.sendInput(data))
    term.onResize(({ cols, rows }) => apiRef.current.sendResize(cols, rows))

    terminalRegistry.set(el, { term, sendInput: (data) => apiRef.current.sendInput(data) })

    // Report bottom-state transitions so the view can offer a "jump to bottom"
    // affordance — the mouse wheel alone can't always reach the live edge.
    let lastAtBottom = true
    function reportAtBottom() {
      const b = term.buffer.active
      const atBottom = b.viewportY >= b.baseY
      if (atBottom !== lastAtBottom) {
        lastAtBottom = atBottom
        onAtBottomRef.current?.(atBottom)
      }
    }
    // term.onScroll does NOT fire for user wheel/trackpad scrolling in xterm 5.x
    // — only when the buffer itself scrolls (new output). Without this, the
    // button only ever appeared the next time output arrived, never while the
    // user scrolled up to read. Listen to the real viewport's DOM scroll too;
    // xterm registers its own scroll handler during open() first, so viewportY
    // is already up to date when ours runs.
    const offScroll = term.onScroll(reportAtBottom)
    const viewport = el.querySelector<HTMLElement>('.xterm-viewport')
    viewport?.addEventListener('scroll', reportAtBottom, { passive: true })

    const ro = new ResizeObserver((entries) => {
      if (entries[0]?.contentRect.width > 0) { fit.fit(); reportAtBottom() }
    })
    ro.observe(el)

    const offOutput = apiRef.current.subscribeOutput((data) => {
      // The write callback fires after the buffer is parsed, so bottom-state
      // reflects any new lines this output added.
      term.write(data, reportAtBottom)
    })

    return () => {
      cancelAnimationFrame(rafId)
      terminalRegistry.delete(el)
      offOutput()
      offScroll.dispose()
      viewport?.removeEventListener('scroll', reportAtBottom)
      ro.disconnect()
      term.dispose()
      fitRef.current = null
      termRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const focus = useCallback(() => termRef.current?.focus(), [])
  const scrollToBottom = useCallback(() => termRef.current?.scrollToBottom(), [])

  return { fitRef, focus, scrollToBottom }
}
