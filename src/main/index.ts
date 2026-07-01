import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, extname, basename, dirname } from 'path'
import { homedir } from 'os'
import { readdir, readFile, writeFile, stat, cp, rename, rm, access, mkdir } from 'fs/promises'
import type { DirEntry, FilePreview, WriteResult } from '../shared/types'
import { SessionManager } from './sessionManager'
import { PaneManager } from './paneManager'
import { JupyterManager } from './jupyterManager'
import * as gitManager from './gitManager'
import { saveState, loadState } from './sessionPersistence'
import * as remotes from './remotes'
import * as remoteFs from './remoteFs'
import { parseTarget } from './remotePath'
import type { RemoteConfig, SavedSession } from '../shared/types'

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
      plugins: true,  // enable Chromium's built-in PDF viewer (FileView iframe)
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  // Stop the taskbar flash once the user actually looks at the window.
  mainWindow.on('focus', () => mainWindow?.flashFrame(false))
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
  sessions.on('exit', (id: string, failedFast: boolean, error: string) => {
    mainWindow?.webContents.send('session:exit', id, failedFast, error)
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

// The remote a path belongs to is encoded in the path itself (remote://id/…), so
// every fs/git/session handler resolves it the same way. Returns undefined for
// local paths or an unknown/stale remote id (falls back to local behavior).
async function remoteFor(encodedPath: string): Promise<RemoteConfig | undefined> {
  const { remoteId } = parseTarget(encodedPath)
  if (!remoteId) return undefined
  return (await remotes.get(remoteId)) ?? undefined
}

ipcMain.handle('session:create', async (_, name: string, cwd: string, rootDir?: string, parentId?: string, resume?: boolean) =>
  sessions.create(name, cwd, rootDir ?? cwd, parentId, resume, await remoteFor(cwd))
)
ipcMain.handle('session:destroy', (_, id: string) => sessions.destroy(id))
ipcMain.handle('session:relaunch', (_, id: string) => sessions.relaunch(id))
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
ipcMain.handle('remotes:list', () => remotes.list())
ipcMain.handle('remotes:add', (_, input: Omit<RemoteConfig, 'id'>) => remotes.add(input))
ipcMain.handle('remotes:update', (_, remote: RemoteConfig) => remotes.update(remote))
ipcMain.handle('remotes:remove', (_, id: string) => remotes.remove(id))
ipcMain.handle('remotes:test', (_, remote: RemoteConfig) => remotes.test(remote))
ipcMain.handle('remotes:homeDir', (_, remote: RemoteConfig) => remotes.homeDir(remote))

ipcMain.handle('pane:create', async (_, cwd: string) => panes.create(cwd, await remoteFor(cwd)))
ipcMain.handle('pane:destroy', (_, id: string) => panes.destroy(id))
ipcMain.on('pane:input', (_, id: string, data: string) => panes.sendInput(id, data))
ipcMain.on('pane:resize', (_, id: string, cols: number, rows: number) => panes.resize(id, cols, rows))

ipcMain.handle('fs:readDir', async (_, path: string): Promise<DirEntry[]> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.readDir(remote, parseTarget(path).path)
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const detailed = await Promise.all(
      entries.map(async (e) => {
        // stat for size/mtime; tolerate unreadable entries (broken symlinks, perms).
        let size = 0, mtimeMs = 0
        try { const s = await stat(join(path, e.name)); size = s.size; mtimeMs = s.mtimeMs } catch { /* leave 0 */ }
        return { name: e.name, isDir: e.isDirectory(), size, mtimeMs }
      })
    )
    // Default order (folders first, by name); the renderer re-sorts on demand.
    return detailed.sort((a, b) =>
      a.isDir !== b.isDir
        ? a.isDir ? -1 : 1
        : a.name.localeCompare(b.name)
    )
  } catch {
    return []
  }
})
ipcMain.handle('shell:openPath', (_, path: string) => shell.openPath(path))

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Pick a destination path in destDir that doesn't already exist, appending
// " (1)", " (2)", … before the extension on collision — like a file manager.
async function uniqueDest(destDir: string, name: string): Promise<string> {
  const exists = async (p: string) => { try { await access(p); return true } catch { return false } }
  if (!(await exists(join(destDir, name)))) return join(destDir, name)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = join(destDir, `${stem} (${i})${ext}`)
    if (!(await exists(candidate))) return candidate
  }
}

