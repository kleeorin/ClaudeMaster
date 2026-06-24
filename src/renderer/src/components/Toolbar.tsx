import { useSessions } from '../store/sessions'
import { useNotebooks } from '../store/notebooks'
import { useFileBrowser } from '../store/fileBrowser'

export function Toolbar() {
  const { sessions, activeId, openPane, closePane, paneFor, paneIdFor } = useSessions()
  const { notebooks, openNotebook, closeNotebook } = useNotebooks()
  const { browsers, openBrowser, closeBrowser } = useFileBrowser()

  const paneVisible = !!(activeId && paneFor(activeId))
  const paneExists = !!(activeId && paneIdFor(activeId))
  const notebookOpen = activeId ? (notebooks[activeId]?.open ?? false) : false
  const browserOpen = activeId ? (browsers[activeId]?.open ?? false) : false

  const handleTogglePane = async () => {
    if (!activeId) return
    if (paneVisible) closePane(activeId)
    else await openPane(activeId)
  }

  const handleToggleNotebook = async () => {
    if (!activeId) return
    if (notebookOpen) closeNotebook(activeId)
    else {
      closeBrowser(activeId)  // one right-side panel at a time
      await openNotebook(activeId)
    }
  }

  const handleToggleBrowser = () => {
    if (!activeId) return
    if (browserOpen) closeBrowser(activeId)
    else {
      closeNotebook(activeId)  // one right-side panel at a time
      const cwd = sessions.find((s) => s.id === activeId)?.cwd ?? ''
      openBrowser(activeId, cwd)
    }
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

      <ToolbarButton onClick={handleToggleBrowser} disabled={!activeId} active={browserOpen} title={browserOpen ? 'Close Browser' : 'Open Browser'}>
        {/* folder icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
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
