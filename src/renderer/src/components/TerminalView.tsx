import { useEffect, useRef, useState } from 'react'
import { useTerminal, CONTAINER_STYLE } from '../hooks/useTerminal'
import { JumpToBottom } from './JumpToBottom'
import { useSessions } from '../store/sessions'

interface Props {
  sessionId: string
  isActive: boolean
}

export function TerminalView({ sessionId, isActive }: Props) {
  const { savedScrollback } = useSessions()
  const containerRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const { fitRef, focus, scrollToBottom } = useTerminal(containerRef, {
    sendInput: (data) => window.api.session.sendInput(sessionId, data),
    sendResize: (cols, rows) => window.api.session.resize(sessionId, cols, rows),
    subscribeOutput: (cb) =>
      window.api.on.output((id, data) => { if (id === sessionId) cb(data) }),
  }, { sessionId, initialOutput: savedScrollback[sessionId], onAtBottomChange: setAtBottom })

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
