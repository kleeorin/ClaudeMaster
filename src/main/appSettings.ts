import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

// ClaudeMaster's own app-level settings (distinct from Claude Code's settings.json,
// which configures the harness). Small enough to read synchronously at startup so
// the chosen frontend is known before the window (and its preload) are created.

export type Frontend = 'native' | 'tui'

export interface AppSettings {
  // Which chat surface + claude I/O backend the whole app uses. 'native' = the
  // stream-json chat frontend; 'tui' = the real interactive Claude Code terminal
  // (needed for /remote-control). Applied at startup — restart to change.
  frontend: Frontend
}

const DEFAULTS: AppSettings = { frontend: 'native' }

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cache: AppSettings | null = null

export function loadSettings(): AppSettings {
  if (cache) return cache
  try {
    const raw = readFileSync(file(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cache = {
      frontend: parsed.frontend === 'tui' ? 'tui' : 'native',
    }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function getFrontend(): Frontend {
  return loadSettings().frontend
}

// Persist a new frontend choice. Takes effect on the next launch (the backend and
// the renderer's chat surface are both chosen at startup), so the caller should
// tell the user to restart.
export function setFrontend(frontend: Frontend): void {
  const next: AppSettings = { ...loadSettings(), frontend }
  cache = next
  try { writeFileSync(file(), JSON.stringify(next)) } catch { /* best-effort */ }
}
