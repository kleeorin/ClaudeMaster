// Remap a path across a rename: returns `to` when `p` is exactly `from`, rewrites
// the prefix when `p` is inside `from` (a renamed directory), else leaves it as-is.
export function remapPath(p: string, from: string, to: string): string {
  if (p === from) return to
  if (p.startsWith(from + '/')) return to + p.slice(from.length)
  return p
}
