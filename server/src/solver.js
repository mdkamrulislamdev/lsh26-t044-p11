/**
 * Stated goal, lexicographic:
 *   1. maximise the number of assigned jobs
 *   2. among plans with equal assignment count, minimise total travel minutes
 *
 * Deterministic by construction — no RNG, fixed iteration order, fixed
 * tie-breaks. Judges re-running PUB-07 must get the same board.
 */

import { hhmm, recompute, routeIdle, routeTravel } from './domain.js'
import { CODES, evaluate, isFeasible, structuralReason } from './rules.js'

const SOLVER_VERSION = 'v1'
export { SOLVER_VERSION }

function usableTechs(cs) {
  return cs.technicians.filter((t) => t.shift_end > t.shift_start && t.skills.length > 0)
}

function addedTravel(order, pos, jobId, tech, jobs, tt) {
  const before = routeTravel(recompute(order, tech, jobs, tt))
  const next = [...order.slice(0, pos), jobId, ...order.slice(pos)]
  if (!isFeasible(next, tech, jobs, tt)) return null
  return routeTravel(recompute(next, tech, jobs, tt)) - before
}

/** Cheapest legal (technician, position) for one job across the whole fleet. */
function cheapestSlot(order, techs, job, jobs, tt, skip) {
  let best = null
  for (const t of techs) {
    if (!t.skills.includes(job.skill)) continue
    const cur = order.get(t.id)
    for (let pos = 0; pos <= cur.length; pos++) {
      if (skip && skip.tech === t.id && skip.pos === pos) continue
      const cost = addedTravel(cur, pos, job.id, t, jobs, tt)
      if (cost === null) continue
      if (!best || cost < best.cost || (cost === best.cost && t.id < best.tech))
        best = { tech: t.id, pos, cost }
    }
  }
  return best
}

/**
 * Insertion orderings. Cheapest-insertion is greedy, so the order jobs arrive
 * in changes what fits — and no single ordering wins on every case. We run a
 * few deterministic ones and keep the lexicographic best. Multi-start, not
 * randomness: the same case still yields the same board every time.
 */
const ORDERINGS = [
  ['deadline', (a, b) => a.window_end - b.window_end || (a.window_end - a.window_start) - (b.window_end - b.window_start)],
  ['narrowest', (a, b) => (a.window_end - a.window_start) - (b.window_end - b.window_start) || a.window_end - b.window_end],
  ['longest', (a, b) => b.duration_minutes - a.duration_minutes || a.window_end - b.window_end],
  ['id', () => 0],
]

/** Is plan A better than plan B under the stated goal? */
function better(a, b) {
  if (!b) return true
  if (a.assigned !== b.assigned) return a.assigned > b.assigned
  return a.travel < b.travel
}

function construct(cs, techs, jobs, queue, cmp) {
  const order = new Map(techs.map((t) => [t.id, []]))
  const unplaced = []
  for (const job of [...queue].sort((x, y) => cmp(x, y) || x.id.localeCompare(y.id))) {
    const best = cheapestSlot(order, techs, job, jobs, cs.travel_minutes)
    if (best) order.get(best.tech).splice(best.pos, 0, job.id)
    else unplaced.push(job)
  }
  return { order, unplaced }
}

/**
 * Local search. Relocate for travel, then retry the unplaced pool — assignment
 * count is the primary objective, so a placement always beats a travel saving.
 */
