/* ─────────────────────────────────────────────────────────────────────────────
 * TEMPORARY DEV FIXTURE — delete at build-order step 6.
 *
 * The plan is explicit that there is exactly ONE hard-rule engine and it lives
 * in Go (internal/rules). This file is not that engine and must never become a
 * second source of truth. It exists only so the board can be looked at and
 * dragged before the backend exists. When `POST /api/plans` is real, delete
 * this directory and the VITE_USE_MOCK branch in api/client.ts.
 * ────────────────────────────────────────────────────────────────────────── */

import type {
  CaseDetail,
  Job,
  Minutes,
  MoveVerdict,
  Plan,
  Rejection,
  Route,
  Stop,
  Technician,
  Violation,
} from '../api/types'
import { dur, hhmm, parseHHMM } from '../lib/time'

type Travel = Record<string, Record<string, Minutes>>

export interface RawCase {
  case_id: string
  today: string
  areas: string[]
  travel_minutes: Travel
  technicians: Array<Omit<Technician, 'shift_start' | 'shift_end'> & {
    shift_start: string
    shift_end: string
  }>
  jobs: Array<Omit<Job, 'duration_minutes' | 'window_start' | 'window_end'> & {
    duration_minutes: number
    window_start: string
    window_end: string
  }>
  manual_move: { job_id: string; to_technician: string }
}

export function normaliseCase(raw: RawCase): CaseDetail {
  return {
    case_id: raw.case_id,
    today: raw.today,
    areas: raw.areas,
    travel_minutes: raw.travel_minutes,
    technicians: raw.technicians.map((t) => ({
      ...t,
      skills: t.skills.map((s) => s.trim().toLowerCase()),
      shift_start: parseHHMM(t.shift_start),
      shift_end: parseHHMM(t.shift_end),
    })),
    jobs: raw.jobs.map((j) => ({
      ...j,
      skill: j.skill.trim().toLowerCase(),
      window_start: parseHHMM(j.window_start),
      window_end: parseHHMM(j.window_end),
    })),
    manual_move: raw.manual_move,
  }
}

function travel(tt: Travel, from: string, to: string): Minutes | null {
  const v = tt[from]?.[to]
  return typeof v === 'number' ? v : null
}

/** Walk a technician's ordered job list once, filling every timing field. */
export function recompute(
  order: string[],
  tech: Technician,
  jobs: Map<string, Job>,
  tt: Travel,
): { stops: Stop[]; violations: Violation[] } {
  const stops: Stop[] = []
  const violations: Violation[] = []
  let cursor = tech.shift_start
  let loc = tech.home_area

  for (const id of order) {
    const j = jobs.get(id)!
    const t = travel(tt, loc, j.area)
    if (t === null) {
      violations.push({
        code: 'UNKNOWN_AREA',
        job_id: id,
        tech_id: tech.id,
        message: `No travel time is defined from ${loc} to ${j.area}.`,
      })
      break
    }
    const depart = cursor
    const arrive = cursor + t
    const start = Math.max(arrive, j.window_start)
    const end = start + j.duration_minutes
    stops.push({ job_id: id, depart, arrive, start, end, travel_in: t })

    if (end > j.window_end) {
      violations.push({
        code: 'WINDOW_LATE',
        job_id: id,
        tech_id: tech.id,
        message: `${tech.name} reaches ${j.area} at ${hhmm(arrive)}, but ${id} takes ${dur(
          j.duration_minutes,
        )} and must be finished by ${hhmm(j.window_end)}.`,
        detail: { arrive, window_end: j.window_end, duration: j.duration_minutes },
      })
    }
    if (end > tech.shift_end) {
      violations.push({
        code: 'SHIFT_END_OVERRUN',
        job_id: id,
        tech_id: tech.id,
        message: `${id} would end at ${hhmm(end)}, after ${tech.name}'s shift ends at ${hhmm(
          tech.shift_end,
        )}.`,
        detail: { end, shift_end: tech.shift_end },
      })
    }
    cursor = end
    loc = j.area
  }
  return { stops, violations }
}

export function skillViolation(job: Job, tech: Technician): Violation | null {
  if (tech.skills.includes(job.skill)) return null
  return {
    code: 'SKILL_MISMATCH',
    job_id: job.id,
    tech_id: tech.id,
    message: `${tech.name} does not have the ${job.skill} skill (has: ${
      tech.skills.join(', ') || 'none'
    }).`,
    detail: { required_skill: job.skill, has: tech.skills },
  }
}

