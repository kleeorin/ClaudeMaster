// Permission Control Center — a GUI over Claude's OWN permission settings files,
// not a parallel rule store (see HANDOVER-permissions.md). The durable source of
// truth is the CLI's three settings files:
//
//   user     ~/.claude/settings.json
//   project  <cwd>/.claude/settings.json
//   local    <cwd>/.claude/settings.local.json
//
// each shaped `{ permissions: { allow[], deny[], ask[], defaultMode } }`. This is
// exactly where "allow always" already persists. P1 is READ-ONLY: merge the three
// files into an effective picture (rules tagged by origin scope + the effective
// defaultMode). Remote sessions read their files over ssh via remoteFs, so the
// panel works identically for local and remote Claude.
import { homedir } from 'os'
import { join, posix, dirname } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import type {
  RemoteConfig, EffectivePermissions, PermissionRule, PermissionMode, PermissionScope, PermissionFile,
  PermissionAction, WriteResult,
} from '../shared/types'
import * as remoteFs from './remoteFs'
import * as remotes from './remotes'
import { parseTarget, makeRemotePath } from './remotePath'
import { getAgent } from './agents'
import { NOTEBOOK_DENY } from './claudeEngine'

// The modes we recognise for display; an unknown `defaultMode` string is ignored
// (treated as if unset) rather than shown as a bogus mode.
const KNOWN_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

type Loaded = { exists: boolean; unreadable: boolean; data: Record<string, unknown> | null }

// Read + parse one settings file, local or remote. A missing file → exists:false;
// a present-but-invalid file → exists:true, unreadable:true (surfaced in the UI so
// a typo'd settings.json doesn't look like "no rules").
async function readSettings(absPath: string, remote?: RemoteConfig): Promise<Loaded> {
  let text: string | null = null
  if (remote) {
    const r = await remoteFs.readText(remote, absPath)
    text = r.ok ? r.text : null
  } else {
    try { text = await readFile(absPath, 'utf8') } catch { text = null }
  }
  if (text == null) return { exists: false, unreadable: false, data: null }
  try { return { exists: true, unreadable: false, data: JSON.parse(text) as Record<string, unknown> } }
  catch { return { exists: true, unreadable: true, data: null } }
}