function improve(cs, techs, jobs, order, unplaced, deadline) {
  for (let pass = 0; pass < 8; pass++) {
    if (Date.now() > deadline) return true
    let improved = false

    for (const t of techs) {
      const cur = order.get(t.id)
      for (let i = 0; i < cur.length; i++) {
        const jobId = cur[i]
        const without = [...cur.slice(0, i), ...cur.slice(i + 1)]
        const saving =
          routeTravel(recompute(cur, t, jobs, cs.travel_minutes)) -
          routeTravel(recompute(without, t, jobs, cs.travel_minutes))

        order.set(t.id, without)
        const best = cheapestSlot(order, techs, jobs.get(jobId), jobs, cs.travel_minutes, { tech: t.id, pos: i })
        if (best && best.cost < saving) {
          order.get(best.tech).splice(best.pos, 0, jobId)
          improved = true
          break
        }
        order.set(t.id, cur)
      }
      if (improved) break
    }

    for (let k = unplaced.length - 1; k >= 0; k--) {
      const best = cheapestSlot(order, techs, unplaced[k], jobs, cs.travel_minutes)
      if (best) {
        order.get(best.tech).splice(best.pos, 0, unplaced[k].id)
        unplaced.splice(k, 1)
        improved = true
      }
    }

    if (!improved) break
  }
  return false
}

export function solve(cs, { timeBudgetMs = Number(process.env.SOLVER_TIME_BUDGET_MS) || 3000 } = {}) {
  const jobs = new Map(cs.jobs.map((j) => [j.id, j]))
  const areas = new Set(cs.areas)
  const techs = usableTechs(cs)

  // Structural pre-screen: impossible today, regardless of any schedule.
  const structural = []
  const queue = []
  for (const j of cs.jobs) {
    const r = structuralReason(j, techs, areas)
    if (r) structural.push(r)
    else queue.push(j)
  }

  const slice = Math.max(50, Math.floor(timeBudgetMs / ORDERINGS.length))
  let winner = null
  let partial = false

  for (const [, cmp] of ORDERINGS) {
    const { order, unplaced } = construct(cs, techs, jobs, queue, cmp)
    partial = improve(cs, techs, jobs, order, unplaced, Date.now() + slice) || partial
    const candidate = {
      order,
      unplaced,
      assigned: [...order.values()].reduce((a, o) => a + o.length, 0),
      travel: cs.technicians.reduce(
        (a, t) => a + routeTravel(recompute(order.get(t.id) ?? [], t, jobs, cs.travel_minutes)),
        0,
      ),
    }
    if (better(candidate, winner)) winner = candidate
  }

  const rejections = [
    ...structural,
    ...winner.unplaced.map((job) => ({
      job_id: job.id,
      code: CODES.NO_CAPACITY,
      message: `Every ${job.skill} technician is already booked in a way that leaves no legal slot inside ${hhmm(
        job.window_start,
      )}–${hhmm(job.window_end)}.`,
    })),
  ]

  return materialise(cs, winner.order, rejections, { partial })
}

/**
 * Baseline: jobs in id order, each to the first technician who can legally take
 * it, appended at the end. No cheapest-insertion, no local search. This is the
 * "clearly better than random" yardstick the brief requires us to state.
 */
export function baseline(cs) {
  const jobs = new Map(cs.jobs.map((j) => [j.id, j]))
  const areas = new Set(cs.areas)
  const techs = usableTechs(cs)
  const order = new Map(techs.map((t) => [t.id, []]))
  const rejections = []

  for (const job of [...cs.jobs].sort((a, b) => a.id.localeCompare(b.id))) {
    const r = structuralReason(job, techs, areas)
    if (r) {
      rejections.push(r)
      continue
    }
    let placed = false
    for (const t of techs) {
      if (placed || !t.skills.includes(job.skill)) continue
      const cand = [...order.get(t.id), job.id]
      if (isFeasible(cand, t, jobs, cs.travel_minutes)) {
        order.set(t.id, cand)
        placed = true
      }
    }
    if (!placed)
      rejections.push({
        job_id: job.id,
        code: CODES.NO_CAPACITY,
        message: 'No technician had a free slot when jobs were taken in id order.',
      })
  }
  return materialise(cs, order, rejections)
}

