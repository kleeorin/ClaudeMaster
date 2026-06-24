import { contextBridge, ipcRenderer } from 'electron'
import type { SessionInfo, SavedSession, DirEntry } from '../shared/types'

contextBridge.exposeInMainWorld('api', {
  session: {
    create: (name: string, cwd: string): Promise<string> =>
      ipcRenderer.invoke('session:create', name, cwd),
    destroy: (id: string): Promise<void> =>
      ipcRenderer.invoke('session:destroy', id),
    list: (): Promise<SessionInfo[]> =>
      ipcRenderer.invoke('session:list'),
    sendInput: (id: string, data: string): void =>
      ipcRenderer.send('session:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('session:resize', id, cols, rows),
    loadSaved: (): Promise<SavedSession[]> =>
      ipcRenderer.invoke('session:load-saved'),
    saveState: (saved: SavedSession[]): Promise<void> =>
      ipcRenderer.invoke('session:save-state', saved),
    autosave: (saved: SavedSession[]): Promise<void> =>
      ipcRenderer.invoke('session:autosave', saved),
  },
  pane: {
    create: (cwd: string): Promise<string> =>
      ipcRenderer.invoke('pane:create', cwd),
    destroy: (id: string): Promise<void> =>
      ipcRenderer.invoke('pane:destroy', id),
    sendInput: (id: string, data: string): void =>
      ipcRenderer.send('pane:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pane:resize', id, cols, rows),
  },
  dialog: {
    openDir: (): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openDir'),
  },
  fs: {
    readDir: (path: string): Promise<DirEntry[]> =>
      ipcRenderer.invoke('fs:readDir', path),
  },
  shell: {
    openPath: (path: string): Promise<string> =>
      ipcRenderer.invoke('shell:openPath', path),
  },
  jupyter: {
    start: (): Promise<{ url: string; token: string } | null> =>
      ipcRenderer.invoke('jupyter:start'),
    install: (): Promise<boolean> =>
      ipcRenderer.invoke('jupyter:install'),
  },
  on: {
    output: (cb: (id: string, data: string) => void): (() => void) => {
      const h = (_: unknown, id: string, data: string) => cb(id, data)
      ipcRenderer.on('session:output', h)
      return () => ipcRenderer.removeListener('session:output', h)
    },
    stateChange: (cb: (id: string, state: string) => void): (() => void) => {
      const h = (_: unknown, id: string, state: string) => cb(id, state)
      ipcRenderer.on('session:stateChange', h)
      return () => ipcRenderer.removeListener('session:stateChange', h)
    },
    exit: (cb: (id: string) => void): (() => void) => {
      const h = (_: unknown, id: string) => cb(id)
      ipcRenderer.on('session:exit', h)
      return () => ipcRenderer.removeListener('session:exit', h)
    },
    paneOutput: (cb: (id: string, data: string) => void): (() => void) => {
      const h = (_: unknown, id: string, data: string) => cb(id, data)
      ipcRenderer.on('pane:output', h)
      return () => ipcRenderer.removeListener('pane:output', h)
    },
    paneExit: (cb: (id: string) => void): (() => void) => {
      const h = (_: unknown, id: string) => cb(id)
      ipcRenderer.on('pane:exit', h)
      return () => ipcRenderer.removeListener('pane:exit', h)
    },
    requestSave: (cb: () => void): (() => void) => {
      const h = () => cb()
      ipcRenderer.on('app:request-save', h)
      return () => ipcRenderer.removeListener('app:request-save', h)
    },
  },
})
