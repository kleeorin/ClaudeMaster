import { useSessions } from '../store/sessions'
import { useFileBrowser } from '../store/fileBrowser'
import { useGitPanel } from '../store/gitPanel'

export function Toolbar() {
  const { sessions, activeId, openPane, closePane, visiblePanesFor, paneIdsFor } = useSessions()
  const { browsers, openBrowser, closeBrowser } = useFileBrowser()
  const { open: gitOpen, openGit, closeGit } = useGitPanel()

  const paneVisible = !!(activeId && visiblePanesFor(activeId).length)
  const paneExists = !!(activeId && paneIdsFor(activeId).length)
  const browserOpen = activeId ? (browsers[activeId]?.open ?? false) : false
  const gitPanelOpen = activeId ? (gitOpen[activeId] ?? false) : false

  const handleTogglePane = async () => {
    if (!activeId) return
    if (paneVisible) closePane(activeId)
    else await openPane(activeId)
  }

  const handleToggleBrowser = () => {
    if (!activeId) return
    if (browserOpen) closeBrowser(activeId)
    else {
      const root = sessions.find((s) => s.id === activeId)?.rootDir ?? ''
      openBrowser(activeId, root)
    }
  }

  const handleToggleGit = () => {
    if (!activeId) return
    if (gitPanelOpen) closeGit(activeId)
    else openGit(activeId)
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

      <ToolbarButton onClick={handleToggleBrowser} disabled={!activeId} active={browserOpen} title={browserOpen ? 'Close File Browser' : 'Open File Browser'}>
        {/* folder icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </ToolbarButton>

      <ToolbarButton onClick={handleToggleGit} disabled={!activeId} active={gitPanelOpen} title={gitPanelOpen ? 'Close Git' : 'Open Git'}>
        {/* git branch icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" />
          <path d="M6 8.5v7M18 11.5a6 6 0 0 1-6 6H8" />
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
