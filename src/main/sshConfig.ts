// Read the user's ~/.ssh/config and surface its top-level `Host` aliases so the
// remote picker can offer them as one-click quick-adds. We only enumerate concrete
// aliases; ssh itself resolves HostName/User/Port/IdentityFile from the config at
// connect time, so an imported alias needs nothing more than `host: <alias>`.
//
// Scope (by design): this file's own `Host` blocks only — no `Include` following,
// no ~/.ssh/config.d, no /etc/ssh. Wildcard/pattern/negated hosts are skipped.
import { homedir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'
import type { SshConfigHost } from '../shared/types'

// A pattern token (has * or ?) or a negation (!foo) is not a real destination.
const isPattern = (token: string): boolean => /[*?]/.test(token) || token.startsWith('!')

export async function listHosts(): Promise<SshConfigHost[]> {
  let text: string
  try {
    text = await readFile(join(homedir(), '.ssh', 'config'), 'utf8')
  } catch {
    return []  // no config file → nothing to offer
  }

  const byAlias = new Map<string, SshConfigHost>()  // insertion order = file order
  let current: SshConfigHost[] = []                  // the current Host block's concrete aliases

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // Keyword and value are separated by whitespace and/or a single '='.
    const m = /^(\S+?)\s*=?\s+(.*)$/.exec(line)
    if (!m) continue
    const keyword = m[1].toLowerCase()
    const value = m[2].trim()

    if (keyword === 'host') {
      current = []
      for (const token of value.split(/\s+/)) {
        if (isPattern(token)) continue
        let entry = byAlias.get(token)
        if (!entry) { entry = { alias: token }; byAlias.set(token, entry) }
        current.push(entry)
      }
    } else if (keyword === 'hostname') {
      for (const e of current) if (!e.hostName) e.hostName = value
    } else if (keyword === 'user') {
      for (const e of current) if (!e.user) e.user = value
    }
  }

  return [...byAlias.values()]
}
