/**
 * Golden tests over the 25 public cases. The invariants here are the ones a
 * judge would check by hand, so a solver change that breaks one shows up as a
 * failing test rather than a subtly worse board.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allCases, getCase } from '../src/cases.js'
import { evaluate, CODES } from '../src/rules.js'
import { applyMove, baseline, solve, validateMove } from '../src/solver.js'

const cases = allCases()
const jobsOf = (c) => new Map(c.jobs.map((j) => [j.id, j]))

describe('public dataset', () => {
  it('loads all 25 cases', () => {
    assert.equal(cases.length, 25)
    assert.ok(cases.every((c) => /^PUB-\d\d$/.test(c.case_id)))
  })

  it('meets the brief minimums: >=12 technicians and >=30 jobs in every case', () => {
    for (const c of cases) {
      assert.ok(c.technicians.length >= 12, `${c.case_id} has ${c.technicians.length} technicians`)
      assert.ok(c.jobs.length >= 30, `${c.case_id} has ${c.jobs.length} jobs`)
    }
  })

  it('has a complete, symmetric travel table with a zero diagonal', () => {
    for (const c of cases)
      for (const a of c.areas)
        for (const b of c.areas) {
          const v = c.travel_minutes[a]?.[b]
          assert.equal(typeof v, 'number', `${c.case_id} missing ${a}→${b}`)
          assert.equal(v, c.travel_minutes[b][a], `${c.case_id} asymmetric ${a}↔${b}`)
          if (a === b) assert.equal(v, 0)
        }
  })
})

describe('AT2 — every generated plan is feasible', () => {
  for (const c of cases)
    it(`${c.case_id}: no route breaks a hard rule`, () => {
      const plan = solve(c)
      const jobs = jobsOf(c)
      for (const r of plan.routes) {
        const tech = c.technicians.find((t) => t.id === r.technician_id)
        const v = evaluate(r.stops.map((s) => s.job_id), tech, jobs, c.travel_minutes)
        assert.deepEqual(v, [], `${c.case_id}/${r.technician_id}: ${v[0]?.code} ${v[0]?.message}`)
      }
    })
})

describe('AT2 — the stated goal is actually improved', () => {
  for (const c of cases)
    it(`${c.case_id}: beats the naive baseline`, () => {
      const plan = solve(c)
      const base = baseline(c)
      const better =
        plan.score.assigned > base.score.assigned ||
        (plan.score.assigned === base.score.assigned &&
          plan.score.travel_minutes <= base.score.travel_minutes)
      assert.ok(
        better,
        `${c.case_id}: plan ${plan.score.assigned}/${plan.score.travel_minutes}m vs baseline ${base.score.assigned}/${base.score.travel_minutes}m`,
      )
    })
})

describe('AT3 — nothing is silently dropped', () => {
  for (const c of cases)
    it(`${c.case_id}: assigned + unassigned accounts for every job, each with a rule`, () => {
      const plan = solve(c)
      const assigned = plan.routes.flatMap((r) => r.stops.map((s) => s.job_id))
      const unassigned = plan.unassigned.map((u) => u.job_id)
      assert.equal(assigned.length + unassigned.length, c.jobs.length)
      assert.equal(new Set([...assigned, ...unassigned]).size, c.jobs.length)
      for (const r of plan.unassigned) {
        assert.ok(Object.values(CODES).includes(r.code), `${r.job_id} has code ${r.code}`)
        assert.ok(r.message.length > 20, `${r.job_id} reason is too thin: "${r.message}"`)
      }
    })
})

describe('AT3 — the planted impossible jobs are reported, not dropped', () => {
  it('every case plants at least one job no technician can do, and we say so', () => {
    for (const c of cases) {
      const have = new Set(c.technicians.flatMap((t) => t.skills))
      const impossible = c.jobs.filter((j) => !have.has(j.skill))
      assert.ok(impossible.length >= 1, `${c.case_id} has no planted skill gap`)
      const plan = solve(c)
      for (const j of impossible) {
        const r = plan.unassigned.find((u) => u.job_id === j.id)
        assert.ok(r, `${c.case_id}: ${j.id} vanished`)
        assert.equal(r.code, CODES.SKILL_MISMATCH)
      }
    }
  })

  it('jobs whose window is shorter than their duration are called out as impossible', () => {
    let found = 0
    for (const c of cases) {
      const plan = solve(c)
      for (const j of c.jobs) {
        if (j.window_end - j.window_start >= j.duration_minutes) continue
        found++
        const r = plan.unassigned.find((u) => u.job_id === j.id)
        assert.ok(r, `${c.case_id}: ${j.id} vanished`)
        assert.equal(r.code, CODES.WINDOW_TOO_SHORT)
      }
    }
    assert.ok(found >= 16, `expected the dataset's planted short windows, found ${found}`)
  })
})

describe('AT4 — the scripted manual_move', () => {
  for (const c of cases)
    it(`${c.case_id}: ${c.manual_move.job_id} → ${c.manual_move.to_technician} gets a named verdict`, () => {
      const plan = solve(c)
      const { job_id, to_technician } = c.manual_move
      const verdict = validateMove(c, plan, job_id, to_technician)
      const tech = c.technicians.find((t) => t.id === to_technician)
      const job = c.jobs.find((j) => j.id === job_id)

      if (!tech.skills.includes(job.skill)) {
        assert.equal(verdict.ok, false)
        assert.equal(verdict.violations[0].code, CODES.SKILL_MISMATCH)
        assert.match(verdict.violations[0].message, new RegExp(job.skill))
      }
      // Legal or not, a verdict always names at least one rule when refused.
      if (!verdict.ok) assert.ok(verdict.violations.length > 0)
    })

  it('a refused move never changes the plan', () => {
    for (const c of cases) {
      const plan = solve(c)
      const { job_id, to_technician } = c.manual_move
      const before = JSON.stringify(plan)
      const { plan: after, verdict } = applyMove(c, plan, job_id, to_technician)
      if (!verdict.ok) {
        assert.equal(JSON.stringify(after), before, `${c.case_id} mutated on a refusal`)
        assert.equal(after.version, plan.version)
      }
    }
  })

  it('validate-move and move always agree', () => {
    for (const c of cases) {
      const plan = solve(c)
      for (const t of c.technicians.slice(0, 4)) {
        const jobId = plan.routes.find((r) => r.stops.length)?.stops[0].job_id
        if (!jobId) continue
        const pre = validateMove(c, plan, jobId, t.id)
        const post = applyMove(c, plan, jobId, t.id).verdict
        assert.equal(pre.ok, post.ok, `${c.case_id} ${jobId}→${t.id} preview disagreed with drop`)
        assert.deepEqual(
          pre.violations.map((v) => v.code),
          post.violations.map((v) => v.code),
        )
      }
    }
  })
})

describe('determinism — judges must be able to reproduce a board', () => {
  for (const c of cases)
    it(`${c.case_id}: solving twice gives an identical plan`, () => {
      assert.deepEqual(solve(c), solve(getCase(c.case_id)))
    })
})
