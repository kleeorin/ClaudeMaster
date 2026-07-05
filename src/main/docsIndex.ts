import { readFile, writeFile, readdir, mkdir, access } from 'fs/promises'
import { join, dirname } from 'path'
import type { RemoteConfig } from '../shared/types'
import { parseTarget } from './remotePath'
import { memoryDir } from './conversations'
import * as remoteFs from './remoteFs'

// Wikilink resolution + doc creation for the docs/knowledge layer (P1). Docs are
// plain .md files on disk; there is no persistent index yet (that's P2) — resolve
// and create scan a small, bounded set of roots on demand (only on a link click,
// never a hot path).
//
// Remote-aware: the `remote://<id>/…` scheme survives POSIX path ops (join/
// dirname), so candidate paths are built on the encoded string and only unwrapped
// (parseTarget) at the remoteFs boundary — mirroring the fs:* handlers. The memory
// root is LOCAL-only (memory lives on the app's machine), so it's skipped for
// remote sessions.

const WIKI_ROOT_DIRS = (rootDir: string, fromPath: string): string[] => [
  dirname(fromPath),        // sibling of the doc you're reading
  join(rootDir, 'docs'),    // the project's docs/ folder
  rootDir,                  // the repo root (READMEs, handovers)
]

async function existsAt(encoded: string, remote?: RemoteConfig): Promise<boolean> {
  if (remote) return remoteFs.exists(remote, parseTarget(encoded).path)
  return access(encoded).then(() => true, () => false)
}

async function readTextAt(encoded: string, remote?: RemoteConfig): Promise<string | null> {
  if (remote) {
    const r = await remoteFs.readText(remote, parseTarget(encoded).path)
    return r.ok ? r.text : null
  }
  try { return await readFile(encoded, 'utf8') } catch { return null }
}

async function listNames(encodedDir: string, remote?: RemoteConfig): Promise<string[]> {
  if (remote) {
    try { return (await remoteFs.readDir(remote, parseTarget(encodedDir).path)).map((e) => e.name) } catch { return [] }
  }
  try { return await readdir(encodedDir) } catch { return [] }
}

// slug for a new file: lowercase, non-alnum → '-', collapsed and trimmed.
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
}

// The `name:` value from a memory-file frontmatter block, if present. Memory
// links use this slug (e.g. `[[project-native-frontend]]`), which needn't match
// the filename (`project_native_frontend.md`).
function frontmatterName(text: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!fm) return null
  const m = /^name:\s*(.+?)\s*$/m.exec(fm[1])
  return m ? m[1].trim() : null
}

// A `[[target]]` (ignoring any `|alias` and `#anchor`) → an absolute (possibly
// remote-encoded) path to an existing .md, or null if nothing matches.
export async function resolveDoc(
  rootDir: string, fromPath: string, target: string, remote?: RemoteConfig,
): Promise<string | null> {
  const clean = target.split('|')[0].split('#')[0].trim().replace(/\.md$/i, '')
  if (!clean) return null
  const names = [clean, slugify(clean)]

  // Path-like target: resolve relative to the doc's own dir.
  if (clean.includes('/')) {
    const p = join(dirname(fromPath), `${clean}.md`)
    return (await existsAt(p, remote)) ? p : null
  }

  // By filename across the bounded roots (sibling → docs/ → repo root).
  for (const dir of WIKI_ROOT_DIRS(rootDir, fromPath)) {
    for (const n of names) {
      const p = join(dir, `${n}.md`)
      if (await existsAt(p, remote)) return p
    }
  }

  // Memory root — LOCAL sessions only. Try filename, then a frontmatter `name:`
  // scan (memory dirs are tiny — a handful of files).
  if (!remote) {
    const mem = memoryDir(rootDir)
    for (const n of names) {
      const p = join(mem, `${n}.md`)
      if (await existsAt(p)) return p
    }
    for (const name of await listNames(mem)) {
      if (!name.endsWith('.md')) continue
      const full = join(mem, name)
      const text = await readTextAt(full)
      if (text && frontmatterName(text) === clean) return full
    }
  }

  return null
}

// Create `docs/<slug>.md` under the project (mkdir -p), seeded with a title, and
// return its path. Never clobbers — an existing file is just returned.
export async function createDoc(
  rootDir: string, target: string, remote?: RemoteConfig,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const title = target.split('|').pop()!.trim() || target.trim()
  const docsDir = join(rootDir, 'docs')
  const path = join(docsDir, `${slugify(title)}.md`)
  try {
    if (await existsAt(path, remote)) return { ok: true, path }
    if (remote) {
      await remoteFs.mkdir(remote, parseTarget(docsDir).path)
      const w = await remoteFs.writeFile(remote, parseTarget(path).path, `# ${title}\n`)
      if (!w.ok) return { ok: false, error: w.error }
    } else {
      await mkdir(docsDir, { recursive: true })
      await writeFile(path, `# ${title}\n`, 'utf8')
    }
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
