import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { SessionManager } from './sessionManager'
import { PaneManager } from './paneManager'
import { JupyterManager } from './jupyterManager'
import { saveState, loadState } from './sessionPersistence'
import type { SavedSession } from '../shared/types'

const sessions = new SessionManager()
const panes = new PaneManager()
const jupyter = new JupyterManager()
let mainWindow: BrowserWindow | null = null
let isQuitting = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.webContents.send('app:request-save')
      // Fallback: force-close after 10s if renderer doesn't respond
      setTimeout(() => { isQuitting = true; mainWindow?.close() }, 10000)
    }
  })

  sessions.on('output', (id: string, data: string) => {
    mainWindow?.webContents.send('session:output', id, data)
  })
  sessions.on('stateChange', (id: string, state: string) => {
    mainWindow?.webContents.send('session:stateChange', id, state)
  })
  sessions.on('exit', (id: string) => {
    mainWindow?.webContents.send('session:exit', id)
  })

  panes.on('output', (id: string, data: string) => {
    mainWindow?.webContents.send('pane:output', id, data)
  })
  panes.on('exit', (id: string) => {
    mainWindow?.webContents.send('pane:exit', id)
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('session:create', (_, name: string, cwd: string) =>
  sessions.create(name, cwd)
)
ipcMain.handle('session:destroy', (_, id: string) => sessions.destroy(id))
ipcMain.handle('session:list', () => sessions.list())
ipcMain.handle('session:load-saved', () => loadState())
ipcMain.handle('session:save-state', async (_, saved: SavedSession[]) => {
  await saveState(saved)
  isQuitting = true
  mainWindow?.close()
})
ipcMain.handle('session:autosave', async (_, saved: SavedSession[]) => {
  await saveState(saved)
})
ipcMain.on('session:input', (_, id: string, data: string) => sessions.sendInput(id, data))
ipcMain.on('session:resize', (_, id: string, cols: number, rows: number) =>
  sessions.resize(id, cols, rows)
)
ipcMain.handle('pane:create', (_, cwd: string) => panes.create(cwd))
ipcMain.handle('pane:destroy', (_, id: string) => panes.destroy(id))
ipcMain.on('pane:input', (_, id: string, data: string) => panes.sendInput(id, data))
ipcMain.on('pane:resize', (_, id: string, cols: number, rows: number) => panes.resize(id, cols, rows))

ipcMain.handle('jupyter:start', () => jupyter.start())
ipcMain.handle('jupyter:install', () => jupyter.install())

ipcMain.handle('dialog:openDir', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: homedir(),
  })
  return result.canceled ? null : result.filePaths[0]
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  jupyter.destroy()
  if (process.platform !== 'darwin') app.quit()
})
