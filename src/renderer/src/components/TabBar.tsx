import { CLAUDE_TAB, type OpenFile } from '../store/fileBrowser'

interface Props {
  openFiles: OpenFile[]
  dirtyFiles: string[]
  activeTab: string
  onSelect: (tab: string) => void
  onClose: (path: string) => void
}

// Tabs across the top of the main column: a fixed "Claude" tab (the terminal,
// full-screen) followed by one tab per open file. Shown only when at least one
// file is open.
export function TabBar({ openFiles, dirtyFiles, activeTab, onSelect, onClose }: Props) {
  return (
    <div className="h-9 shrink-0 flex items-stretch bg-ctp-mantle border-b border-ctp-surface0 overflow-x-auto">
      <Tab label="Claude" active={activeTab === CLAUDE_TAB} onSelect={() => onSelect(CLAUDE_TAB)} />
      {openFiles.map((f) => (
        <Tab
          key={f.path}
          label={f.path.split('/').pop() ?? f.path}
          title={f.path}
          dirty={dirtyFiles.includes(f.path)}
          active={activeTab === f.path}
          onSelect={() => onSelect(f.path)}
          onClose={() => onClose(f.path)}
        />
      ))}
    </div>
  )
}

interface TabProps {
  label: string
  title?: string
  dirty?: boolean
  active: boolean
  onSelect: () => void
  onClose?: () => void
}

function Tab({ label, title, dirty, active, onSelect, onClose }: TabProps) {
  return (
    <div
      onClick={onSelect}
      onAuxClick={(e) => { if (e.button === 1 && onClose) { e.preventDefault(); onClose() } }}
      title={title ?? label}
      className={`group flex items-center gap-1.5 pl-3 pr-2 max-w-[180px] cursor-pointer border-r border-ctp-surface0 text-xs select-none ${
        active
          ? 'bg-ctp-base text-ctp-text'
          : 'text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0'
      }`}
    >
      <span className="truncate">{label}</span>
      {onClose && (
        dirty ? (
          // Dirty dot that turns into a close ✕ on hover.
          <span className="relative flex w-3.5 h-3.5 shrink-0 items-center justify-center">
            <span className="group-hover:hidden text-ctp-yellow leading-none" title="Unsaved changes">●</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose() }}
              title="Close"
              className="hidden group-hover:flex items-center justify-center w-3.5 h-3.5 rounded text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface1"
            >
              <CloseIcon />
            </button>
          </span>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); onClose() }}
            title="Close"
            className="flex items-center justify-center w-3.5 h-3.5 shrink-0 rounded text-ctp-overlay opacity-0 group-hover:opacity-100 hover:text-ctp-text hover:bg-ctp-surface1"
          >
            <CloseIcon />
          </button>
        )
      )}
    </div>
  )
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}