/** Every hard rule broken by this exact route. Empty === feasible. */
export function evaluate(
  order: string[],
  tech: Technician,
  jobs: Map<string, Job>,
  tt: Travel,
): Violation[] {
  const out: Violation[] = []
  for (const id of order) {
    const v = skillViolation(jobs.get(id)!, tech)
    if (v) out.push(v)
  }
  out.push(...recompute(order, tech, jobs, tt).violations)
  return out
}

function routeTravel(stops: Stop[]): number {
  return stops.reduce((a, s) => a + s.travel_in, 0)
}

function routeIdle(stops: Stop[]): number {
  return stops.reduce((a, s) => a + (s.start - s.arrive), 0)
}

// ── Structural pre-screen ────────────────────────────────────────────────────
// "Impossible today" vs "no room today" is the distinction that makes the
// unassigned list useful to a dispatcher, so it is decided before scheduling.
function structuralReason(job: Job, techs: Technician[]): Rejection | null {
  if (techs.length === 0)
    return { job_id: job.id, code: 'NO_TECHNICIANS', message: 'No technicians are on shift today.' }

  const win = job.window_end - job.window_start
  if (win < job.duration_minutes)
    return {
      job_id: job.id,
      code: 'WINDOW_TOO_SHORT',
      message: `The customer window ${hhmm(job.window_start)}–${hhmm(job.window_end)} is ${dur(
        win,
      )}, but ${job.id} takes ${dur(job.duration_minutes)}. No schedule can fit it.`,
    }

  const skilled = techs.filter((t) => t.skills.includes(job.skill))
  if (skilled.length === 0)
    return {
      job_id: job.id,
      code: 'SKILL_MISMATCH',
      message: `No technician on shift has the ${job.skill} skill.`,
    }

  const fits = skilled.some((t) => {
    const lo = Math.max(t.shift_start, job.window_start)
    const hi = Math.min(t.shift_end, job.window_end)
    return hi - lo >= job.duration_minutes
  })
  if (!fits)
    return {
      job_id: job.id,
      code: 'SHIFT_END_OVERRUN',
      message: `Every ${job.skill} technician's shift overlaps ${hhmm(job.window_start)}–${hhmm(
        job.window_end,
      )} by less than the ${dur(job.duration_minutes)} this job needs.`,
    }

  return null
}

// ── Solver ───────────────────────────────────────────────────────────────────
// Goal, stated: maximise assigned jobs; among equal, minimise total travel.
// Deterministic: no RNG, fixed iteration order, so judges can reproduce a board.

interface Working {
  order: Map<string, string[]> // techId -> job ids
}

function tryInsert(
  w: Working,
  techId: string,
  pos: number,
  jobId: string,
  tech: Technician,
  jobs: Map<string, Job>,
  tt: Travel,
): { ok: boolean; addedTravel: number } {
  const cur = w.order.get(techId)!
  const before = routeTravel(recompute(cur, tech, jobs, tt).stops)
  const next = [...cur.slice(0, pos), jobId, ...cur.slice(pos)]
  if (evaluate(next, tech, jobs, tt).length > 0) return { ok: false, addedTravel: Infinity }
  const after = routeTravel(recompute(next, tech, jobs, tt).stops)
  return { ok: true, addedTravel: after - before }
}