export function materialise(cs, order, rejections, { version = 1, partial = false, id } = {}) {
  const jobs = new Map(cs.jobs.map((j) => [j.id, j]))
  const routes = cs.technicians.map((t) => {
    const stops = recompute(order.get(t.id) ?? [], t, jobs, cs.travel_minutes)
    return {
      technician_id: t.id,
      stops,
      travel_minutes: routeTravel(stops),
      idle_minutes: routeIdle(stops),
      service_minutes: stops.reduce((a, s) => a + jobs.get(s.job_id).duration_minutes, 0),
    }
  })

  const assigned = routes.reduce((a, r) => a + r.stops.length, 0)
  const travel_minutes = routes.reduce((a, r) => a + r.travel_minutes, 0)
  const idle_minutes = routes.reduce((a, r) => a + r.idle_minutes, 0)
  const service = routes.reduce((a, r) => a + r.service_minutes, 0)
  const capacity = cs.technicians.reduce((a, t) => a + Math.max(0, t.shift_end - t.shift_start), 0)

  let min_slack_minutes = Infinity
  for (const r of routes)
    for (const s of r.stops)
      min_slack_minutes = Math.min(min_slack_minutes, jobs.get(s.job_id).window_end - s.end)

  return {
    id: id ?? `${cs.case_id}-${SOLVER_VERSION}`,
    case_id: cs.case_id,
    version,
    solver_version: SOLVER_VERSION,
    partial,
    routes,
    unassigned: [...rejections].sort((a, b) => a.job_id.localeCompare(b.job_id)),
    score: {
      assigned,
      total_jobs: cs.jobs.length,
      travel_minutes,
      idle_minutes,
      service_minutes: service,
      min_slack_minutes: Number.isFinite(min_slack_minutes) ? min_slack_minutes : 0,
      coverage_pct: capacity ? Math.round(((service + travel_minutes) / capacity) * 100) : 0,
      score: Math.round((100 * assigned) / (cs.jobs.length || 1) - travel_minutes / 60),
    },
  }
}

export const planOrder = (plan) =>
  new Map(plan.routes.map((r) => [r.technician_id, r.stops.map((s) => s.job_id)]))

// ── Manual move (AT4) ────────────────────────────────────────────────────────
// validateMove and applyMove call this one function; validate throws its copy
// away. That is what makes the drag preview and the drop result identical.

function attemptMove(cs, plan, jobId, toTech, position) {
  const jobs = new Map(cs.jobs.map((j) => [j.id, j]))
  const job = jobs.get(jobId)
  const tech = cs.technicians.find((t) => t.id === toTech)
  if (!job) throw Object.assign(new Error(`Job ${jobId} is not in this case.`), { status: 404 })
  if (!tech) throw Object.assign(new Error(`Technician ${toTech} is not in this case.`), { status: 404 })

  const order = planOrder(plan)
  if (!order.has(toTech)) order.set(toTech, [])
  for (const [tid, ord] of order) {
    const i = ord.indexOf(jobId)
    if (i >= 0) order.set(tid, [...ord.slice(0, i), ...ord.slice(i + 1)])
  }

  const cur = order.get(toTech)
  const positions =
    typeof position === 'number' ? [Math.max(0, Math.min(position, cur.length))] : cur.map((_, i) => i).concat(cur.length)

  let best = null
  let firstFail = []
  for (const pos of positions) {
    const cand = [...cur.slice(0, pos), jobId, ...cur.slice(pos)]
    const violations = evaluate(cand, tech, jobs, cs.travel_minutes)
    if (!violations.length) {
      const cost = routeTravel(recompute(cand, tech, jobs, cs.travel_minutes))
      if (!best || cost < best.cost) best = { pos, cost }
    } else if (!firstFail.length) {
      firstFail = violations
    }
  }

  if (!best)
    return {
      ok: false,
      order,
      violations: firstFail.length
        ? firstFail
        : [
            {
              code: CODES.NO_CAPACITY,
              job_id: jobId,
              tech_id: toTech,
              message: `${tech.name} has no legal slot for ${jobId} today.`,
            },
          ],
      travel_delta: 0,
    }

  order.set(toTech, [...cur.slice(0, best.pos), jobId, ...cur.slice(best.pos)])
  const after = materialise(cs, order, [], { version: plan.version })
  return {
    ok: true,
    order,
    violations: [],
    travel_delta: after.score.travel_minutes - plan.score.travel_minutes,
  }
}

