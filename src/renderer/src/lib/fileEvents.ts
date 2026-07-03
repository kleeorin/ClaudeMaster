// A tiny renderer-side bus for "this file just changed on disk out from under
// you". App-control text edits (edit_active_file) write through to disk, then
// emit here so the open FileView reloads live (or raises a conflict banner if it
// has unsaved edits). Keyed by absolute path; handlers are cheap and idempotent.

type Handler = () => void

const subs = new Map<string, Set<Handler>>()

export function onFileTouched(path: string, handler: Handler): () => void {
  let set = subs.get(path)
  if (!set) { set = new Set(); subs.set(path, set) }
  set.add(handler)
  return () => {
    const s = subs.get(path)
    if (!s) return
    s.delete(handler)
    if (s.size === 0) subs.delete(path)
  }
}

export function emitFileTouched(path: string): void {
  subs.get(path)?.forEach((h) => { try { h() } catch { /* a stale handler must not break the writer */ } })
}
