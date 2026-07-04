import { useEffect, useRef, useState } from 'react'
import { useTerminal, CONTAINER_STYLE } from '../hooks/useTerminal'
import { JumpToBottom } from './JumpToBottom'

interface Props {
  sessionId: string
  isActive: boolean
}

// TUI-mode chat surface: an xterm bound to the session's interactive `claude` pty.
// Used in place of ChatView when the app is launched in 'tui' frontend mode. The
// app-control notebook tools still work — they ride the shared MCP server, not this
// surface — so editing notebooks from the TUI drives the same panes as in native.
export function TerminalView({ sessionId, isActive }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const { fitRef, focus, scrollToBottom } = useTerminal(containerRef, {
    sendInput: (data) => window.api.session.sendInput(sessionId, data),
    sendResize: (cols, rows) => window.api.session.resize(sessionId, cols, rows),
    subscribeOutput: (cb) =>
      window.api.on.output((id, data) => { if (id === sessionId) cb(data) }),
  }, { onAtBottomChange: setAtBottom })

  // Two rAFs: switching from display:none needs two frames for layout to settle.
  // Focus the terminal so keyboard input (including spacebar) works immediately.
  useEffect(() => {
    if (!isActive) return
    let id2: number
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => { fitRef.current?.fit(); focus() })
    })
    return () => { cancelAnimationFrame(id1); cancelAnimationFrame(id2) }
  }, [isActive, fitRef, focus])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" style={CONTAINER_STYLE} />
      {!atBottom && <JumpToBottom onClick={() => { scrollToBottom(); focus() }} />}
    </div>
  )
}
