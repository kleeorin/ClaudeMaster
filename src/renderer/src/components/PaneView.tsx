import { useEffect, useRef, useState } from 'react'
import { useTerminal, CONTAINER_STYLE } from '../hooks/useTerminal'
import { JumpToBottom } from './JumpToBottom'

interface Props {
  paneId: string
  isActive: boolean
  onAdd: () => void
  onClose: () => void
}

export function PaneView({ paneId, isActive, onAdd, onClose }: Props) {
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
    <div className="group relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" style={CONTAINER_STYLE} />
      {/* Per-terminal controls, top-right: "+" stacks another terminal below
          this one, "×" closes this terminal. Hidden until the strip is hovered
          so they don't sit on top of output. */}
      <div className="absolute top-1 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <PaneButton title="Add Terminal Below" onClick={onAdd}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </PaneButton>
        <PaneButton title="Close Terminal" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </PaneButton>
      </div>
      {!atBottom && <JumpToBottom onClick={() => { scrollToBottom(); focus() }} />}
    </div>
  )
}

function PaneButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      // Steal focus away from xterm via onMouseDown-prevent so a click doesn't
      // first land in the terminal.
      onMouseDown={(e) => e.preventDefault()}
      className="flex h-5 w-5 items-center justify-center rounded text-ctp-subtext bg-ctp-mantle/80 hover:bg-ctp-surface0 hover:text-ctp-text transition-colors"
    >
      {children}
    </button>
  )
}
