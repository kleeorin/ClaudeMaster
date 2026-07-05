import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { App } from './App'
import { AppControlBridge } from './components/AppControlBridge'
import { SessionProvider } from './store/sessions'
import { ChatProvider } from './store/chat'
import { NotebookProvider } from './store/notebooks'
import { FileBrowserProvider } from './store/fileBrowser'
import { GitPanelProvider } from './store/gitPanel'
import { PermsPanelProvider } from './store/permsPanel'

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', color: '#f38ba8', background: '#1e1e2e', height: '100vh' }}>
          <strong>Render error</strong>
          <pre style={{ marginTop: 12, whiteSpace: 'pre-wrap', fontSize: 13 }}>{this.state.error.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <NotebookProvider>
        <FileBrowserProvider>
          <GitPanelProvider>
            <PermsPanelProvider>
              <SessionProvider>
                <ChatProvider>
                  <AppControlBridge />
                  <App />
                </ChatProvider>
              </SessionProvider>
            </PermsPanelProvider>
          </GitPanelProvider>
        </FileBrowserProvider>
      </NotebookProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
