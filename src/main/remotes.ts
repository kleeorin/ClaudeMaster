import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import crypto from 'crypto'
import type { RemoteConfig, RemoteTest } from '../shared/types'
import * as ssh from './ssh'

const FILE = join(app.getPath('userData'), 'remotes.json')

let cache: RemoteConfig[] | null = null

async function load(): Promise<RemoteConfig[]> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8')) as RemoteConfig[]
  } catch {
    cache = []
  }
  return cache
}

async function persist(list: RemoteConfig[]): Promise<void> {
  cache = list
  await writeFile(FILE, JSON.stringify(list, null, 2))
}

export async function list(): Promise<RemoteConfig[]> {
  return [...(await load())]
}

// Resolve a remote by id (used by the fs/git/session layers). Returns null for a
// missing id so callers can surface "unknown remote" rather than crash.
export async function get(id: string): Promise<RemoteConfig | null> {
  return (await load()).find((r) => r.id === id) ?? null
}

export async function add(input: Omit<RemoteConfig, 'id'>): Promise<RemoteConfig> {
  const remote: RemoteConfig = { ...input, id: crypto.randomUUID() }
  await persist([...(await load()), remote])
  return remote
}

export async function update(remote: RemoteConfig): Promise<void> {
  await persist((await load()).map((r) => (r.id === remote.id ? remote : r)))
}

export async function remove(id: string): Promise<void> {
  await persist((await load()).filter((r) => r.id !== id))
}

// Resolve the remote's home directory so the folder picker can start there
// (rather than a pre-decided path). Falls back to "/" if $HOME can't be read.
export async function homeDir(remote: RemoteConfig): Promise<string> {
  try {
    const { stdout, code } = await ssh.run(remote, ['sh', '-c', 'echo "$HOME"'])
    const dir = stdout.trim()
    if (code === 0 && dir.startsWith('/')) return dir
  } catch { /* fall through to root */ }
  return '/'
}

// Probe reachability + auth. `ssh true` succeeds only if the connection and
// non-interactive auth both work; BatchMode (in ssh.run) turns a would-be
// password/host-key prompt into a fast, legible failure.
export async function test(remote: RemoteConfig): Promise<RemoteTest> {
  try {
    const { code, stderr } = await ssh.run(remote, ['true'])
    if (code === 0) return { ok: true }
    return { ok: false, error: stderr.trim() || `ssh exited with code ${code}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
