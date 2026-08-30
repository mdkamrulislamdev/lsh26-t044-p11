/**
 * The monolith's HTTP surface. Handlers are thin: validate, call the domain,
 * persist, log an event, respond. All scheduling decisions live in
 * rules.js / solver.js and are reached from nowhere else.
 */

import compression from 'compression'
import cors from 'cors'
import express from 'express'
import { randomUUID } from 'node:crypto'
import * as cache from './cache.js'
import { getCase, summaries } from './cases.js'
import { ValidationError } from './domain.js'
import * as V from './validate.js'
import * as store from './store.js'
import {
  applyMove,
  baseline,
  insertEmergency,
  markSick,
  SOLVER_VERSION,
  solve,
  validateMove,
} from './solver.js'

const CASE_TTL = 24 * 60 * 60
const PLAN_TTL = 60 * 60
const MOVE_TTL = 60

export function createApp({ persist = store.hasDatabase() } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(compression())
  app.use(express.json({ limit: '1mb' }))
  app.use(
    cors({
      origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : true,
    }),
  )

  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || randomUUID()
    res.setHeader('x-request-id', req.id)
    const t0 = Date.now()
    res.on('finish', () =>
      console.log(
        JSON.stringify({
          level: 'info',
          req: req.id,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - t0,
        }),
      ),
    )
    next()
  })

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

  const needCase = (id) => {
    const c = getCase(id)
    if (!c) throw Object.assign(new Error(`Case ${id} does not exist.`), { status: 404, code: 'NO_CASE' })
    return c
  }

  // With a database, plans are loaded. Without one, the solver is deterministic,
  // so a generated plan can be rebuilt exactly from its id — the board stays
  // fully usable and only the ledger and manual-move persistence are lost.
  // A plan's effective case is the static case plus any emergency jobs created
  // on it. Without this, an emergency job stops existing on the next request.
  const caseFor = (plan) => {
    const cs = needCase(plan.case_id)
    const extra = plan.extra_jobs ?? []
    return extra.length ? { ...cs, jobs: [...cs.jobs, ...extra] } : cs
  }

  const needPlan = async (id) => {
    if (persist) {
      const stored = await store.loadPlan(id).catch(() => null)
      if (stored) return stored
    }
    const caseId = String(id).replace(new RegExp(`-${SOLVER_VERSION}$`), '')
    const cs = getCase(caseId)
    if (!cs)
      throw Object.assign(new Error(`Plan ${id} is not stored and cannot be rebuilt.`), {
        status: 404,
        code: 'NO_PLAN',
      })
    return { ...solve(cs), extra_jobs: [] }
  }

  const logEvent = async (planId, kind, summary, detail, violations) => {
    if (!persist) return null
    try {
      return await store.addEvent(planId, kind, summary, detail, violations)
    } catch (e) {
      console.error(JSON.stringify({ level: 'warn', msg: 'ledger write failed', err: e.message }))
      return null
    }
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/api/healthz', (_req, res) => res.json({ ok: true }))
  app.get(
    '/api/readyz',
    wrap(async (_req, res) => {
      // "not_configured" is not the same as "down". The board works without a
      // database (deterministic rebuild) and without a cache, so neither being
      // absent is a failure — an absent one being *unreachable* is.
      const [db, kv] = await Promise.all([
        store.hasDatabase() ? store.ping().catch(() => false) : Promise.resolve('not_configured'),
        cache.enabled() ? cache.ping() : Promise.resolve('not_configured'),
      ])
      const ok = db !== false
      res.status(ok ? 200 : 503).json({ ok, db, cache: kv, persistence: persist })
    }),
  )
  app.get('/api/version', (_req, res) =>
    res.json({
      solver_version: SOLVER_VERSION,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.COMMIT_SHA ?? 'dev',
      cache: cache.cacheStats(),
    }),
  )

  // ── Cases ──────────────────────────────────────────────────────────────────
  app.get('/api/cases', (_req, res) => res.json(summaries()))

  app.get(
    '/api/cases/:id',
    wrap(async (req, res) => {
      needCase(req.params.id)
      const data = await cache.cached(cache.K.caseDetail(req.params.id), CASE_TTL, async () =>
        needCase(req.params.id),
      )
      res.json(data)
    }),
  )

  // ── Plans ──────────────────────────────────────────────────────────────────
  app.post(
    '/api/plans',
    wrap(async (req, res) => {
      const caseId = V.id(V.body(req), 'case_id')
      const cs = needCase(caseId)
      const plan = await cache.cached(cache.K.plan(caseId, SOLVER_VERSION), PLAN_TTL, () => solve(cs))
      if (persist) {
        await store.savePlan(plan, 'generated')
        await logEvent(
          plan.id,
          'plan_generated',
          `${caseId}: ${plan.score.assigned} of ${plan.score.total_jobs} jobs assigned across ${plan.routes.length} technicians.`,
          `${plan.score.travel_minutes} travel min · ${plan.unassigned.length} unassigned · score ${plan.score.score}`,
        )
        for (const w of cs.warnings ?? [])
          await logEvent(plan.id, 'data_warning', w.message, w.code)
      }
      res.json(plan)
    }),
  )

  app.get(
    '/api/plans/:id',
    wrap(async (req, res) => res.json(await needPlan(req.params.id))),
  )

  app.get(
    '/api/plans/:id/baseline',
    wrap(async (req, res) => {
      const plan = await needPlan(req.params.id)
      const cs = caseFor(plan)
      res.json(await cache.cached(`plan:base:${plan.case_id}:${SOLVER_VERSION}`, PLAN_TTL, () => baseline(cs)))
    }),
  )

  app.get(
    '/api/plans/:id/events',
    wrap(async (req, res) => res.json(persist ? await store.listEvents(req.params.id) : [])),
  )

  // ── Manual move (AT4) ──────────────────────────────────────────────────────
  // validate and move share one code path in solver.js; validate discards its
  // copy. The drag preview and the drop result cannot disagree.

  app.post(
    '/api/plans/:id/validate-move',
    wrap(async (req, res) => {
      const plan = await needPlan(req.params.id)
      const cs = caseFor(plan)
      const b = V.body(req)
      const job_id = V.id(b, 'job_id')
      const to_technician = V.id(b, 'to_technician')
      const position = V.integer(b, 'position', { min: 0, max: 999, required: false })
      const verdict = await cache.cached(
        cache.K.move(plan.id, plan.version, job_id, to_technician),
        MOVE_TTL,
        () => validateMove(cs, plan, String(job_id), String(to_technician), position),
      )
      res.json(verdict)
    }),
  )

  app.post(
    '/api/plans/:id/move',
    wrap(async (req, res) => {
      const plan = await needPlan(req.params.id)
      const cs = caseFor(plan)
      const b = V.body(req)
      const job_id = V.id(b, 'job_id')
      const to_technician = V.id(b, 'to_technician')
      const position = V.integer(b, 'position', { min: 0, max: 999, required: false })
      const version = V.integer(b, 'version', { min: 0, required: false })

      // Optimistic concurrency: two dispatchers cannot silently clobber.
      if (typeof version === 'number' && version !== plan.version)
        return res.status(409).json({
          error: { code: 'STALE_PLAN', message: 'This plan changed since you loaded it.' },
          plan,
        })

      const tech = cs.technicians.find((t) => t.id === to_technician)
      const { plan: next, verdict } = applyMove(cs, plan, String(job_id), String(to_technician), position)

      if (!verdict.ok) {
        await logEvent(
          plan.id,
          'move_refused',
          `${job_id} cannot go to ${to_technician}${tech ? ` ${tech.name}` : ''}. The plan is unchanged.`,
          null,
          verdict.violations,
        )
        return res.status(409).json({
          error: {
            code: verdict.violations[0]?.code ?? 'REFUSED',
            message: verdict.violations[0]?.message ?? 'The move breaks a hard rule.',
            violations: verdict.violations,
          },
          plan,
          verdict,
        })
      }

      next.extra_jobs = plan.extra_jobs ?? []
      if (persist) await store.savePlan(next, 'manual')
      await logEvent(
        next.id,
        'move_applied',
        `${job_id} moved to ${to_technician}${tech ? ` ${tech.name}` : ''}.`,
        `Total travel ${verdict.travel_delta >= 0 ? '+' : ''}${verdict.travel_delta} min · now ${next.score.travel_minutes} min`,
      )
      res.json({ plan: next, verdict })
    }),
  )

  // ── Bonus ──────────────────────────────────────────────────────────────────
  app.post(
    '/api/plans/:id/emergency',
    wrap(async (req, res) => {
      const plan = await needPlan(req.params.id)
      const cs = caseFor(plan)
      const b = V.body(req)
      const job = V.emergencyJob(b)
      const from = V.time(b, 'from_time', { required: false, fallback: 0 })

      if (cs.jobs.some((j) => j.id === job.id))
        throw new ValidationError('DUPLICATE_ID', `Job ${job.id} already exists in this plan.`)

      // The emergency job joins the case and is persisted with the plan, so it
      // is still there on the next request.
      const withJob = { ...cs, jobs: [...cs.jobs, job] }
      const next = insertEmergency(withJob, plan, job, from)
      next.extra_jobs = [...(plan.extra_jobs ?? []), job]
      if (persist) await store.savePlan(next, 'emergency')
      await logEvent(
        next.id,
        'emergency_added',
        `Emergency ${job.id} in ${job.area} added; jobs already started were left alone.`,
        `${next.score.assigned}/${next.score.total_jobs} assigned · ${next.score.travel_minutes} travel min`,
      )
      res.json(next)
    }),
  )

  app.post(
    '/api/plans/:id/sick',
    wrap(async (req, res) => {
      const plan = await needPlan(req.params.id)
      const cs = caseFor(plan)
      const b = V.body(req)
      const techId = V.id(b, 'tech_id')
      const tech = cs.technicians.find((t) => t.id === techId)
      if (!tech)
        throw Object.assign(new Error(`Technician ${techId} is not in this case.`), {
          status: 404,
          code: 'NO_TECHNICIAN',
        })
      const from = V.time(b, 'from_time', { required: false, fallback: 0 })

      const next = markSick(cs, plan, techId, from)
      next.extra_jobs = plan.extra_jobs ?? []
      if (persist) await store.savePlan(next, 'sick')
      await logEvent(
        next.id,
        'tech_sick',
        `${techId} ${tech.name} is off from ${b.from_time ?? 'the start of the day'}; their remaining jobs were redistributed.`,
        `${next.score.assigned}/${next.score.total_jobs} assigned · ${next.unassigned.length} unassigned`,
      )
      res.json(next)
    }),
  )

  app.post(
    '/api/plans/compare',
    wrap(async (req, res) => {
      const bd = V.body(req)
      const [a, b] = await Promise.all([needPlan(V.id(bd, 'a')), needPlan(V.id(bd, 'b'))])
      const keys = ['assigned', 'travel_minutes', 'idle_minutes', 'min_slack_minutes', 'coverage_pct', 'score']
      res.json({
        a: a.score,
        b: b.score,
        delta: Object.fromEntries(keys.map((k) => [k, (b.score[k] ?? 0) - (a.score[k] ?? 0)])),
      })
    }),
  )

  app.use('/api', (_req, res) =>
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } }),
  )

  // Errors are always shaped. A rule break is a 409 with violations, never a
  // bare 400, and every response carries the request id.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status ?? (err instanceof ValidationError ? 400 : 500)
    if (status >= 500) console.error(JSON.stringify({ level: 'error', req: req.id, err: err.stack }))
    res.status(status).json({
      error: {
        code: err.code ?? (status === 500 ? 'INTERNAL' : 'BAD_REQUEST'),
        message: status === 500 ? 'Something went wrong on our side.' : err.message,
        request_id: req.id,
      },
    })
  })

  return app
}

export default createApp
