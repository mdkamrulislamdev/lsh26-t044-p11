/**
 * Pure domain: time arithmetic and the single route walk. No I/O, no imports
 * from anywhere else in the app. Everything downstream depends on this being
 * boring and correct.
 *
 * Times are minutes since midnight (int). "09:30" === 570. Convert only at the
 * edges — the DB stores ints, the API emits ints, the UI formats them.
 */

export class ValidationError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export function parseHHMM(s, field = 'time') {
  if (typeof s !== 'string') throw new ValidationError('BAD_TIME', `${field} must be a string`)
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) throw new ValidationError('BAD_TIME', `${field} "${s}" is not HH:MM`)
  const h = Number(m[1])
  const min = Number(m[2])
  // 24:00 is a legitimate shift end. 24:30 is not.
  if (h > 24 || min > 59 || (h === 24 && min !== 0))
    throw new ValidationError('BAD_TIME', `${field} "${s}" is not a real time`)
  return h * 60 + min
}

export function hhmm(t) {
  const h = Math.floor(t / 60)
  const m = t % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "1h 45m" / "45m" — durations only, never clock times. */
export function dur(t) {
  if (t < 60) return `${t}m`
  const h = Math.floor(t / 60)
  const m = t % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** Authoritative and symmetric per the brief. Never compute a distance. */
export function travel(travelTable, from, to) {
  const v = travelTable?.[from]?.[to]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * Walk a technician's ordered job list once from home_area at shift_start,
 * filling every timing field. No return-home leg is required.
 *
 * Every mutation anywhere in the system goes: change the ordered id list →
 * recompute → evaluate. Timings are never patched in place.
 */
export function recompute(order, tech, jobs, travelTable) {
  const stops = []
  let cursor = tech.shift_start
  let loc = tech.home_area

  for (const id of order) {
    const j = jobs.get(id)
    if (!j) continue
    const t = travel(travelTable, loc, j.area)
    if (t === null) {
      stops.push({ job_id: id, depart: cursor, arrive: cursor, start: cursor, end: cursor, travel_in: 0, unreachable: true })
      break
    }
    const depart = cursor
    const arrive = cursor + t
    const start = Math.max(arrive, j.window_start)
    const end = start + j.duration_minutes
    stops.push({ job_id: id, depart, arrive, start, end, travel_in: t })
    cursor = end
    loc = j.area
  }
  return stops
}

export const routeTravel = (stops) => stops.reduce((a, s) => a + s.travel_in, 0)
export const routeIdle = (stops) => stops.reduce((a, s) => a + (s.start - s.arrive), 0)