// Pull the allow/deny/ask lists + defaultMode out of a parsed settings object.
function extract(data: Record<string, unknown> | null): { allow: string[]; deny: string[]; ask: string[]; mode?: PermissionMode } {
  const perms = (data?.permissions ?? {}) as Record<string, unknown>
  const list = (k: string): string[] =>
    Array.isArray(perms[k]) ? (perms[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const dm = perms.defaultMode
  const mode = typeof dm === 'string' && KNOWN_MODES.includes(dm) ? (dm as PermissionMode) : undefined
  return { allow: list('allow'), deny: list('deny'), ask: list('ask'), mode }
}

// Resolve a session cwd (remote-encoded ok) to its remote + the absolute path of
// each settings file. Shared by read (getEffective) and write (add/removeRule) so
// they always agree on where each scope's file lives.
async function resolvePaths(cwd: string): Promise<{
  remote?: RemoteConfig; remoteId: string | null; paths: Record<PermissionScope, string>
}> {
  const { remoteId, path: cwdPath } = parseTarget(cwd)
  const remote = remoteId ? (await remotes.get(remoteId)) ?? undefined : undefined
  const jn = remote ? posix.join : join
  const home = remote ? await remotes.homeDir(remote) : homedir()
  return {
    remote, remoteId,
    paths: {
      user: jn(home, '.claude', 'settings.json'),
      project: jn(cwdPath, '.claude', 'settings.json'),
      local: jn(cwdPath, '.claude', 'settings.local.json'),
    },
  }
}

// The effective permission picture for a session's cwd (remote-encoded ok) and
// its agent role. Reads the three files in precedence order (user < project <
// local); later scopes win the effective mode, and every rule is kept + tagged.
export async function getEffective(cwd: string, agentId?: string): Promise<EffectivePermissions> {
  const notebookFunnel = NOTEBOOK_DENY.split(',')
  const agentDef = getAgent(agentId)
  const agent = {
    id: agentDef.id, name: agentDef.name,
    allowedTools: agentDef.allowedTools, disallowedTools: agentDef.disallowedTools,
  }
  try {
    const { remote, remoteId, paths } = await resolvePaths(cwd)
    const encode = (abs: string): string => (remoteId ? makeRemotePath(remoteId, abs) : abs)

    const rules: PermissionRule[] = []
    const files: PermissionFile[] = []
    let mode: PermissionMode = 'default'
    let modeScope: PermissionScope | undefined

    for (const scope of ['user', 'project', 'local'] as PermissionScope[]) {
      const { exists, unreadable, data } = await readSettings(paths[scope], remote)
      files.push({ scope, path: encode(paths[scope]), exists, unreadable })
      if (!data) continue
      const { allow, deny, ask, mode: fileMode } = extract(data)
      for (const value of allow) rules.push({ action: 'allow', value, scope })
      for (const value of deny) rules.push({ action: 'deny', value, scope })
      for (const value of ask) rules.push({ action: 'ask', value, scope })
      if (fileMode) { mode = fileMode; modeScope = scope }  // higher-precedence file wins
    }

    return { cwd, mode, modeScope, rules, files, notebookFunnel, agent }
  } catch (err) {
    return {
      cwd, mode: 'default', rules: [], files: [], notebookFunnel, agent,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// Write a settings object back to disk (local or remote), pretty-printed, creating
// the parent .claude/ dir if needed.
async function writeSettings(absPath: string, remote: RemoteConfig | undefined, data: Record<string, unknown>): Promise<WriteResult> {
  const text = JSON.stringify(data, null, 2) + '\n'
  if (remote) {
    const mk = await remoteFs.mkdir(remote, posix.dirname(absPath))
    if (!mk.ok) return mk
    return remoteFs.writeFile(remote, absPath, text)
  }
  try {
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, text, 'utf8')
    return { ok: true }
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
}

// Read-modify-write one settings file's permissions[action] list. `mutate` returns
// the new list (or null to signal "no change needed"). Preserves everything else
// in the file; creates the file/keys if absent.
async function editRule(
  cwd: string, scope: PermissionScope, action: PermissionAction,
  mutate: (list: string[]) => string[] | null,
): Promise<WriteResult> {
  try {
    const { remote, paths } = await resolvePaths(cwd)
    const absPath = paths[scope]
    const { unreadable, data } = await readSettings(absPath, remote)
    if (unreadable) return { ok: false, error: `${scope} settings file is not valid JSON — fix it by hand first` }
    const root: Record<string, unknown> = data ?? {}
    const perms = (root.permissions && typeof root.permissions === 'object' ? root.permissions : {}) as Record<string, unknown>
    const current = Array.isArray(perms[action]) ? (perms[action] as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const next = mutate(current)
    if (next == null) return { ok: true }  // nothing to do (e.g. duplicate add / absent remove)
    perms[action] = next
    root.permissions = perms
    return writeSettings(absPath, remote, root)
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
}

// Add an allow/deny/ask rule to a scope's settings file (no-op if already present).
export function addRule(cwd: string, scope: PermissionScope, action: PermissionAction, value: string): Promise<WriteResult> {
  const v = value.trim()
  if (!v) return Promise.resolve({ ok: false, error: 'empty rule' })
  return editRule(cwd, scope, action, (list) => (list.includes(v) ? null : [...list, v]))
}

// Remove a rule from a scope's settings file (no-op if absent).
export function removeRule(cwd: string, scope: PermissionScope, action: PermissionAction, value: string): Promise<WriteResult> {
  return editRule(cwd, scope, action, (list) => (list.includes(value) ? list.filter((x) => x !== value) : null))
}
