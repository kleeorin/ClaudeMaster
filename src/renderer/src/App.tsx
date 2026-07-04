import { lazy, Suspense, useState } from 'react'
import { useSessions } from './store/sessions'
import { useFileBrowser, CLAUDE_TAB } from './store/fileBrowser'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { ChatView } from './components/ChatView'
import { TerminalView } from './components/TerminalView'
import { PaneView } from './components/PaneView'
import { TabBar } from './components/TabBar'
import { ContextMenu } from './components/ContextMenu'
import { FileBrowserView } from './components/FileBrowserView'
import { NotebookBrowserView } from './components/NotebookBrowserView'
import { GitPanelView } from './components/GitPanelView'
import { useGitPanel } from './store/gitPanel'
import { useResizable, ResizeHandle } from './hooks/useResizable'

const NotebookView = lazy(() => import('./components/NotebookView').then(m => ({ default: m.NotebookView })))
const FileView = lazy(() => import('./components/FileView').then(m => ({ default: m.FileView })))
const VirtualFileView = lazy(() => import('./components/VirtualFileView').then(m => ({ default: m.VirtualFileView })))

// The most informative bit of a failed session's output is usually its last
// non-empty line (e.g. "bash: claude: command not found").
function lastLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  return line.length > 120 ? line.slice(-120) : line
}

// The Claude chat surface for the whole app, chosen at startup: the native
// stream-json chat, or the real interactive Claude Code TUI in a terminal. Both
// take the same { sessionId, isActive } props and share every other panel.
const ClaudeSurface = window.api.frontend === 'tui' ? TerminalView : ChatView

