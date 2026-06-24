import { useSessions } from '../store/sessions'
import { useNotebooks } from '../store/notebooks'

export function Toolbar() {
  const { activeId, openPane, closePane, paneFor, paneIdFor } = useSessions()
  const { notebooks, openNotebook, closeNotebook } = useNotebooks()

  const paneVisible = !!(activeId && paneFor(activeId))
  const paneExists = !!(activeId && paneIdFor(activeId))
  const notebookOpen = activeId ? (notebooks[activeId]?.open ?? false) : false

  const handleTogglePane = async () => {
    if (!activeId) return
    if (paneVisible) closePane(activeId)
    else await openPane(activeId)
  }

  const handleToggleNotebook = async () => {
    if (!activeId) return
    if (notebookOpen) closeNotebook(activeId)
    else await openNotebook(activeId)
  }

  return (
    <div className="h-9 shrink-0 flex items-center gap-1 px-3 bg-ctp-mantle border-b border-ctp-surface0">
      <ToolbarButton onClick={handleTogglePane} disabled={!activeId} active={paneVisible} title={paneVisible ? 'Close Terminal' : paneExists ? 'Open Terminal' : 'Add Terminal'}>
        {/* split-horizontal icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 15h18" />
        </svg>
      </ToolbarButton>

      <ToolbarButton onClick={handleToggleNotebook} disabled={!activeId} active={notebookOpen} title={notebookOpen ? 'Close Notebook' : 'Open Notebook'}>
        {/* notebook icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <path d="M8 7h8M8 11h8M8 15h5" />
        </svg>
      </ToolbarButton>
    </div>
  )
}

interface ButtonProps {
  onClick: () => void
  disabled: boolean
  active: boolean
  title: string
  children: React.ReactNode
}

function ToolbarButton({ onClick, disabled, active, title, children }: ButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? 'bg-ctp-surface0 text-ctp-text'
          : 'text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0'
      }`}
    >
      {children}
      <span>{title}</span>
    </button>
  )
}
