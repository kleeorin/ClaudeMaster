// Read the user's ~/.ssh/config and surface its `Host` aliases so the remote
// picker can offer them as one-click quick-adds. Two steps:
//  1. Parse the file to ENUMERATE the alias names (ssh has no "list hosts").
//  2. Ask ssh itself to RESOLVE each alias with `ssh -G <alias>` — the
//     authoritative expansion of username / hostname / port / IdentityFile, which
//     also honours defaults (e.g. User defaulting to the local user) and Includes.
//     That's why we don't trust the raw `User` line alone.
//
// A quick-added remote still stores `host: <alias>`, so ssh re-applies the FULL
// config (ProxyJump, IdentityFile, …) at connect time; the resolved user/host are
// kept only for display, so the manager shows who you'll actually connect as.
import { homedir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { SshConfigHost } from '../shared/types'

const pexec = promisify(execFile)

// A pattern token (has * or ?) or a negation (!foo) is not a real destination.
const isPattern = (token: string): boolean => /[*?]/.test(token) || token.startsWith('!')

// Enumerate the concrete `Host` alias names declared in ~/.ssh/config.
async function aliasNames(): Promise<string[]> {
  let text: string
  try {
    text = await readFile(join(homedir(), '.ssh', 'config'), 'utf8')
  } catch {
    return []  // no config file → nothing to offer
  }
  const names: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+?)\s*=?\s+(.*)$/.exec(line)
    if (!m || m[1].toLowerCase() !== 'host') continue
    for (const token of m[2].trim().split(/\s+/)) {
      if (isPattern(token) || seen.has(token)) continue
      seen.add(token)
      names.push(token)
    }
  }
  return names
}

// Resolve a destination the way ssh will — `ssh -G` prints the fully-expanded
// config without connecting. `sshOptions` (e.g. ['-p','2222']) are folded in so the
// resolution matches how we actually launch. Best-effort: returns {} on any error.
export async function resolve(host: string, sshOptions: string[] = []): Promise<{ hostName?: string; user?: string; port?: string }> {
  try {
    const { stdout } = await pexec('ssh', ['-G', ...sshOptions, host], { timeout: 5000 })
    const field = (key: string): string | undefined => {
      const m = new RegExp(`^${key} (.+)$`, 'mi').exec(stdout)
      return m ? m[1].trim() : undefined
    }
    return { hostName: field('hostname'), user: field('user'), port: field('port') }
  } catch {
    return {}
  }
}

// The ~/.ssh/config aliases, each resolved to its real user/host/port for display.
export async function listHosts(): Promise<SshConfigHost[]> {
  const names = await aliasNames()
  return Promise.all(names.map(async (alias): Promise<SshConfigHost> => {
    const { hostName, user, port } = await resolve(alias)
    return {
      alias,
      hostName: hostName && hostName !== alias ? hostName : undefined,
      user,
      port: port && port !== '22' ? port : undefined,
    }
  }))
}
