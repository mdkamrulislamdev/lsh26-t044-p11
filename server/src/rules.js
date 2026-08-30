/**
 * THE hard-rule engine. The solver calls it, the manual-move endpoint calls it,
 * emergency and sick replanning call it. There is no second copy anywhere —
 * if there were, the verdict shown to the dispatcher would drift from the plan
 * the solver built.
 *
 * Every rejection in this system is a Violation value, never a log line. That
 * is the brief's hard constraint: "silence is not an answer."
 */

import { dur, hhmm, recompute, travel } from './domain.js'

export const CODES = {
  SKILL_MISMATCH: 'SKILL_MISMATCH',
  SHIFT_END_OVERRUN: 'SHIFT_END_OVERRUN',
  WINDOW_LATE: 'WINDOW_LATE',
  WINDOW_TOO_SHORT: 'WINDOW_TOO_SHORT',
  WINDOW_INVALID: 'WINDOW_INVALID',
  UNKNOWN_AREA: 'UNKNOWN_AREA',
  NO_TECHNICIANS: 'NO_TECHNICIANS',
  NO_CAPACITY: 'NO_CAPACITY',
  INVALID_SHIFT: 'INVALID_SHIFT',
  NO_SKILLS: 'NO_SKILLS',
  ALREADY_STARTED: 'ALREADY_STARTED',
}

const v = (code, job_id, tech_id, message, detail) => ({ code, job_id, tech_id, message, detail })

export function skillViolation(job, tech) {
  if (tech.skills.includes(job.skill)) return null
  return v(
    CODES.SKILL_MISMATCH,
    job.id,
    tech.id,
    `${tech.name} does not have the ${job.skill} skill (has: ${tech.skills.join(', ') || 'none'}).`,
    { required_skill: job.skill, has: tech.skills },
  )
}

/**
 * Every hard rule broken by this exact route. Empty array === feasible.
 *
 * Note it returns violations for EVERY affected stop, not the first. Inserting
 * a job mid-route can break a later one, and a move refused by a knock-on must
 * be able to name which job it knocked on.
 */
export function evaluate(order, tech, jobs, travelTable) {
  const out = []

  if (tech.shift_end <= tech.shift_start)
    out.push(v(CODES.INVALID_SHIFT, '', tech.id, `${tech.name}'s shift ends before it starts.`))
  if (!tech.skills.length)
    out.push(v(CODES.NO_SKILLS, '', tech.id, `${tech.name} has no skills recorded.`))

  for (const id of order) {
    const job = jobs.get(id)
    if (!job) continue
    const s = skillViolation(job, tech)
    if (s) out.push(s)
  }

  const stops = recompute(order, tech, jobs, travelTable)
  let loc = tech.home_area
  for (const stop of stops) {
    const job = jobs.get(stop.job_id)
    if (stop.unreachable) {
      out.push(
        v(CODES.UNKNOWN_AREA, stop.job_id, tech.id, `No travel time is defined from ${loc} to ${job.area}.`),
      )
      break
    }
    if (stop.end > job.window_end)
      out.push(
        v(
          CODES.WINDOW_LATE,
          stop.job_id,
          tech.id,
          `${tech.name} reaches ${job.area} at ${hhmm(stop.arrive)}, but ${stop.job_id} takes ${dur(
            job.duration_minutes,
          )} and must be finished by ${hhmm(job.window_end)}.`,
          { arrive: stop.arrive, window_end: job.window_end, duration: job.duration_minutes },
        ),
      )
    if (stop.end > tech.shift_end)
      out.push(
        v(
          CODES.SHIFT_END_OVERRUN,
          stop.job_id,
          tech.id,
          `${stop.job_id} would end at ${hhmm(stop.end)}, after ${tech.name}'s shift ends at ${hhmm(
            tech.shift_end,
          )}.`,
          { end: stop.end, shift_end: tech.shift_end },
        ),
      )
    loc = job.area
  }
  return out
}

export const isFeasible = (order, tech, jobs, tt) => evaluate(order, tech, jobs, tt).length === 0

/**
 * Structural pre-screen: is this job impossible today, regardless of schedule?
 *
 * "Impossible" vs "no room left" is the distinction that makes the unassigned
 * list useful to a dispatcher, and the sample data is built to test it — every
 * one of the 25 public cases plants at least one job no technician can do.
 */
export function structuralReason(job, techs, areas) {
  if (!techs.length)
    return { job_id: job.id, code: CODES.NO_TECHNICIANS, message: 'No technicians are on shift today.' }

  if (job.window_end <= job.window_start)
    return {
      job_id: job.id,
      code: CODES.WINDOW_INVALID,
      message: `The customer window ${hhmm(job.window_start)}–${hhmm(job.window_end)} ends before it starts.`,
    }

  if (areas && !areas.has(job.area))
    return {
      job_id: job.id,
      code: CODES.UNKNOWN_AREA,
      message: `${job.area} is not in this case's area list, so no travel time to it exists.`,
    }

  const win = job.window_end - job.window_start
  if (win < job.duration_minutes)
    return {
      job_id: job.id,
      code: CODES.WINDOW_TOO_SHORT,
      message: `The customer window ${hhmm(job.window_start)}–${hhmm(job.window_end)} is ${dur(
        win,
      )}, but ${job.id} takes ${dur(job.duration_minutes)}. No schedule can fit it.`,
    }

  const skilled = techs.filter((t) => t.skills.includes(job.skill))
  if (!skilled.length)
    return {
      job_id: job.id,
      code: CODES.SKILL_MISMATCH,
      message: `No technician on shift has the ${job.skill} skill.`,
    }

  const fits = skilled.some(
    (t) =>
      Math.min(t.shift_end, job.window_end) - Math.max(t.shift_start, job.window_start) >=
      job.duration_minutes,
  )
  if (!fits)
    return {
      job_id: job.id,
      code: CODES.SHIFT_END_OVERRUN,
      message: `Every ${job.skill} technician's shift overlaps ${hhmm(job.window_start)}–${hhmm(
        job.window_end,
      )} by less than the ${dur(job.duration_minutes)} this job needs.`,
    }

  return null
}

/** Is any technician physically able to reach this job's area at all? */
export function reachable(job, techs, travelTable) {
  return techs.some((t) => travel(travelTable, t.home_area, job.area) !== null)
}