export function validateMove(cs, plan, jobId, toTech, position) {
  const r = attemptMove(cs, plan, jobId, toTech, position)
  return { ok: r.ok, violations: r.violations, travel_delta: r.travel_delta }
}

export function applyMove(cs, plan, jobId, toTech, position) {
  const r = attemptMove(cs, plan, jobId, toTech, position)
  const verdict = { ok: r.ok, violations: r.violations, travel_delta: r.travel_delta }
  if (!r.ok) return { plan, verdict }
  const kept = plan.unassigned.filter((u) => u.job_id !== jobId)
  return {
    plan: materialise(cs, r.order, kept, { version: plan.version + 1, id: plan.id }),
    verdict,
  }
}

// ── Bonus: emergency insert, technician off sick ─────────────────────────────
// Both freeze anything already started and replan only the rest, through the
// same rule engine.

function freeze(plan, fromTime) {
  const frozen = new Map()
  const loose = []
  for (const r of plan.routes) {
    frozen.set(r.technician_id, r.stops.filter((s) => s.start < fromTime).map((s) => s.job_id))
    loose.push(...r.stops.filter((s) => s.start >= fromTime).map((s) => s.job_id))
  }
  return { frozen, loose }
}

function replan(cs, frozen, loose, keptRejections, version, id) {
  const jobs = new Map(cs.jobs.map((j) => [j.id, j]))
  const techs = usableTechs(cs)
  const order = new Map(techs.map((t) => [t.id, frozen.get(t.id) ?? []]))
  const rejections = [...keptRejections]

  const pending = loose
    .map((jid) => jobs.get(jid))
    .filter(Boolean)
    .sort((a, b) => a.window_end - b.window_end || a.id.localeCompare(b.id))

  for (const job of pending) {
    const best = cheapestSlot(order, techs, job, jobs, cs.travel_minutes)
    if (best) order.get(best.tech).splice(best.pos, 0, job.id)
    else
      rejections.push({
        job_id: job.id,
        code: CODES.NO_CAPACITY,
        message: `After replanning there was no legal slot left for ${job.id} inside ${hhmm(
          job.window_start,
        )}–${hhmm(job.window_end)}.`,
      })
  }
  return materialise(cs, order, rejections, { version, id })
}

export function insertEmergency(cs, plan, job, fromTime) {
  const areas = new Set(cs.areas)
  const techs = usableTechs(cs)
  const structural = structuralReason(job, techs, areas)
  const { frozen, loose } = freeze(plan, fromTime)
  const kept = [...plan.unassigned]
  if (structural) kept.push(structural)
  return replan(cs, frozen, structural ? loose : [job.id, ...loose], kept, plan.version + 1, plan.id)
}

export function markSick(cs, plan, techId, fromTime) {
  const { frozen, loose } = freeze(plan, fromTime)

  // Everything the sick technician had not started joins the pool to rehome;
  // what they already started stays on their row.
  const done = frozen.get(techId) ?? []
  frozen.set(techId, [])

  // Replan without them, so nothing new is given to someone who has gone home.
  const available = { ...cs, technicians: cs.technicians.filter((t) => t.id !== techId) }
  const next = replan(available, frozen, loose, [...plan.unassigned], plan.version + 1, plan.id)

  // Then put their completed work back on the board — it happened.
  const order = planOrder(next)
  order.set(techId, done)
  return materialise(cs, order, next.unassigned, { version: plan.version + 1, id: plan.id })
}