export function solve(c: CaseDetail): Plan {
  const jobs = new Map(c.jobs.map((j) => [j.id, j]))
  const techs = c.technicians.filter((t) => t.shift_end > t.shift_start && t.skills.length > 0)
  const w: Working = { order: new Map(techs.map((t) => [t.id, [] as string[]])) }

  const rejections: Rejection[] = []
  const queue: Job[] = []
  for (const j of c.jobs) {
    const r = structuralReason(j, techs)
    if (r) rejections.push(r)
    else queue.push(j)
  }

  // Tightest deadline first, then narrowest window.
  queue.sort(
    (a, b) =>
      a.window_end - b.window_end ||
      a.window_end - a.window_start - (b.window_end - b.window_start) ||
      a.id.localeCompare(b.id),
  )

  for (const job of queue) {
    let best: { tech: string; pos: number; cost: number } | null = null
    for (const t of techs) {
      if (!t.skills.includes(job.skill)) continue
      const cur = w.order.get(t.id)!
      for (let pos = 0; pos <= cur.length; pos++) {
        const r = tryInsert(w, t.id, pos, job.id, t, jobs, tt(c))
        if (r.ok && (best === null || r.addedTravel < best.cost)) {
          best = { tech: t.id, pos, cost: r.addedTravel }
        }
      }
    }
    if (best) {
      const cur = w.order.get(best.tech)!
      cur.splice(best.pos, 0, job.id)
    } else {
      rejections.push({
        job_id: job.id,
        code: 'NO_CAPACITY',
        message: `Every ${job.skill} technician is already booked in a way that leaves no legal slot inside ${hhmm(
          job.window_start,
        )}–${hhmm(job.window_end)}.`,
      })
    }
  }

  // Local search: relocate each job to its cheapest legal slot anywhere.
  // Bounded passes keep this deterministic and fast.
  for (let pass = 0; pass < 3; pass++) {
    let improved = false
    for (const t of techs) {
      const cur = w.order.get(t.id)!
      for (let i = 0; i < cur.length; i++) {
        const jobId = cur[i]
        const job = jobs.get(jobId)!
        const removed = [...cur.slice(0, i), ...cur.slice(i + 1)]
        const saving =
          routeTravel(recompute(cur, t, jobs, tt(c)).stops) -
          routeTravel(recompute(removed, t, jobs, tt(c)).stops)

        const snapshot = w.order.get(t.id)!
        w.order.set(t.id, removed)

        let best: { tech: string; pos: number; cost: number } | null = null
        for (const o of techs) {
          if (!o.skills.includes(job.skill)) continue
          const oc = w.order.get(o.id)!
          for (let pos = 0; pos <= oc.length; pos++) {
            if (o.id === t.id && pos === i) continue
            const r = tryInsert(w, o.id, pos, jobId, o, jobs, tt(c))
            if (r.ok && (best === null || r.addedTravel < best.cost)) {
              best = { tech: o.id, pos, cost: r.addedTravel }
            }
          }
        }
        if (best && best.cost < saving - 0.0001) {
          w.order.get(best.tech)!.splice(best.pos, 0, jobId)
          improved = true
          break
        }
        w.order.set(t.id, snapshot)
      }
      if (improved) break
    }
    if (!improved) break
  }

  return materialise(c, w.order, rejections)
}

function tt(c: CaseDetail): Travel {
  return c.travel_minutes
}

export function materialise(
  c: CaseDetail,
  order: Map<string, string[]>,
  rejections: Rejection[],
  version = 1,
): Plan {
  const jobs = new Map(c.jobs.map((j) => [j.id, j]))
  const routes: Route[] = c.technicians.map((t) => {
    const ord = order.get(t.id) ?? []
    const { stops } = recompute(ord, t, jobs, c.travel_minutes)
    return {
      technician_id: t.id,
      stops,
      travel_minutes: routeTravel(stops),
      idle_minutes: routeIdle(stops),
    }
  })

  const assigned = routes.reduce((a, r) => a + r.stops.length, 0)
  const travelMin = routes.reduce((a, r) => a + r.travel_minutes, 0)
  const idleMin = routes.reduce((a, r) => a + r.idle_minutes, 0)
  const busy = routes.reduce(
    (a, r) => a + r.stops.reduce((b, s) => b + (s.end - s.start) + s.travel_in, 0),
    0,
  )
  const capacity = c.technicians.reduce((a, t) => a + (t.shift_end - t.shift_start), 0)

  let minSlack = Infinity
  for (const r of routes)
    for (const s of r.stops) minSlack = Math.min(minSlack, jobs.get(s.job_id)!.window_end - s.end)

  return {
    id: `${c.case_id}-plan`,
    case_id: c.case_id,
    version,
    routes,
    unassigned: rejections.sort((a, b) => a.job_id.localeCompare(b.job_id)),
    score: {
      assigned,
      total_jobs: c.jobs.length,
      travel_minutes: travelMin,
      idle_minutes: idleMin,
      min_slack_minutes: minSlack === Infinity ? 0 : minSlack,
      coverage_pct: capacity ? Math.round((busy / capacity) * 100) : 0,
      score: Math.round((100 * assigned) / (c.jobs.length || 1) - travelMin / 60),
    },
  }
}

