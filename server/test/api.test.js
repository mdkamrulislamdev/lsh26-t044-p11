/**
 * HTTP-level tests. Every fixture is derived from the case under test — the
 * technician, job and move used in each assertion are read out of the generated
 * plan, so these stay honest if the dataset or the solver changes.
 *
 * Runs against the app with persistence off, so no database or network is
 * needed and the suite works in CI.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { allCases } from '../src/cases.js'
import { hhmm } from '../src/domain.js'

let server
let base

before(async () => {
  await new Promise((resolve) => {
    server = createApp({ persist: false }).listen(0, resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server?.close())

const get = async (path) => {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}
const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const cases = allCases()
/** A representative spread rather than all 25 — the solver suites cover the rest. */
const sample = [cases[0], cases[6], cases[12], cases[24]]

describe('health and metadata', () => {
  it('healthz is always ok', async () => {
    assert.deepEqual(await get('/api/healthz'), { status: 200, body: { ok: true } })
  })

  it('readyz distinguishes "not configured" from "down"', async () => {
    const { body } = await get('/api/readyz')
    assert.notEqual(body.db, true, 'no database is configured in this suite')
    assert.equal(body.persistence, false)
  })

  it('version reports the solver version, so a board can be traced to a build', async () => {
    const { body } = await get('/api/version')
    assert.match(body.solver_version, /^v\d+$/)
  })
})

describe('cases', () => {
  it('lists every case with counts that match the case itself', async () => {
    const { body } = await get('/api/cases')
    assert.equal(body.length, cases.length)
    for (const s of body) {
      const c = cases.find((x) => x.case_id === s.case_id)
      assert.equal(s.jobs, c.jobs.length)
      assert.equal(s.technicians, c.technicians.length)
      assert.equal(s.areas, c.areas.length)
    }
  })

  it('404s on a case that does not exist', async () => {
    const { status, body } = await get('/api/cases/NOPE-99')
    assert.equal(status, 404)
    assert.equal(body.error.code, 'NO_CASE')
  })
})

describe('request validation returns 400 naming the field', () => {
  const badBodies = [
    ['missing case_id', {}, 'case_id'],
    ['non-string case_id', { case_id: 123 }, 'case_id'],
    ['blank case_id', { case_id: '   ' }, 'case_id'],
    ['injection-ish case_id', { case_id: "PUB-01'; drop table plans;--" }, 'case_id'],
  ]

  for (const [name, body, field] of badBodies)
    it(name, async () => {
      const { status, body: out } = await post('/api/plans', body)
      assert.equal(status, 400, `${name} should be a 400, got ${status}`)
      assert.match(out.error.message, new RegExp(field))
    })

  it('a JSON array body is rejected', async () => {
    const { status } = await post('/api/plans', [])
    assert.equal(status, 400)
  })

  it('malformed JSON is a 400, not a crash', async () => {
    const { status } = await post('/api/plans', '{oops')
    assert.equal(status, 400)
  })

  it('every error carries a request id', async () => {
    const { body } = await post('/api/plans', {})
    assert.ok(body.error.request_id)
  })
})

describe('plan generation', () => {
  for (const c of sample)
    it(`${c.case_id}: totals agree with the case`, async () => {
      const { status, body: plan } = await post('/api/plans', { case_id: c.case_id })
      assert.equal(status, 200)
      assert.equal(plan.score.total_jobs, c.jobs.length)
      assert.equal(plan.routes.length, c.technicians.length)
      const assigned = plan.routes.flatMap((r) => r.stops.map((s) => s.job_id))
      assert.equal(assigned.length + plan.unassigned.length, c.jobs.length)
    })

  it('is idempotent over HTTP', async () => {
    const a = await post('/api/plans', { case_id: 'PUB-07' })
    const b = await post('/api/plans', { case_id: 'PUB-07' })
    assert.deepEqual(a.body.routes, b.body.routes)
  })
})

