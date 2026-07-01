import { useEffect, useState, useCallback } from 'react'
import { makeRemotePath } from '../../../shared/remotePath'
import type { RemoteConfig } from '../../../shared/types'

// Browse a remote host's filesystem over ssh (reusing fs.readDir on encoded
// paths) and pick a directory. Electron's native dialog is local-only, so remote
// sessions/subsessions choose their working directory here instead. `onChoose`
// receives a plain absolute path on the remote (no remote:// scheme).
export function RemoteDirPicker({
  remote,
  initialDir,
  title,
  onChoose,
  onCancel,
}: {
  remote: RemoteConfig
  initialDir?: string
  title: string
  onChoose: (dir: string) => void
  onCancel: () => void
}) {
  // `dir` is null until the real starting directory is resolved. The picker never
  // starts from an a-priori path: an absolute `initialDir` (e.g. a subsession's
  // parent dir) is used directly, but an empty or ~-relative hint is resolved
  // against the remote's live $HOME — a bare `~` can't be shell-expanded remotely
  // (it gets quoted), so we expand it here.
  const [dir, setDir] = useState<string | null>(null)
  const [dirs, setDirs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const hint = initialDir ?? ''
      let start = hint
      if (!hint || hint.startsWith('~')) {
        const home = (await window.api.remotes.homeDir(remote)).replace(/\/$/, '')
        start = hint.startsWith('~/') ? home + hint.slice(1) : home
      }
      if (!cancelled) setDir(start || '/')
    })()
    return () => { cancelled = true }
  }, [remote, initialDir])

  const load = useCallback(async (target: string) => {
    setLoading(true)
    setError(null)
    try {
      const entries = await window.api.fs.readDir(makeRemotePath(remote.id, target))
      setDirs(entries.filter((e) => e.isDir).map((e) => e.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDirs([])
    } finally {
      setLoading(false)
    }
  }, [remote.id])

  useEffect(() => { if (dir !== null) void load(dir) }, [dir, load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Normalise a POSIX path so ".." and trailing slashes behave when navigating.
  const go = (next: string) => {
    const parts: string[] = []
    for (const seg of next.split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    setDir('/' + parts.join('/'))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="w-[520px] max-h-[70vh] flex flex-col bg-ctp-base border border-ctp-surface1 rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-ctp-surface0">
          <div className="text-sm font-semibold text-ctp-text">{title}</div>
          <div className="text-xs text-ctp-overlay mt-0.5">{remote.label}</div>
        </div>

        <div className="px-4 py-2 flex items-center gap-2 border-b border-ctp-surface0">
          <button
            onClick={() => go((dir ?? '') + '/..')}
            disabled={dir === null || dir === '/'}
            className="px-2 py-1 text-xs rounded bg-ctp-surface0 text-ctp-subtext hover:text-ctp-text disabled:opacity-40"
            title="Up one level"
          >
            ↑
          </button>
          <input
            value={dir ?? ''}
            disabled={dir === null}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && dir !== null) go(dir) }}
            className="flex-1 px-2 py-1 text-xs font-mono bg-ctp-mantle border border-ctp-surface0 rounded text-ctp-text focus:outline-none focus:border-ctp-mauve"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[160px]">
          {(dir === null || loading) && <p className="text-xs text-ctp-overlay px-2 py-3">{dir === null ? 'Resolving home directory…' : 'Loading…'}</p>}
          {dir !== null && error && <p className="text-xs text-ctp-red px-2 py-3">{error}</p>}
          {dir !== null && !loading && !error && dirs.length === 0 && (
            <p className="text-xs text-ctp-overlay px-2 py-3">No subdirectories</p>
          )}
          {dir !== null && !loading && !error && dirs.map((name) => (
            <button
              key={name}
              onDoubleClick={() => go(`${dir}/${name}`)}
              onClick={() => go(`${dir}/${name}`)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left text-ctp-subtext hover:bg-ctp-surface0 hover:text-ctp-text rounded"
            >
              <span className="text-ctp-blue">📁</span>
              <span className="truncate">{name}</span>
            </button>
          ))}
        </div>

        <div className="px-4 py-3 flex justify-end gap-2 border-t border-ctp-surface0">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (dir !== null) onChoose(dir) }}
            disabled={dir === null}
            className="px-3 py-1.5 text-xs rounded bg-ctp-mauve text-ctp-base font-medium hover:bg-ctp-mauve/90 disabled:opacity-40"
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  )
}
