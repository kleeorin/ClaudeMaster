interface Props {
  onClick: () => void
}

/** Floating control shown when the terminal viewport is scrolled away from the
 *  live bottom, giving a reliable one-click way back to the prompt line. */
export function JumpToBottom({ onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Jump to bottom"
      className="absolute bottom-3 right-4 z-10 flex items-center gap-1 rounded-full border border-ctp-surface0 bg-ctp-surface1 px-3 py-1 text-xs text-ctp-text shadow-lg hover:bg-ctp-surface0"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14M5 12l7 7 7-7" />
      </svg>
      Jump to bottom
    </button>
  )
}
