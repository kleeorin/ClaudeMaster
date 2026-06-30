import { lazy, Suspense } from 'react'
import { useSessions } from './store/sessions'
import { useFileBrowser, CLAUDE_TAB } from './store/fileBrowser'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { TerminalView } from './components/TerminalView'
import { PaneView } from './components/PaneView'
import { TabBar } from './components/TabBar'
import { ContextMenu } from './components/ContextMenu'
import { FileBrowserView } from './components/FileBrowserView'

const NotebookView = lazy(() => import('./components/NotebookView').then(m => ({ default: m.NotebookView })))
const FileView = lazy(() => import('./components/FileView').then(m => ({ default: m.FileView })))

export function App() {
  const { sessions, activeId, paneFor, panes, paneVisible } = useSessions()
  const { browsers, closeFile, setActiveTab, setFileDirty } = useFileBrowser()
  const activePaneId = activeId ? paneFor(activeId) : null
  const browser = activeId ? browsers[activeId] : undefined
  const browserOpen = browser?.open ?? false
  const openFiles = browser?.openFiles ?? []
  const dirtyFiles = browser?.dirtyFiles ?? []
  const activeTab = browser?.activeTab ?? CLAUDE_TAB
  const claudeActive = activeTab === CLAUDE_TAB
  const activeCwd = activeId ? sessions.find((s) => s.id === activeId)?.rootDir ?? '' : ''

  return (
    <div className="flex h-screen overflow-hidden bg-ctp-base text-ctp-text">
      <ContextMenu />
      <Sidebar />

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
              />
            )}

            <div className="relative flex-1 overflow-hidden">
              {sessions.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-ctp-overlay select-none">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M8 12h8M12 8v8" />
                  </svg>
                  <p className="text-sm">Click <span className="text-ctp-subtext">+ New Session</span> to start</p>
                </div>
              ) : (
                <>
                  {/* Claude terminal per session — visible when its session is active and on the Claude tab */}
                  {sessions.map((s) => {
                    const onClaude = (browsers[s.id]?.activeTab ?? CLAUDE_TAB) === CLAUDE_TAB
                    const visible = s.id === activeId && onClaude
                    return (
                      <div key={s.id} className={`absolute inset-0 ${visible ? 'block' : 'hidden'}`}>
                        <TerminalView sessionId={s.id} isActive={visible} />
                      </div>
                    )
                  })}

                  {/* File tabs across all sessions — mounted so unsaved edits survive switches */}
                  {sessions.map((s) =>
                    (browsers[s.id]?.openFiles ?? []).map((f) => {
                      const visible = s.id === activeId && browsers[s.id]?.activeTab === f.path
                      return (
                        <div key={`${s.id}:${f.path}`} className={`absolute inset-0 ${visible ? 'block' : 'hidden'}`}>
                          <Suspense fallback={null}>
                            {f.isNotebook ? (
                              <NotebookView path={f.path} onDirtyChange={(d) => setFileDirty(s.id, f.path, d)} />
                            ) : (
                              <FileView path={f.path} onDirtyChange={(d) => setFileDirty(s.id, f.path, d)} />
                            )}
                          </Suspense>
                        </div>
                      )
                    })
                  )}
                </>
              )}
            </div>

            {/* Secondary terminal pane — Claude tab only. One per session, all mounted. */}
            {sessions.some(s => panes[s.id]) && (
              <div className={`shrink-0 border-t border-ctp-surface0 relative ${activePaneId && claudeActive ? 'h-[20vh]' : 'hidden'}`}>
                {sessions.filter(s => panes[s.id]).map(s => {
                  const onClaude = (browsers[s.id]?.activeTab ?? CLAUDE_TAB) === CLAUDE_TAB
                  const visible = s.id === activeId && !!paneVisible[s.id] && onClaude
                  return (
                    <div
                      key={panes[s.id]}
                      className={`absolute inset-0 ${visible ? '' : 'hidden'}`}
                    >
                      <PaneView
                        paneId={panes[s.id]}
                        isActive={visible}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {browserOpen && activeId && (
            <div className="w-[30%] min-w-[220px] shrink-0">
              <FileBrowserView sessionId={activeId} cwd={activeCwd} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
