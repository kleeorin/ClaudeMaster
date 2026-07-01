import { useCallback, useEffect, useRef, useState } from 'react'

export type ResizeEdge = 'left' | 'right' | 'top' | 'bottom'

interface Opts {
  /** localStorage key the size is persisted under. */
  storageKey: string
  /** Size (px) used when nothing is persisted yet. */
  initial: number
  min: number
  /** Upper bound; a function is re-evaluated each drag so it can track the window. */
  max: number | (() => number)
  /** Which edge the drag handle sits on — determines which way a drag grows the pane. */
  edge: ResizeEdge
}

/**
 * Persisted, draggable size for a layout pane. Returns the current size plus
 * props to spread onto a {@link ResizeHandle}. Pointer capture keeps the drag
 * alive even when the cursor passes over a terminal / iframe.
 */
export function useResizable({ storageKey, initial, min, max, edge }: Opts) {
  const axis: 'x' | 'y' = edge === 'left' || edge === 'right' ? 'x' : 'y'
  // How a positive pointer delta (right / down) changes the size.
  const sign = edge === 'right' || edge === 'bottom' ? 1 : -1

  const clamp = useCallback(
    (n: number) => {
      const hi = typeof max === 'function' ? max() : max
      return Math.min(hi, Math.max(min, n))
    },
    [min, max],
  )

  const [size, setSize] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return clamp(Number.isFinite(saved) && saved > 0 ? saved : initial)
  })

  const sizeRef = useRef(size)
  const apply = useCallback(
    (n: number) => {
      const c = clamp(n)
      sizeRef.current = c
      setSize(c)
    },
    [clamp],
  )

  const drag = useRef<{ origin: number; startSize: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      drag.current = { origin: axis === 'x' ? e.clientX : e.clientY, startSize: sizeRef.current }
      document.body.classList.add(axis === 'x' ? 'cm-resizing-x' : 'cm-resizing-y')
    },
    [axis],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d) return
      const pos = axis === 'x' ? e.clientX : e.clientY
      apply(d.startSize + sign * (pos - d.origin))
    },
    [axis, sign, apply],
  )

  const end = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return
      drag.current = null
      document.body.classList.remove('cm-resizing-x', 'cm-resizing-y')
      try {
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
      localStorage.setItem(storageKey, String(sizeRef.current))
    },
    [storageKey],
  )

  // Keep within bounds when the window shrinks (matters for function maxes).
  useEffect(() => {
    const onResize = () => apply(sizeRef.current)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [apply])

  return {
    size,
    axis,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
  }
}

type HandleProps = { axis: 'x' | 'y' } & React.HTMLAttributes<HTMLDivElement>

/** A thin draggable separator. Spread a hook's `handleProps` onto it. */
export function ResizeHandle({ axis, className = '', ...rest }: HandleProps) {
  const shape =
    axis === 'x' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
  return (
    <div
      className={`shrink-0 ${shape} bg-transparent hover:bg-ctp-mauve/40 transition-colors ${className}`}
      {...rest}
    />
  )
}