// Copy a file/dir (recursively) into destDir, never overwriting.
ipcMain.handle('fs:copy', async (_, src: string, destDir: string): Promise<WriteResult> => {
  const remote = await remoteFor(destDir)
  if (remote) return remoteFs.copy(remote, parseTarget(src).path, parseTarget(destDir).path)
  try {
    await cp(src, await uniqueDest(destDir, basename(src)), { recursive: true })
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Move a file/dir into destDir. rename() is atomic on the same filesystem; fall
// back to copy+remove across devices.
ipcMain.handle('fs:move', async (_, src: string, destDir: string): Promise<WriteResult> => {
  const remote = await remoteFor(destDir)
  if (remote) return remoteFs.move(remote, parseTarget(src).path, parseTarget(destDir).path)
  try {
    const dest = await uniqueDest(destDir, basename(src))
    try {
      await rename(src, dest)
    } catch {
      await cp(src, dest, { recursive: true })
      await rm(src, { recursive: true, force: true })
    }
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Delete to the OS trash (recoverable) rather than an irreversible unlink.
ipcMain.handle('fs:delete', async (_, path: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.del(remote, parseTarget(path).path)
  try {
    await shell.trashItem(path)
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Rename within the same directory; refuse to clobber an existing name.
ipcMain.handle('fs:rename', async (_, path: string, newName: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.rename(remote, parseTarget(path).path, newName)
  try {
    const dest = join(dirname(path), newName)
    if (dest === path) return { ok: true }
    try { await access(dest); return { ok: false, error: 'A file with that name already exists' } }
    catch { /* name is free */ }
    await rename(path, dest)
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Create a new (empty) directory; non-recursive so it fails if it already exists.
ipcMain.handle('fs:mkdir', async (_, path: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.mkdir(remote, parseTarget(path).path)
  try {
    await mkdir(path)
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

// Create a new empty file; 'wx' fails rather than truncate an existing file.
ipcMain.handle('fs:createFile', async (_, path: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.createFile(remote, parseTarget(path).path)
  try {
    await writeFile(path, '', { flag: 'wx' })
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
})

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
  const remote = await remoteFor(path)
  if (remote) return remoteFs.readFile(remote, parseTarget(path).path)
  const name = basename(path)
  try {
    const ext = extname(path).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (mime) {
      const buf = await readFile(path)
      return { kind: 'image', name, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    }

    // Render PDFs inline via Chromium's built-in viewer (travels over VNC).
    if (ext === '.pdf') {
      const buf = await readFile(path)
      return { kind: 'pdf', name, dataUrl: `data:application/pdf;base64,${buf.toString('base64')}` }
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

// Full, untruncated UTF-8 read — used for .ipynb so notebooks round-trip without
// the size cap / binary heuristic that fs:readFile applies for previews.
ipcMain.handle('fs:readText', async (_, path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.readText(remote, parseTarget(path).path)
  try {
    const text = await readFile(path, 'utf8')
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('fs:writeFile', async (_, path: string, content: string): Promise<WriteResult> => {
  const remote = await remoteFor(path)
  if (remote) return remoteFs.writeFile(remote, parseTarget(path).path, content)
  try {
    await writeFile(path, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// One Jupyter server per host: the local one, plus a lazily-created tunneled
// server per remote. `dir` is the notebook's (possibly remote-encoded) directory,
// used only to pick the right server.
const remoteJupyter = new Map<string, JupyterManager>()
async function jupyterFor(dir?: string): Promise<JupyterManager> {
  const remote = dir ? await remoteFor(dir) : undefined
  if (!remote) return jupyter
  let jm = remoteJupyter.get(remote.id)
  if (!jm) { jm = new JupyterManager(remote); remoteJupyter.set(remote.id, jm) }
  return jm
}
ipcMain.handle('jupyter:start', async (_, dir?: string) => (await jupyterFor(dir)).start())
ipcMain.handle('jupyter:install', async (_, dir?: string) => (await jupyterFor(dir)).install())

ipcMain.handle('git:status', (_, dir: string) => gitManager.status(dir))
ipcMain.handle('git:diff', (_, dir: string, file: string, staged: boolean, untracked: boolean) =>
  gitManager.diff(dir, file, staged, untracked)
)
ipcMain.handle('git:stage', (_, dir: string, file: string) => gitManager.stage(dir, file))
ipcMain.handle('git:unstage', (_, dir: string, file: string) => gitManager.unstage(dir, file))
ipcMain.handle('git:stageAll', (_, dir: string) => gitManager.stageAll(dir))
ipcMain.handle('git:unstageAll', (_, dir: string) => gitManager.unstageAll(dir))
ipcMain.handle('git:commit', (_, dir: string, message: string) => gitManager.commit(dir, message))
ipcMain.handle('git:log', (_, dir: string, limit?: number) => gitManager.log(dir, limit))
ipcMain.handle('git:show', (_, dir: string, hash: string) => gitManager.show(dir, hash))
ipcMain.handle('git:branches', (_, dir: string) => gitManager.branches(dir))
ipcMain.handle('git:createBranch', (_, dir: string, name: string) => gitManager.createBranch(dir, name))
ipcMain.handle('git:checkoutBranch', (_, dir: string, name: string) => gitManager.checkoutBranch(dir, name))
ipcMain.handle('git:deleteBranch', (_, dir: string, name: string, force: boolean) => gitManager.deleteBranch(dir, name, force))
ipcMain.handle('git:mergeBranch', (_, dir: string, name: string) => gitManager.mergeBranch(dir, name))

// Bring the window forward (e.g. from a notification click).
ipcMain.handle('app:focus', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

// Reflect the count of sessions needing attention on the OS: dock/taskbar badge
// (macOS, Linux Unity) plus a frame flash while the window is unfocused.
ipcMain.handle('app:setAttention', (_, count: number) => {
  app.badgeCount = Math.max(0, count)
  if (!mainWindow) return
  mainWindow.flashFrame(count > 0 && !mainWindow.isFocused())
})

ipcMain.handle('dialog:openDir', async (_, defaultPath?: string) => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: defaultPath || homedir(),
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
  for (const jm of remoteJupyter.values()) jm.destroy()
  if (process.platform !== 'darwin') app.quit()
})
