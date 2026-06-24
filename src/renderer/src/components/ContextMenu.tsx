import { useState, useEffect } from 'react'
import { terminalRegistry } from '../lib/terminalRegistry'

interface MenuState {
  x: number
  y: number
  selectionText: string
  sendInput?: (data: string) => void
}

const MENU_W = 128
const MENU_H = 80

export function ContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()

      // Walk up the DOM to find a registered xterm container
      let xtermEntry: { sendInput: (data: string) => void; term: import('@xterm/xterm').Terminal } | undefined
      let node = e.target as HTMLElement | null
      while (node) {
        const entry = terminalRegistry.get(node)
        if (entry) { xtermEntry = entry; break }
        node = node.parentElement
      }

      const selectionText = xtermEntry
        ? xtermEntry.term.getSelection()
        : (window.getSelection()?.toString() ?? '')

      setMenu({
        x: Math.min(e.clientX, window.innerWidth - MENU_W - 8),
        y: e.clientY + MENU_H > window.innerHeight ? e.clientY - MENU_H : e.clientY,
        selectionText,
        sendInput: xtermEntry?.sendInput,
      })
    }

    const onDismiss = () => setMenu(null)
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }

    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('click', onDismiss)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('click', onDismiss)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  if (!menu) return null

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (menu.selectionText) navigator.clipboard.writeText(menu.selectionText)
    setMenu(null)
  }

  const handlePaste = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu(null)
    const text = await navigator.clipboard.readText().catch(() => '')
    if (!text) return
    if (menu.sendInput) {
      menu.sendInput(text)
    } else {
      document.execCommand('insertText', false, text)
    }
  }

  return (
    <div
      style={{ top: menu.y, left: menu.x }}
      className="fixed z-50 bg-ctp-surface0 border border-ctp-surface1 rounded shadow-lg py-1 w-32 select-none"
    >
      <button
        onMouseDown={handleCopy}
        disabled={!menu.selectionText}
        className="w-full text-left px-3 py-1.5 text-xs text-ctp-text hover:bg-ctp-surface1 disabled:opacity-40 disabled:cursor-default transition-colors"
      >
        Copy
      </button>
      <div className="mx-2 my-0.5 border-t border-ctp-surface1" />
      <button
        onMouseDown={handlePaste}
        className="w-full text-left px-3 py-1.5 text-xs text-ctp-text hover:bg-ctp-surface1 transition-colors"
      >
        Paste
      </button>
    </div>
  )
}
