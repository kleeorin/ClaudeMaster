import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, extname, basename } from 'path'
import { homedir } from 'os'
import { readdir, readFile, stat } from 'fs/promises'
import type { DirEntry, FilePreview } from '../shared/types'
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

ipcMain.handle('fs:readDir', async (_, path: string): Promise<DirEntry[]> => {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) =>
        a.isDir !== b.isDir
          ? a.isDir ? -1 : 1
          : a.name.localeCompare(b.name)
      )
  } catch {
    return []
  }
})
ipcMain.handle('shell:openPath', (_, path: string) => shell.openPath(path))

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}
const MAX_TEXT_BYTES = 2 * 1024 * 1024 // 2 MB cap for text previews

ipcMain.handle('fs:readFile', async (_, path: string): Promise<FilePreview> => {
  const name = basename(path)
  try {
    const ext = extname(path).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (mime) {
      const buf = await readFile(path)
      return { kind: 'image', name, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    }

    const { size } = await stat(path)
    const buf = await readFile(path)
    // Binary heuristic: a NUL byte in the first chunk means "not text".
    if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary', name }

    const truncated = size > MAX_TEXT_BYTES
    const text = buf.subarray(0, MAX_TEXT_BYTES).toString('utf8')
    return { kind: 'text', name, text, truncated }
  } catch (err) {
    return { kind: 'error', name, message: err instanceof Error ? err.message : String(err) }
  }
})

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
