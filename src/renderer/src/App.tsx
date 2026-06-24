import { lazy, Suspense } from 'react'
import { useSessions } from './store/sessions'
import { useNotebooks } from './store/notebooks'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { TerminalView } from './components/TerminalView'
import { PaneView } from './components/PaneView'
import { ContextMenu } from './components/ContextMenu'

const NotebookView = lazy(() => import('./components/NotebookView').then(m => ({ default: m.NotebookView })))

export function App() {
  const { sessions, activeId, paneFor, panes, paneVisible, savedPaneScrollback } = useSessions()
  const { notebooks } = useNotebooks()
  const activePaneId = activeId ? paneFor(activeId) : null
  const notebookOpen = activeId ? (notebooks[activeId]?.open ?? false) : false

  return (
    <div className="flex h-screen overflow-hidden bg-ctp-base text-ctp-text">
      <ContextMenu />
      <Sidebar />

      <div className="flex-1 flex flex-col overflow-hidden">
        <Toolbar />

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 relative overflow-hidden">
            {sessions.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-ctp-overlay select-none">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M8 12h8M12 8v8" />
                </svg>
                <p className="text-sm">Click <span className="text-ctp-subtext">+ New Session</span> to start</p>
              </div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`absolute inset-0 ${s.id === activeId ? 'block' : 'hidden'}`}
                >
                  <TerminalView sessionId={s.id} isActive={s.id === activeId} />
                </div>
              ))
            )}
          </div>

          {notebookOpen && activeId && (
            <div className="w-[45%] shrink-0">
              <Suspense fallback={null}>
                <NotebookView sessionId={activeId} />
              </Suspense>
            </div>
          )}
        </div>

        {/* One PaneView per session — all mounted, CSS show/hide to preserve terminal state */}
        {sessions.some(s => panes[s.id]) && (
          <div className={`shrink-0 border-t border-ctp-surface0 relative ${activePaneId ? 'h-[20vh]' : 'hidden'}`}>
            {sessions.filter(s => panes[s.id]).map(s => (
              <div
                key={panes[s.id]}
                className={`absolute inset-0 ${s.id === activeId && paneVisible[s.id] ? '' : 'hidden'}`}
              >
                <PaneView
                  paneId={panes[s.id]}
                  isActive={s.id === activeId && !!paneVisible[s.id]}
                  initialOutput={savedPaneScrollback?.[s.id]}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
