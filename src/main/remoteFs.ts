// Remote counterparts of the fs:* IPC handlers in index.ts. Each mirrors the
// local handler's return shape exactly (DirEntry[], FilePreview, WriteResult, …)
// so the renderer can't tell local from remote. Paths here are already stripped
// of the remote:// scheme by the caller. Assumes a Linux/GNU remote (GNU find
// -printf, coreutils). Injection-safe: ssh.run shell-quotes every argv element,
// and the `sh -c '… "$0"' <path>` idiom passes paths as positional args.
import { posix as p } from 'path'
import type { DirEntry, FilePreview, WriteResult } from '../shared/types'
import type { RemoteConfig } from '../shared/types'
import * as ssh from './ssh'

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

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
const MAX_TEXT_BYTES = 2 * 1024 * 1024 // 2 MB cap for text previews (matches local)

async function exists(remote: RemoteConfig, path: string): Promise<boolean> {
  return (await ssh.run(remote, ['test', '-e', path])).code === 0
}

// Remote twin of index.ts' uniqueDest: pick a non-colliding name in destDir,
// appending " (1)", " (2)", … before the extension.
async function uniqueDest(remote: RemoteConfig, destDir: string, name: string): Promise<string> {
  const first = p.join(destDir, name)
  if (!(await exists(remote, first))) return first
  const ext = p.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = p.join(destDir, `${stem} (${i})${ext}`)
    if (!(await exists(remote, candidate))) return candidate
  }
}

export async function readDir(remote: RemoteConfig, path: string): Promise<DirEntry[]> {
  try {
    // One round trip: type / size / mtime(epoch.frac) / basename per entry.
    const { stdout, code } = await ssh.run(remote, [
      'find', path, '-maxdepth', '1', '-mindepth', '1',
      '-printf', '%y\\t%s\\t%T@\\t%f\\n',
    ])
    if (code !== 0) return []
    const entries: DirEntry[] = []
    for (const line of stdout.split('\n')) {
      if (!line) continue
      const tab1 = line.indexOf('\t')
      const tab2 = line.indexOf('\t', tab1 + 1)
      const tab3 = line.indexOf('\t', tab2 + 1)
      if (tab1 < 0 || tab2 < 0 || tab3 < 0) continue
      const type = line.slice(0, tab1)
      const size = Number(line.slice(tab1 + 1, tab2)) || 0
      const mtimeMs = Math.round((Number(line.slice(tab2 + 1, tab3)) || 0) * 1000)
      const name = line.slice(tab3 + 1)
      entries.push({ name, isDir: type === 'd', size, mtimeMs })
    }
    return entries.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
    )
  } catch {
    return []
  }
}

export async function readFile(remote: RemoteConfig, path: string): Promise<FilePreview> {
  const name = p.basename(path)
  try {
    const ext = p.extname(path).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (mime) {
      const { stdout } = await ssh.runBuffer(remote, ['cat', '--', path])
      return { kind: 'image', name, dataUrl: `data:${mime};base64,${stdout.toString('base64')}` }
    }
    if (ext === '.pdf') {
      const { stdout } = await ssh.runBuffer(remote, ['cat', '--', path])
      return { kind: 'pdf', name, dataUrl: `data:application/pdf;base64,${stdout.toString('base64')}` }
    }

    const sizeOut = await ssh.run(remote, ['stat', '-c', '%s', '--', path])
    if (sizeOut.code !== 0) return { kind: 'error', name, message: sizeOut.stderr.trim() || 'stat failed' }
    const size = Number(sizeOut.stdout.trim()) || 0

    // Only pull the first MAX+1 bytes so a huge file can't blow the buffer; the
    // extra byte lets us report truncation without a second stat.
    const { stdout } = await ssh.runBuffer(remote, ['head', '-c', String(MAX_TEXT_BYTES + 1), '--', path])
    if (stdout.subarray(0, 8000).includes(0)) return { kind: 'binary', name }
    const truncated = size > MAX_TEXT_BYTES
    const text = stdout.subarray(0, MAX_TEXT_BYTES).toString('utf8')
    return { kind: 'text', name, text, truncated }
  } catch (err) {
    return { kind: 'error', name, message: errMsg(err) }
  }
}

export async function readText(remote: RemoteConfig, path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const { stdout, stderr, code } = await ssh.run(remote, ['cat', '--', path], { maxBuffer: 64 * 1024 * 1024 })
    if (code !== 0) return { ok: false, error: stderr.trim() || `cat exited ${code}` }
    return { ok: true, text: stdout }
  } catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function writeFile(remote: RemoteConfig, path: string, content: string): Promise<WriteResult> {
  try {
    // $0 = the path (a positional arg), so nothing from `path` is interpreted by
    // the remote shell. Content arrives on stdin.
    const { stderr, code } = await ssh.run(remote, ['sh', '-c', 'cat > "$0"', path], { input: content })
    if (code !== 0) return { ok: false, error: stderr.trim() || `write exited ${code}` }
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function copy(remote: RemoteConfig, src: string, destDir: string): Promise<WriteResult> {
  try {
    const dest = await uniqueDest(remote, destDir, p.basename(src))
    const { stderr, code } = await ssh.run(remote, ['cp', '-r', '--', src, dest])
    if (code !== 0) return { ok: false, error: stderr.trim() || `cp exited ${code}` }
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function move(remote: RemoteConfig, src: string, destDir: string): Promise<WriteResult> {
  try {
    const dest = await uniqueDest(remote, destDir, p.basename(src))
    const { stderr, code } = await ssh.run(remote, ['mv', '--', src, dest])
    if (code !== 0) return { ok: false, error: stderr.trim() || `mv exited ${code}` }
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
}

// No OS trash on a generic remote: prefer `gio trash` (recoverable) and fall back
// to `rm -rf` (permanent). The README calls out that remote delete may not be
// recoverable, unlike the local shell.trashItem path.
export async function del(remote: RemoteConfig, path: string): Promise<WriteResult> {
  try {
    const { stderr, code } = await ssh.run(remote, [
      'sh', '-c', 'gio trash -- "$0" 2>/dev/null || rm -rf -- "$0"', path,
    ])
    if (code !== 0) return { ok: false, error: stderr.trim() || `delete exited ${code}` }
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function rename(remote: RemoteConfig, path: string, newName: string): Promise<WriteResult> {
  try {
    const dest = p.join(p.dirname(path), newName)
    if (dest === path) return { ok: true }
    if (await exists(remote, dest)) return { ok: false, error: 'A file with that name already exists' }
    const { stderr, code } = await ssh.run(remote, ['mv', '--', path, dest])
    if (code !== 0) return { ok: false, error: stderr.trim() || `rename exited ${code}` }
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function mkdir(remote: RemoteConfig, path: string): Promise<WriteResult> {
  try {
    // Non-recursive: fails if it already exists (matches local fs.mkdir).
    const { stderr, code } = await ssh.run(remote, ['mkdir', '--', path])
    if (code !== 0) return { ok: false, error: stderr.trim() || `mkdir exited ${code}` }
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function createFile(remote: RemoteConfig, path: string): Promise<WriteResult> {
  try {
    // noclobber (`set -C`) makes `: > file` fail rather than truncate an existing
    // file — the remote equivalent of writeFile's 'wx' flag.
    const { stderr, code } = await ssh.run(remote, ['sh', '-c', 'set -C; : > "$0"', path])
    if (code !== 0) return { ok: false, error: stderr.trim() || 'file already exists' }
    return { ok: true }
  } catch (err) { return { ok: false, error: errMsg(err) } }
}
