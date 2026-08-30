import type { Minutes } from '../api/types'

export function parseHHMM(s: string): Minutes {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) throw new Error(`bad time: ${s}`)
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`bad time: ${s}`)
  return h * 60 + min
}

export function hhmm(t: Minutes): string {
  const h = Math.floor(t / 60)
  const m = t % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "1h 45m" / "45m" — for durations, never for clock times. */
export function dur(t: Minutes): string {
  if (t < 60) return `${t}m`
  const h = Math.floor(t / 60)
  const m = t % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}
