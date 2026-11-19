/** 12.34 → "0:12.3" — 구간 편집은 0.1초 단위까지 보여야 감이 온다 */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const d = Math.floor((sec * 10) % 10)
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}