export function App() {
  const { sessions, activeId, paneIdsFor, visiblePanesFor, addPane, removePane, closeSession, relaunchSession } = useSessions()
  const { browsers, openFile, closeFile, setActiveTab, setFileDirty } = useFileBrowser()
  const { open: gitOpen } = useGitPanel()
  const gitPanelOpen = activeId ? (gitOpen[activeId] ?? false) : false
  const browser = activeId ? browsers[activeId] : undefined
  const browserOpen = browser?.open ?? false
  const openFiles = browser?.openFiles ?? []
  const dirtyFiles = browser?.dirtyFiles ?? []
  const activeTab = browser?.activeTab ?? CLAUDE_TAB
  const claudeActive = activeTab === CLAUDE_TAB
  const activeCwd = activeId ? sessions.find((s) => s.id === activeId)?.rootDir ?? '' : ''
  const [rightTab, setRightTab] = useState<'files' | 'notebooks'>('files')
  // Side-by-side layout: the active file/notebook sits to the right of Claude
  // instead of replacing it. Only meaningful while a file tab (not Claude) is active.
  const [splitView, setSplitView] = useState(() => localStorage.getItem('cm.splitView') === '1')
  const toggleSplit = () => setSplitView((v) => { localStorage.setItem('cm.splitView', v ? '0' : '1'); return !v })
  const splitActive = splitView && !claudeActive && openFiles.length > 0
  // Strip mode: a file tab is active and split is off, so Claude sits below the
  // file as a narrow horizontal strip — enough to chat about the open file
  // without giving up the file's real estate. Off in split (Claude gets its own
  // column) and on the Claude tab (Claude is full-size).
  const stripActive = !claudeActive && !splitView && openFiles.length > 0
  const claudeVisible = claudeActive || splitActive || stripActive

  const sidebar = useResizable({ storageKey: 'cm.sidebarW', initial: 208, min: 160, max: 480, edge: 'right' })
  const fileBrowser = useResizable({
    storageKey: 'cm.fileBrowserW',
    initial: 360, min: 220, max: () => Math.round(window.innerWidth * 0.7), edge: 'left',
  })
  const pane = useResizable({
    storageKey: 'cm.paneH',
    initial: Math.round(window.innerHeight * 0.2), min: 80,
    max: () => Math.round(window.innerHeight * 0.8), edge: 'top',
  })
  const gitPanel = useResizable({
    storageKey: 'cm.gitPanelW',
    initial: 340, min: 240, max: () => Math.round(window.innerWidth * 0.7), edge: 'left',
  })
  // Width of the Claude pane when in side-by-side mode (the file pane takes the rest).
  const claudePane = useResizable({
    storageKey: 'cm.claudePaneW',
    initial: Math.round(window.innerWidth * 0.45), min: 280,
    max: () => Math.round(window.innerWidth * 0.75), edge: 'right',
  })
  // Height of the Claude strip below the file in strip mode.
  const claudeStrip = useResizable({
    storageKey: 'cm.claudeStripH',
    initial: Math.round(window.innerHeight * 0.25), min: 80,
    max: () => Math.round(window.innerHeight * 0.7), edge: 'top',
  })
  const showPane = !!(activeId && claudeActive && visiblePanesFor(activeId).length)
  const anyPanes = sessions.some((s) => paneIdsFor(s.id).length > 0)

  return (
    <div className="flex h-screen overflow-hidden bg-ctp-base text-ctp-text">
      <ContextMenu />
      <Sidebar width={sidebar.size} />
      <ResizeHandle axis="x" {...sidebar.handleProps} />

      <div className="flex-1 flex flex-col overflow-hidden">
        <Toolbar />

        <div className="flex-1 flex overflow-hidden">
          {/* Main column: a tab bar (when files are open) over a single content
              area. The Claude tab shows the terminal full-screen; each file tab
              shows that file. The secondary terminal pane sits beneath, on the
              Claude tab only. All terminals and file views stay mounted and are
              shown/hidden via CSS so their state (scrollback, unsaved edits)
              survives tab and session switches. */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {activeId && openFiles.length > 0 && (
              <TabBar
                openFiles={openFiles}
                dirtyFiles={dirtyFiles}
                activeTab={activeTab}
                onSelect={(t) => setActiveTab(activeId, t)}
                onClose={(p) => closeFile(activeId, p)}
                splitView={splitView}
                onToggleSplit={toggleSplit}
              />
            )}

            <div className={`flex-1 flex overflow-hidden min-h-0 ${stripActive ? 'flex-col' : ''}`}>
              {sessions.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-ctp-overlay select-none">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M8 12h8M12 8v8" />
                  </svg>
                  <p className="text-sm">Click <span className="text-ctp-subtext">+ New Session</span> to start</p>
                </div>
              ) : (
                <>
                  {/* Claude pane: full-width on the Claude tab, the left column in split
                      mode, a narrow strip below the file in strip mode. All sessions'
                      terminals stay mounted; only the active one is shown. In strip mode
                      `order-last` moves it below the file without moving it in the DOM,
                      so the terminal keeps its scrollback. */}
                  <div
                    className={`relative overflow-hidden min-w-0 ${claudeVisible ? '' : 'hidden'} ${claudeActive ? 'flex-1' : 'shrink-0'} ${stripActive ? 'order-last' : ''}`}
                    style={splitActive ? { width: claudePane.size } : stripActive ? { height: claudeStrip.size } : undefined}
                  >
                    {sessions.map((s) => {
                      const visible = s.id === activeId && claudeVisible
                      return (
                        <div key={s.id} className={`absolute inset-0 ${visible ? 'block' : 'hidden'}`}>
                          {s.state === 'exited' && (
                            <div className="absolute top-0 inset-x-0 z-10 flex items-start gap-2 px-3 py-2 bg-ctp-yellow/10 border-b border-ctp-yellow/40 text-xs text-ctp-yellow">
                              <span className="mt-0.5">⚠</span>
                              <span className="flex-1 min-w-0">
                                Claude isn’t running{s.remoteId ? ' on this remote' : ''}
                                {s.exitError ? ` — ${lastLine(s.exitError)}` : ''}.
                                {' '}The file browser, git panel, and terminals still work; install{' '}
                                <code className="px-1 rounded bg-ctp-surface0 text-ctp-text">claude</code>
                                {s.remoteId ? ' on the remote' : ''}, then Retry.
                              </span>
                              <button
                                onClick={() => relaunchSession(s.id)}
                                className="shrink-0 px-2 py-0.5 rounded bg-ctp-yellow/20 hover:bg-ctp-yellow/30 text-ctp-yellow font-medium"
                              >
                                Retry
                              </button>
                              <button
                                onClick={() => closeSession(s.id)}
                                className="shrink-0 px-2 py-0.5 rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-subtext"
                              >
                                Close
                              </button>
                            </div>
                          )}
                          <ClaudeSurface sessionId={s.id} isActive={visible} />
                        </div>
                      )
                    })}
                  </div>

                  {splitActive && <ResizeHandle axis="x" {...claudePane.handleProps} />}
                  {stripActive && <ResizeHandle axis="y" {...claudeStrip.handleProps} />}

                  {/* File/notebook pane: full-width when a file tab is active (and not split),
                      the right column in split mode, the top region above the Claude strip in
                      strip mode. Hidden on the Claude tab. */}
                  <div className={`relative overflow-hidden flex-1 min-w-0 ${claudeActive ? 'hidden' : ''} ${stripActive ? 'order-first' : ''}`}>
                    {sessions.map((s) =>
                      (browsers[s.id]?.openFiles ?? []).map((f) => {
                        const visible = s.id === activeId && browsers[s.id]?.activeTab === f.path
                        return (
                          <div key={`${s.id}:${f.path}`} className={`absolute inset-0 ${visible ? 'block' : 'hidden'}`}>
                            <Suspense fallback={null}>
                              {f.virtual ? (
                                <VirtualFileView
                                  label={f.label ?? (f.path.split('/').pop() ?? f.path)}
                                  doc={f.virtual}
                                  onDirtyChange={(d) => setFileDirty(s.id, f.path, d)}
                                  onSavedAs={(real) => { closeFile(s.id, f.path); openFile(s.id, real, false) }}
                                />
                              ) : f.isNotebook ? (
                                <NotebookView path={f.path} onDirtyChange={(d) => setFileDirty(s.id, f.path, d)} />
                              ) : (
                                <FileView path={f.path} onDirtyChange={(d) => setFileDirty(s.id, f.path, d)} />
                              )}
                            </Suspense>
                          </div>
                        )
                      })
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Secondary terminal strip — Claude tab only. Each session keeps a
                vertical stack of terminals; all stay mounted (scrollback survives
                session switches) and only the active session's stack is shown.
                The "+" on a terminal adds another below it. */}
            {showPane && <ResizeHandle axis="y" {...pane.handleProps} />}
            {anyPanes && (
              <div
                className={`shrink-0 border-t border-ctp-surface0 relative ${showPane ? '' : 'hidden'}`}
                style={showPane ? { height: pane.size } : undefined}
              >
                {sessions.filter(s => paneIdsFor(s.id).length > 0).map(s => {
                  const onClaude = (browsers[s.id]?.activeTab ?? CLAUDE_TAB) === CLAUDE_TAB
                  const visible = s.id === activeId && visiblePanesFor(s.id).length > 0 && onClaude
                  return (
                    <div
                      key={s.id}
                      className={`absolute inset-0 flex flex-col ${visible ? '' : 'hidden'}`}
                    >
                      {paneIdsFor(s.id).map((paneId, i) => (
                        <div
                          key={paneId}
                          className={`relative flex-1 min-h-0 ${i > 0 ? 'border-t border-ctp-surface0' : ''}`}
                        >
                          <PaneView
                            paneId={paneId}
                            isActive={visible}
                            onAdd={() => void addPane(s.id, paneId)}
                            onClose={() => void removePane(paneId)}
                          />
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {browserOpen && activeId && (
            <>
              <ResizeHandle axis="x" {...fileBrowser.handleProps} />
              <div className="shrink-0 flex flex-col min-h-0 border-l border-ctp-surface0" style={{ width: fileBrowser.size }}>
                <div className="h-7 shrink-0 flex items-stretch bg-ctp-mantle border-b border-ctp-surface0 text-[11px]">
                  <PanelTab label="Files" active={rightTab === 'files'} onClick={() => setRightTab('files')} />
                  <PanelTab label="Notebooks" active={rightTab === 'notebooks'} onClick={() => setRightTab('notebooks')} />
                </div>
                <div className="flex-1 min-h-0">
                  {rightTab === 'files' ? (
                    <FileBrowserView sessionId={activeId} cwd={activeCwd} />
                  ) : (
                    <NotebookBrowserView sessionId={activeId} rootDir={activeCwd} />
                  )}
                </div>
              </div>
            </>
          )}

          {gitPanelOpen && activeId && (
            <>
              <ResizeHandle axis="x" {...gitPanel.handleProps} />
              <div className="shrink-0" style={{ width: gitPanel.size }}>
                <GitPanelView sessionId={activeId} cwd={activeCwd} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PanelTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 transition-colors border-r border-ctp-surface0 ${
        active
          ? 'bg-ctp-base text-ctp-text'
          : 'text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0/50'
      }`}
    >
      {label}
    </button>
  )
}
