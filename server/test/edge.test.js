/**
 * Our own cases. The public data is clean; deployed data will not be. Each test
 * here is an entry from plans/03-edge-cases.md, and each asserts a *defined*
 * behaviour — a named reason — rather than merely "does not crash".
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normaliseCase } from '../src/cases.js'
import { hhmm, parseHHMM, recompute, ValidationError } from '../src/domain.js'
import { CODES, evaluate, structuralReason } from '../src/rules.js'
import { applyMove, baseline, insertEmergency, markSick, solve, validateMove } from '../src/solver.js'

// ── A tiny fixture builder, so each test states only what it is about ────────
const AREAS = ['Tejgaon', 'Mirpur', 'Motijheel']
const TRAVEL = {
  Tejgaon: { Tejgaon: 0, Mirpur: 30, Motijheel: 20 },
  Mirpur: { Tejgaon: 30, Mirpur: 0, Motijheel: 45 },
  Motijheel: { Tejgaon: 20, Mirpur: 45, Motijheel: 0 },
}

const tech = (id, over = {}) => ({
  id,
  name: `Tech ${id}`,
  skills: ['ac'],
  shift_start: 540, // 09:00
  shift_end: 1080, // 18:00
  home_area: 'Tejgaon',
  ...over,
})

const job = (id, over = {}) => ({
  id,
  area: 'Tejgaon',
  skill: 'ac',
  duration_minutes: 60,
  window_start: 540,
  window_end: 720,
  ...over,
})

const kase = (over = {}) => ({
  case_id: 'OWN-01',
  today: '2026-08-31',
  areas: AREAS,
  travel_minutes: TRAVEL,
  technicians: [tech('T01')],
  jobs: [job('J01')],
  manual_move: null,
  warnings: [],
  ...over,
})

const codes = (plan) => plan.unassigned.map((u) => u.code)
const reasonFor = (plan, id) => plan.unassigned.find((u) => u.job_id === id)

// ── Time parsing ─────────────────────────────────────────────────────────────
describe('time parsing', () => {
  it('accepts 24:00 as a shift end but rejects 24:30', () => {
    assert.equal(parseHHMM('24:00'), 1440)
    assert.throws(() => parseHHMM('24:30'), ValidationError)
  })

  it('rejects malformed times with the field named', () => {
    for (const bad of ['9:5', '', 'noon', '25:00', '09:60', null])
      assert.throws(() => parseHHMM(bad, 'window_start'), /window_start/)
  })

  it('round-trips', () => {
    for (const t of [0, 540, 725, 1439]) assert.equal(parseHHMM(hhmm(t)), t)
  })
})

// ── Ingest: malformed and hostile input ──────────────────────────────────────
describe('ingest rejects bad data at the boundary', () => {
  const raw = (over = {}) => ({
    case_id: 'X',
    today: '2026-08-31',
    areas: AREAS,
    travel_minutes: TRAVEL,
    technicians: [{ id: 'T01', name: 'A', skills: ['ac'], shift_start: '09:00', shift_end: '18:00', home_area: 'Tejgaon' }],
    jobs: [{ id: 'J01', area: 'Tejgaon', skill: 'ac', duration_minutes: 60, window_start: '09:00', window_end: '12:00' }],
    ...over,
  })

  it('refuses duplicate technician ids', () => {
    assert.throws(
      () => normaliseCase(raw({ technicians: [raw().technicians[0], raw().technicians[0]] })),
      /appears twice/,
    )
  })

  it('refuses duplicate job ids', () => {
    assert.throws(() => normaliseCase(raw({ jobs: [raw().jobs[0], raw().jobs[0]] })), /appears twice/)
  })

  it('refuses a zero or negative duration', () => {
    for (const d of [0, -30, 'sixty', null])
      assert.throws(() => normaliseCase(raw({ jobs: [{ ...raw().jobs[0], duration_minutes: d }] })), /duration_minutes/)
  })

  it('refuses a technician whose home area is not in the area list', () => {
    assert.throws(
      () => normaliseCase(raw({ technicians: [{ ...raw().technicians[0], home_area: 'Atlantis' }] })),
      /home_area/,
    )
  })

  it('refuses an empty area list', () => {
    assert.throws(() => normaliseCase(raw({ areas: [] })), /areas is empty/)
  })

  it('normalises skill casing and whitespace so " AC " matches "ac"', () => {
    const c = normaliseCase(
      raw({
        technicians: [{ ...raw().technicians[0], skills: [' AC ', 'Plumbing'] }],
        jobs: [{ ...raw().jobs[0], skill: ' Ac ' }],
      }),
    )
    assert.deepEqual(c.technicians[0].skills, ['ac', 'plumbing'])
    assert.equal(c.jobs[0].skill, 'ac')
    assert.equal(solve(c).score.assigned, 1)
  })

  it('warns rather than throws on an asymmetric travel table, and still plans', () => {
    const t = JSON.parse(JSON.stringify(TRAVEL))
    t.Tejgaon.Mirpur = 99
    const c = normaliseCase(raw({ travel_minutes: t }))
    assert.ok(c.warnings.some((w) => w.code === 'ASYMMETRIC_TRAVEL'))
    assert.equal(solve(c).score.assigned, 1)
  })

  it('warns on a missing travel pair instead of inventing a distance', () => {
    const t = JSON.parse(JSON.stringify(TRAVEL))
    delete t.Tejgaon.Mirpur
    const c = normaliseCase(raw({ travel_minutes: t }))
    assert.ok(c.warnings.some((w) => w.code === 'MISSING_TRAVEL'))
  })

  it('flags a shift that ends before it starts and excludes that technician', () => {
    const c = normaliseCase(
      raw({ technicians: [{ ...raw().technicians[0], shift_start: '22:00', shift_end: '06:00' }] }),
    )
    assert.ok(c.warnings.some((w) => w.code === 'INVALID_SHIFT'))
    const plan = solve(c)
    assert.equal(plan.score.assigned, 0)
    // Excluding the only technician leaves nobody on shift at all.
    assert.equal(codes(plan)[0], CODES.NO_TECHNICIANS)
  })
})

// ── Structurally impossible, but valid input: plan, don't error ──────────────
describe('impossible jobs get the right reason', () => {
  it('window shorter than the duration', () => {
    const c = kase({ jobs: [job('J01', { window_start: 540, window_end: 570, duration_minutes: 60 })] })
    assert.equal(reasonFor(solve(c), 'J01').code, CODES.WINDOW_TOO_SHORT)
  })

  it('window that ends before it starts', () => {
    const c = kase({ jobs: [job('J01', { window_start: 720, window_end: 540 })] })
    assert.equal(reasonFor(solve(c), 'J01').code, CODES.WINDOW_INVALID)
  })

  it('a skill nobody has', () => {
    const c = kase({ jobs: [job('J01', { skill: 'gas_line' })] })
    const r = reasonFor(solve(c), 'J01')
    assert.equal(r.code, CODES.SKILL_MISMATCH)
    assert.match(r.message, /gas_line/)
  })

  it('a job in an area with no travel time to it', () => {
    const c = kase({ jobs: [job('J01', { area: 'Atlantis' })] })
    assert.equal(reasonFor(solve(c), 'J01').code, CODES.UNKNOWN_AREA)
  })

  it('a duration longer than any shift', () => {
    const c = kase({
      technicians: [tech('T01', { shift_start: 540, shift_end: 600 })],
      jobs: [job('J01', { duration_minutes: 600, window_start: 0, window_end: 1440 })],
    })
    assert.equal(reasonFor(solve(c), 'J01').code, CODES.SHIFT_END_OVERRUN)
  })

  it('a window entirely outside every shift', () => {
    const c = kase({ jobs: [job('J01', { window_start: 1200, window_end: 1380 })] })
    assert.equal(reasonFor(solve(c), 'J01').code, CODES.SHIFT_END_OVERRUN)
  })

  it('no technicians at all', () => {
    const plan = solve(kase({ technicians: [] }))
    assert.equal(plan.score.assigned, 0)
    assert.equal(codes(plan)[0], CODES.NO_TECHNICIANS)
  })
})

// ── Degenerate but valid shapes ──────────────────────────────────────────────
describe('degenerate cases still produce a plan', () => {
  it('zero jobs is an empty plan, not an error', () => {
    const plan = solve(kase({ jobs: [] }))
    assert.equal(plan.score.total_jobs, 0)
    assert.equal(plan.unassigned.length, 0)
    assert.equal(plan.score.coverage_pct, 0)
  })

  it('a single area means zero travel and no division by zero', () => {
    const c = kase({
      areas: ['Tejgaon'],
      travel_minutes: { Tejgaon: { Tejgaon: 0 } },
      jobs: [job('J01'), job('J02', { window_end: 900 })],
    })
    const plan = solve(c)
    assert.equal(plan.score.travel_minutes, 0)
    assert.equal(plan.score.assigned, 2)
  })

  it('travel longer than a whole shift makes the far job unassignable, with a reason', () => {
    const c = kase({
      travel_minutes: {
        Tejgaon: { Tejgaon: 0, Mirpur: 2000, Motijheel: 20 },
        Mirpur: { Tejgaon: 2000, Mirpur: 0, Motijheel: 2000 },
        Motijheel: { Tejgaon: 20, Mirpur: 2000, Motijheel: 0 },
      },
      jobs: [job('J01', { area: 'Mirpur', window_start: 540, window_end: 1080 })],
    })
    const r = reasonFor(solve(c), 'J01')
    assert.ok(r && r.code === CODES.NO_CAPACITY)
  })

  it('every job assignable to exactly one technician terminates immediately', () => {
    const c = kase({
      technicians: [tech('T01', { skills: ['ac'] }), tech('T02', { skills: ['plumbing'] })],
      jobs: [job('J01'), job('J02', { skill: 'plumbing' })],
    })
    const plan = solve(c)
    assert.equal(plan.score.assigned, 2)
    assert.equal(plan.unassigned.length, 0)
  })

  it('handles a large case without blowing the time budget', () => {
    const technicians = Array.from({ length: 40 }, (_, i) =>
      tech(`T${i}`, { skills: ['ac', 'plumbing'], home_area: AREAS[i % 3] }),
    )
    const jobs = Array.from({ length: 300 }, (_, i) =>
      job(`J${i}`, {
        area: AREAS[i % 3],
        skill: i % 2 ? 'ac' : 'plumbing',
        duration_minutes: 45,
        window_start: 540,
        window_end: 1080,
      }),
    )
    const t0 = Date.now()
    const plan = solve(kase({ technicians, jobs }), { timeBudgetMs: 2000 })
    const ms = Date.now() - t0
    assert.ok(ms < 15000, `took ${ms}ms`)
    assert.equal(
      plan.routes.reduce((a, r) => a + r.stops.length, 0) + plan.unassigned.length,
      300,
    )
  })
})

// ── The rule engine itself ───────────────────────────────────────────────────
describe('rule engine', () => {
  it('names every affected stop, not just the first — knock-on effects are visible', () => {
    const c = kase({
      jobs: [
        job('J01', { duration_minutes: 120, window_start: 540, window_end: 1080 }),
        job('J02', { duration_minutes: 120, window_start: 540, window_end: 720 }),
      ],
    })
    const jobs = new Map(c.jobs.map((j) => [j.id, j]))
    // J01 first pushes J02 past its window end.
    const v = evaluate(['J01', 'J02'], c.technicians[0], jobs, c.travel_minutes)
    assert.ok(v.some((x) => x.job_id === 'J02' && x.code === CODES.WINDOW_LATE))
  })

  it('idle is arrival-to-start, and the first leg departs from home at shift start', () => {
    const c = kase({ jobs: [job('J01', { area: 'Mirpur', window_start: 720, window_end: 900 })] })
    const stops = recompute(['J01'], c.technicians[0], new Map([['J01', c.jobs[0]]]), c.travel_minutes)
    assert.equal(stops[0].depart, 540) // 09:00 from Tejgaon
    assert.equal(stops[0].arrive, 570) // +30 travel
    assert.equal(stops[0].start, 720) // waits for the window
    assert.equal(stops[0].start - stops[0].arrive, 150) // idle
  })

  it('no return-home leg is charged at end of shift', () => {
    const c = kase({ jobs: [job('J01', { area: 'Mirpur', window_end: 900 })] })
    assert.equal(solve(c).score.travel_minutes, 30)
  })

  it('structuralReason returns null for a job that is merely hard, not impossible', () => {
    assert.equal(structuralReason(job('J01'), [tech('T01')], new Set(AREAS)), null)
  })
})

// ── Manual move ──────────────────────────────────────────────────────────────
describe('manual move', () => {
  const c = kase({
    technicians: [tech('T01'), tech('T02', { skills: ['plumbing'] })],
    jobs: [job('J01'), job('J02', { window_end: 900 })],
  })

  it('refuses a move to a technician without the skill, and names what they do have', () => {
    const plan = solve(c)
    const v = validateMove(c, plan, 'J01', 'T02')
    assert.equal(v.ok, false)
    assert.equal(v.violations[0].code, CODES.SKILL_MISMATCH)
    assert.match(v.violations[0].message, /plumbing/)
  })

  it('leaves the plan untouched when refused', () => {
    const plan = solve(c)
    const before = JSON.stringify(plan)
    const { plan: after } = applyMove(c, plan, 'J01', 'T02')
    assert.equal(JSON.stringify(after), before)
  })

  it('bumps the version when applied, so a stale writer is detected', () => {
    const two = kase({ technicians: [tech('T01'), tech('T02')], jobs: [job('J01')] })
    const plan = solve(two)
    const { plan: after, verdict } = applyMove(two, plan, 'J01', 'T02')
    assert.equal(verdict.ok, true)
    assert.equal(after.version, plan.version + 1)
  })

  it('404s on a job or technician that is not in the case', () => {
    const plan = solve(c)
    assert.throws(() => validateMove(c, plan, 'NOPE', 'T01'), /not in this case/)
    assert.throws(() => validateMove(c, plan, 'J01', 'T99'), /not in this case/)
  })
})

// ── Bonus behaviours ─────────────────────────────────────────────────────────
describe('emergency and sick replanning', () => {
  const c = kase({
    technicians: [tech('T01'), tech('T02')],
    jobs: [
      job('J01', { window_start: 540, window_end: 720 }),
      job('J02', { window_start: 720, window_end: 900 }),
      job('J03', { window_start: 900, window_end: 1080 }),
    ],
  })

  it('an emergency never displaces a job that already started', () => {
    const plan = solve(c)
    const started = plan.routes.flatMap((r) => r.stops).filter((s) => s.start < 720).map((s) => s.job_id)
    const withJob = { ...c, jobs: [...c.jobs, job('E1', { window_start: 720, window_end: 900 })] }
    const next = insertEmergency(withJob, plan, job('E1', { window_start: 720, window_end: 900 }), 720)
    const stillThere = next.routes.flatMap((r) => r.stops).map((s) => s.job_id)
    for (const id of started) assert.ok(stillThere.includes(id), `${id} was displaced`)
  })

  it('an infeasible emergency lands in unassigned with its rule, never silently dropped', () => {
    const plan = solve(c)
    const bad = job('E9', { skill: 'gas_line', window_start: 600, window_end: 700 })
    const withJob = { ...c, jobs: [...c.jobs, bad] }
    const next = insertEmergency(withJob, plan, bad, 600)
    const r = next.unassigned.find((u) => u.job_id === 'E9')
    assert.ok(r, 'the emergency vanished')
    assert.equal(r.code, CODES.SKILL_MISMATCH)
  })

  it('a sick technician keeps their completed work and loses the rest', () => {
    const plan = solve(c)
    const next = markSick(c, plan, 'T01', 720)
    const t01 = next.routes.find((r) => r.technician_id === 'T01')
    assert.ok(t01.stops.every((s) => s.start < 720), 'T01 kept work starting after they went off')
  })

  it('a sick technician with nobody to absorb the work still yields a valid plan', () => {
    const solo = kase({ technicians: [tech('T01')], jobs: [job('J01'), job('J02', { window_end: 900 })] })
    const plan = solve(solo)
    const next = markSick(solo, plan, 'T01', 0)
    assert.equal(next.score.assigned, 0)
    assert.equal(next.unassigned.length, 2)
    for (const u of next.unassigned) assert.ok(u.code && u.message)
  })
})

// ── Accounting invariants that must hold for any input ───────────────────────
describe('accounting holds on every fixture', () => {
  const fixtures = [
    kase(),
    kase({ jobs: [] }),
    kase({ technicians: [] }),
    kase({ jobs: [job('J01', { skill: 'gas_line' }), job('J02'), job('J03', { window_end: 560 })] }),
  ]

  for (const [i, c] of fixtures.entries())
    it(`fixture ${i}: assigned + unassigned === total, and the plan is feasible`, () => {
      for (const plan of [solve(c), baseline(c)]) {
        const assigned = plan.routes.flatMap((r) => r.stops.map((s) => s.job_id))
        assert.equal(assigned.length + plan.unassigned.length, c.jobs.length)
        assert.equal(new Set([...assigned, ...plan.unassigned.map((u) => u.job_id)]).size, c.jobs.length)
        const jobs = new Map(c.jobs.map((j) => [j.id, j]))
        for (const r of plan.routes) {
          const t = c.technicians.find((x) => x.id === r.technician_id)
          if (t.shift_end <= t.shift_start) continue
          assert.deepEqual(evaluate(r.stops.map((s) => s.job_id), t, jobs, c.travel_minutes), [])
        }
      }
    })
})
