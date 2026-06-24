const MAX_BYTES = 5_000_000
const store = new Map<string, string>()

export function appendScrollback(id: string, data: string): void {
  const current = store.get(id) ?? ''
  const combined = current + data
  store.set(id, combined.length > MAX_BYTES ? combined.slice(combined.length - MAX_BYTES) : combined)
}

export function setScrollback(id: string, data: string): void {
  store.set(id, data)
}

export function getScrollback(id: string): string {
  return store.get(id) ?? ''
}

export function deleteScrollback(id: string): void {
  store.delete(id)
}
