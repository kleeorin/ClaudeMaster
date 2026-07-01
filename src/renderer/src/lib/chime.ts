// A short synthesized two-note chime for attention events — no audio asset to
// bundle or ship over VNC. Lazily creates a single AudioContext and resumes it
// (browsers start it suspended until the first user gesture).
let ctx: AudioContext | null = null

export function playChime(kind: 'waiting' | 'done' = 'done'): void {
  try {
    ctx = ctx ?? new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    // Rising pair for "needs you", gentler falling pair for "finished".
    const freqs = kind === 'waiting' ? [784, 1175] : [880, 587]
    freqs.forEach((f, i) => {
      const osc = ctx!.createOscillator()
      const gain = ctx!.createGain()
      osc.type = 'sine'
      osc.frequency.value = f
      const t = now + i * 0.13
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.14, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
      osc.connect(gain)
      gain.connect(ctx!.destination)
      osc.start(t)
      osc.stop(t + 0.22)
    })
  } catch {
    /* audio unavailable (e.g. headless) — silently skip */
  }
}