// ── Baseline ────────────────────────────────────────────────────────────────
// First-feasible-technician in id order, no cheapest-insertion, no local search.
// This is the "clearly better than random" yardstick the brief asks us to state.
export function solveBaseline(c: CaseDetail): Plan {
  const jobs = new Map(c.jobs.map((j) => [j.id, j]))
  const techs = c.technicians.filter((t) => t.shift_end > t.shift_start && t.skills.length > 0)
  const order = new Map(techs.map((t) => [t.id, [] as string[]]))
  const rejections: Rejection[] = []

  for (const job of [...c.jobs].sort((a, b) => a.id.localeCompare(b.id))) {
    const r = structuralReason(job, techs)
    if (r) {
      rejections.push(r)
      continue
    }
    let placed = false
    for (const t of techs) {
      if (placed || !t.skills.includes(job.skill)) continue
      const cur = order.get(t.id)!
      const cand = [...cur, job.id]
      if (evaluate(cand, t, jobs, c.travel_minutes).length === 0) {
        order.set(t.id, cand)
        placed = true
      }
    }
    if (!placed)
      rejections.push({
        job_id: job.id,
        code: 'NO_CAPACITY',
        message: 'No technician had a free slot when jobs were taken in id order.',
      })
  }
  return materialise(c, order, rejections)
}

// ── Manual move (AT4) ────────────────────────────────────────────────────────
// validateMove and applyMove share one function; validate throws its copy away.
// That is what guarantees the drag preview and the drop result cannot disagree.

export function planOrder(plan: Plan): Map<string, string[]> {
  return new Map(plan.routes.map((r) => [r.technician_id, r.stops.map((s) => s.job_id)]))
}

function attempt(
  c: CaseDetail,
  plan: Plan,
  jobId: string,
  toTech: string,
): { order: Map<string, string[]>; violations: Violation[]; travelDelta: number } {
  const jobs = new Map(c.jobs.map((j) => [j.id, j]))
  const order = planOrder(plan)
  const tech = c.technicians.find((t) => t.id === toTech)!
  const job = jobs.get(jobId)!

  for (const [tid, ord] of order) {
    const i = ord.indexOf(jobId)
    if (i >= 0) order.set(tid, [...ord.slice(0, i), ...ord.slice(i + 1)])
  }

  const skill = skillViolation(job, tech)
  if (skill) return { order, violations: [skill], travelDelta: 0 }

  const cur = order.get(toTech) ?? []
  let best: { pos: number; cost: number } | null = null
  let firstFail: Violation[] = []
  for (let pos = 0; pos <= cur.length; pos++) {
    const cand = [...cur.slice(0, pos), jobId, ...cur.slice(pos)]
    const v = evaluate(cand, tech, jobs, c.travel_minutes)
    if (v.length === 0) {
      const cost = routeTravel(recompute(cand, tech, jobs, c.travel_minutes).stops)
      if (best === null || cost < best.cost) best = { pos, cost }
    } else if (firstFail.length === 0) {
      firstFail = v
    }
  }

  if (best === null) {
    return {
      order,
      violations: firstFail.length
        ? firstFail
        : [
            {
              code: 'NO_CAPACITY',
              job_id: jobId,
              tech_id: toTech,
              message: `${tech.name} has no legal slot for ${jobId} today.`,
            },
          ],
      travelDelta: 0,
    }
  }

  const beforeTravel = plan.score.travel_minutes
  order.set(toTech, [...cur.slice(0, best.pos), jobId, ...cur.slice(best.pos)])
  const after = materialise(c, order, [], plan.version)
  return { order, violations: [], travelDelta: after.score.travel_minutes - beforeTravel }
}

export function validateMove(
  c: CaseDetail,
  plan: Plan,
  jobId: string,
  toTech: string,
): MoveVerdict {
  const r = attempt(c, plan, jobId, toTech)
  return { ok: r.violations.length === 0, violations: r.violations, travel_delta: r.travelDelta }
}

export function applyMove(
  c: CaseDetail,
  plan: Plan,
  jobId: string,
  toTech: string,
): { plan: Plan; verdict: MoveVerdict } {
  const r = attempt(c, plan, jobId, toTech)
  const verdict: MoveVerdict = {
    ok: r.violations.length === 0,
    violations: r.violations,
    travel_delta: r.travelDelta,
  }
  if (!verdict.ok) return { plan, verdict }
  const kept = plan.unassigned.filter((u) => u.job_id !== jobId)
  return { plan: materialise(c, r.order, kept, plan.version + 1), verdict }
}
