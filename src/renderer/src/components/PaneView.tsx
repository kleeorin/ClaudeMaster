import { useEffect, useRef, useState } from 'react'
import { useTerminal, CONTAINER_STYLE } from '../hooks/useTerminal'
import { JumpToBottom } from './JumpToBottom'

interface Props {
  paneId: string
  isActive: boolean
}

export function PaneView({ paneId, isActive }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const { fitRef, focus, scrollToBottom } = useTerminal(containerRef, {
    sendInput: (data) => window.api.pane.sendInput(paneId, data),
    sendResize: (cols, rows) => window.api.pane.resize(paneId, cols, rows),
    subscribeOutput: (cb) =>
      window.api.on.paneOutput((id, data) => { if (id === paneId) cb(data) }),
  }, { onAtBottomChange: setAtBottom })

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
