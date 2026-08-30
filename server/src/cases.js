/**
 * Ingest. Every hostile-input rule from plans/03-edge-cases.md is enforced
 * here, at the boundary, so nothing downstream has to be defensive. Fail loudly
 * at load, never mid-plan.
 */

import { createRequire } from 'node:module'
import { ValidationError, parseHHMM } from './domain.js'

const require = createRequire(import.meta.url)
const doc = require('./cases.json')

const str = (x) => (typeof x === 'string' ? x.trim() : '')
const norm = (x) => str(x).toLowerCase()

export function normaliseCase(raw) {
  const case_id = str(raw.case_id)
  if (!case_id) throw new ValidationError('BAD_CASE', 'case_id is required')

  const areas = (raw.areas ?? []).map(str).filter(Boolean)
  if (!areas.length) throw new ValidationError('BAD_CASE', `${case_id}: areas is empty`)
  const areaSet = new Set(areas)

  // Travel table: complete-enough, non-negative, zero on the diagonal. An
  // asymmetric table is accepted (directional lookup) but reported.
  const travel_minutes = {}
  const warnings = []
  for (const from of areas) {
    travel_minutes[from] = {}
    for (const to of areas) {
      const val = raw.travel_minutes?.[from]?.[to]
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
        warnings.push({ code: 'MISSING_TRAVEL', message: `No travel time from ${from} to ${to}.` })
        continue
      }
      if (from === to && val !== 0)
        warnings.push({ code: 'NONZERO_DIAGONAL', message: `Travel ${from}→${from} is ${val}, not 0.` })
      travel_minutes[from][to] = val
    }
  }
  for (const from of areas)
    for (const to of areas) {
      const a = travel_minutes[from]?.[to]
      const b = travel_minutes[to]?.[from]
      if (a != null && b != null && a !== b && from < to)
        warnings.push({
          code: 'ASYMMETRIC_TRAVEL',
          message: `Travel ${from}→${to} is ${a} but ${to}→${from} is ${b}. Using each direction as given.`,
        })
    }

  const seenT = new Set()
  const technicians = (raw.technicians ?? []).map((t) => {
    const id = str(t.id)
    if (!id) throw new ValidationError('BAD_TECHNICIAN', `${case_id}: a technician has no id`)
    if (seenT.has(id)) throw new ValidationError('DUPLICATE_ID', `${case_id}: technician ${id} appears twice`)
    seenT.add(id)
    const shift_start = parseHHMM(t.shift_start, `${id}.shift_start`)
    const shift_end = parseHHMM(t.shift_end, `${id}.shift_end`)
    const home_area = str(t.home_area)
    if (!areaSet.has(home_area))
      throw new ValidationError('UNKNOWN_AREA', `${case_id}: ${id} home_area "${home_area}" is not in areas`)
    // Overnight shifts are out of scope. Rejected explicitly rather than
    // silently wrapping past midnight — see README limitations.
    if (shift_end <= shift_start)
      warnings.push({
        code: 'INVALID_SHIFT',
        message: `${id} has shift ${t.shift_start}–${t.shift_end}; excluded from assignment.`,
      })
    return {
      id,
      name: str(t.name) || id,
      skills: [...new Set((t.skills ?? []).map(norm).filter(Boolean))].sort(),
      shift_start,
      shift_end,
      home_area,
    }
  })

  const seenJ = new Set()
  const jobs = (raw.jobs ?? []).map((j) => {
    const id = str(j.id)
    if (!id) throw new ValidationError('BAD_JOB', `${case_id}: a job has no id`)
    if (seenJ.has(id)) throw new ValidationError('DUPLICATE_ID', `${case_id}: job ${id} appears twice`)
    seenJ.add(id)
    const duration_minutes = Number(j.duration_minutes)
    if (!Number.isFinite(duration_minutes) || duration_minutes <= 0)
      throw new ValidationError('BAD_JOB', `${case_id}: ${id} duration_minutes must be > 0`)
    const area = str(j.area)
    if (!areaSet.has(area))
      warnings.push({ code: 'UNKNOWN_AREA', message: `${id} is in ${area}, which is not in areas.` })
    return {
      id,
      area,
      skill: norm(j.skill),
      duration_minutes,
      window_start: parseHHMM(j.window_start, `${id}.window_start`),
      window_end: parseHHMM(j.window_end, `${id}.window_end`),
    }
  })

  return {
    case_id,
    today: str(raw.today),
    areas,
    travel_minutes,
    technicians,
    jobs,
    manual_move: raw.manual_move ?? null,
    warnings,
  }
}

const CASES = new Map()
for (const raw of doc.cases) {
  const c = normaliseCase(raw)
  CASES.set(c.case_id, c)
}

export const allCases = () => [...CASES.values()]
export const getCase = (id) => CASES.get(id) ?? null
export const summaries = () =>
  allCases().map((c) => ({
    case_id: c.case_id,
    today: c.today,
    technicians: c.technicians.length,
    jobs: c.jobs.length,
    areas: c.areas.length,
  }))