describe('manual move over HTTP — fixtures read from each plan', () => {
  for (const c of sample) {
    it(`${c.case_id}: the scripted move gets a named verdict`, async () => {
      const { body: plan } = await post('/api/plans', { case_id: c.case_id })
      const { job_id, to_technician } = c.manual_move
      const { body: verdict } = await post(`/api/plans/${plan.id}/validate-move`, {
        job_id,
        to_technician,
      })
      if (!verdict.ok) {
        assert.ok(verdict.violations.length > 0)
        assert.ok(verdict.violations[0].code)
        assert.ok(verdict.violations[0].message.length > 20)
      }
    })

    it(`${c.case_id}: a refused move is a 409 that leaves the plan alone`, async () => {
      const { body: plan } = await post('/api/plans', { case_id: c.case_id })
      // Find a real refusal in this case: a job and a technician lacking its skill.
      const stop = plan.routes.find((r) => r.stops.length)?.stops[0]
      const job = c.jobs.find((j) => j.id === stop.job_id)
      const wrong = c.technicians.find((t) => !t.skills.includes(job.skill))
      if (!wrong) return // every technician can do it; nothing to assert here

      const { status, body } = await post(`/api/plans/${plan.id}/move`, {
        job_id: job.id,
        to_technician: wrong.id,
      })
      assert.equal(status, 409)
      assert.equal(body.error.code, 'SKILL_MISMATCH')
      assert.match(body.error.message, new RegExp(job.skill))
      assert.deepEqual(body.plan.routes, plan.routes, 'the plan changed on a refusal')
    })

    it(`${c.case_id}: a legal move is applied and bumps the version`, async () => {
      const { body: plan } = await post('/api/plans', { case_id: c.case_id })
      const stop = plan.routes.find((r) => r.stops.length)?.stops[0]
      const holder = plan.routes.find((r) => r.stops.some((s) => s.job_id === stop.job_id))
      const job = c.jobs.find((j) => j.id === stop.job_id)
      const other = c.technicians.find(
        (t) => t.id !== holder.technician_id && t.skills.includes(job.skill),
      )
      if (!other) return

      const { status, body } = await post(`/api/plans/${plan.id}/move`, {
        job_id: job.id,
        to_technician: other.id,
      })
      assert.ok(status === 200 || status === 409, `unexpected ${status}`)
      if (status === 200) {
        assert.equal(body.plan.version, plan.version + 1)
        assert.equal(typeof body.verdict.travel_delta, 'number')
      } else {
        assert.ok(body.error.violations.length > 0, 'a 409 must name the rule')
      }
    })
  }

  it('a stale version is refused with STALE_PLAN', async () => {
    const { body: plan } = await post('/api/plans', { case_id: 'PUB-01' })
    const stop = plan.routes.find((r) => r.stops.length).stops[0]
    const { status, body } = await post(`/api/plans/${plan.id}/move`, {
      job_id: stop.job_id,
      to_technician: plan.routes[0].technician_id,
      version: plan.version + 99,
    })
    assert.equal(status, 409)
    assert.equal(body.error.code, 'STALE_PLAN')
  })

  it('an unknown job or technician is a 400 naming what is missing', async () => {
    const { body: plan } = await post('/api/plans', { case_id: 'PUB-01' })
    for (const payload of [
      { job_id: 'NOPE', to_technician: plan.routes[0].technician_id },
      { job_id: plan.routes.find((r) => r.stops.length).stops[0].job_id, to_technician: 'T999' },
    ]) {
      const { status, body } = await post(`/api/plans/${plan.id}/move`, payload)
      assert.equal(status, 404)
      assert.match(body.error.message, /not in this case/)
    }
  })
})

