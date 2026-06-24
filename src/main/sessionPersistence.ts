import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import type { SavedSession } from '../shared/types'

const FILE = join(app.getPath('userData'), 'sessions.json')

export async function saveState(sessions: SavedSession[]): Promise<void> {
  await writeFile(FILE, JSON.stringify(sessions))
}

export async function loadState(): Promise<SavedSession[]> {
  try {
    const raw = await readFile(FILE, 'utf8')
    return JSON.parse(raw) as SavedSession[]
  } catch {
    return []
  }
}