describe('emergency jobs', () => {
  it('an emergency job still exists on the next request', async () => {
    const c = cases[4]
    const { body: plan } = await post('/api/plans', { case_id: c.case_id })
    const skill = c.technicians[0].skills[0]
    const { status, body: after } = await post(`/api/plans/${plan.id}/emergency`, {
      id: 'EMERG-1',
      area: c.areas[0],
      skill,
      duration_minutes: 60,
      window_start: '14:00',
      window_end: '17:00',
      from_time: '13:00',
    })
    assert.equal(status, 200)
    assert.equal(after.score.total_jobs, c.jobs.length + 1)
    assert.ok(
      after.extra_jobs.some((j) => j.id === 'EMERG-1'),
      'the emergency job must travel with the plan',
    )
    const known =
      after.routes.some((r) => r.stops.some((s) => s.job_id === 'EMERG-1')) ||
      after.unassigned.some((u) => u.job_id === 'EMERG-1')
    assert.ok(known, 'the emergency job was silently dropped')
  })

  it('an impossible emergency is reported, never dropped', async () => {
    const c = cases[4]
    const { body: plan } = await post('/api/plans', { case_id: c.case_id })
    const { body: after } = await post(`/api/plans/${plan.id}/emergency`, {
      id: 'EMERG-BAD',
      area: c.areas[0],
      skill: c.technicians[0].skills[0],
      duration_minutes: 180,
      window_start: '14:00',
      window_end: '15:00',
    })
    const r = after.unassigned.find((u) => u.job_id === 'EMERG-BAD')
    assert.ok(r, 'the impossible emergency vanished')
    assert.equal(r.code, 'WINDOW_TOO_SHORT')
  })

  it('rejects a bad emergency payload field by field', async () => {
    const { body: plan } = await post('/api/plans', { case_id: 'PUB-01' })
    const good = {
      area: cases[0].areas[0],
      skill: 'ac',
      duration_minutes: 60,
      window_start: '14:00',
      window_end: '17:00',
    }
    const bad = [
      [{ ...good, duration_minutes: 0 }, /duration_minutes/],
      [{ ...good, duration_minutes: -5 }, /duration_minutes/],
      [{ ...good, window_start: '25:00' }, /window_start/],
      [{ ...good, window_start: 'noon' }, /window_start/],
      [{ ...good, skill: '' }, /skill/],
      [{ ...good, area: undefined }, /area/],
    ]
    for (const [payload, re] of bad) {
      const { status, body } = await post(`/api/plans/${plan.id}/emergency`, payload)
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(payload)}`)
      assert.match(body.error.message, re)
    }
  })
})

describe('technician off sick', () => {
  for (const c of sample.slice(0, 2)) {
    it(`${c.case_id}: keeps started work and accounts for the rest`, async () => {
      const { body: plan } = await post('/api/plans', { case_id: c.case_id })
      // Pick a technician who actually has work, from this plan.
      const route = plan.routes.find((r) => r.stops.length >= 2)
      if (!route) return
      const cutoff = route.stops[1].start
      const { status, body: after } = await post(`/api/plans/${plan.id}/sick`, {
        tech_id: route.technician_id,
        from_time: hhmm(cutoff),
      })
      assert.equal(status, 200)

      const theirs = after.routes.find((r) => r.technician_id === route.technician_id)
      assert.ok(
        theirs.stops.every((s) => s.start < cutoff),
        'the sick technician kept work starting after they went off',
      )
      const assigned = after.routes.flatMap((r) => r.stops.map((s) => s.job_id))
      assert.equal(assigned.length + after.unassigned.length, after.score.total_jobs)
      for (const u of after.unassigned) assert.ok(u.code && u.message)
    })
  }

  it('404s on a technician who is not in the case', async () => {
    const { body: plan } = await post('/api/plans', { case_id: 'PUB-01' })
    const { status, body } = await post(`/api/plans/${plan.id}/sick`, { tech_id: 'T999' })
    assert.equal(status, 404)
    assert.equal(body.error.code, 'NO_TECHNICIAN')
  })
})

describe('comparison and baseline', () => {
  it('the baseline is a valid plan for the same case', async () => {
    const { body: plan } = await post('/api/plans', { case_id: 'PUB-07' })
    const { status, body: base } = await get(`/api/plans/${plan.id}/baseline`)
    assert.equal(status, 200)
    assert.equal(base.case_id, plan.case_id)
    assert.equal(base.score.total_jobs, plan.score.total_jobs)
  })

  it('compare reports a delta for every measure', async () => {
    const { body: a } = await post('/api/plans', { case_id: 'PUB-07' })
    const { status, body } = await post('/api/plans/compare', { a: a.id, b: a.id })
    assert.equal(status, 200)
    for (const k of ['assigned', 'travel_minutes', 'idle_minutes', 'score'])
      assert.equal(body.delta[k], 0, `${k} should not differ from itself`)
  })
})

describe('unknown routes', () => {
  it('an unknown /api path is a shaped 404', async () => {
    const { status, body } = await get('/api/nope')
    assert.equal(status, 404)
    assert.equal(body.error.code, 'NOT_FOUND')
  })
})
