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
import { parseHHMM, ValidationError } from './domain.js'
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

export function createApp({ persist = true } = {}) {
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

  const needPlan = async (id) => {
    const p = persist ? await store.loadPlan(id) : null
    if (!p) throw Object.assign(new Error(`Plan ${id} is not stored.`), { status: 404, code: 'NO_PLAN' })
    return p
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
      const [db, kv] = await Promise.all([
        persist ? store.ping().catch(() => false) : Promise.resolve(true),
        cache.ping(),
      ])
      res.status(db ? 200 : 503).json({ ok: db, db, cache: kv })
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
      const caseId = String(req.body?.case_id ?? '')
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
      const cs = needCase(plan.case_id)
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
      const cs = needCase(plan.case_id)
      const { job_id, to_technician, position } = req.body ?? {}
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
      const cs = needCase(plan.case_id)
      const { job_id, to_technician, position, version } = req.body ?? {}

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
      const cs = needCase(plan.case_id)
      const b = req.body ?? {}
      const job = {
        id: String(b.id || `E${Date.now().toString().slice(-5)}`),
        area: String(b.area ?? ''),
        skill: String(b.skill ?? '').toLowerCase(),
        duration_minutes: Number(b.duration_minutes),
        window_start: parseHHMM(String(b.window_start), 'window_start'),
        window_end: parseHHMM(String(b.window_end), 'window_end'),
      }
      if (!Number.isFinite(job.duration_minutes) || job.duration_minutes <= 0)
        throw new ValidationError('BAD_JOB', 'duration_minutes must be greater than 0')

      const from = b.from_time ? parseHHMM(String(b.from_time), 'from_time') : 0
      // The emergency job joins the case for this plan's lifetime.
      const withJob = { ...cs, jobs: [...cs.jobs, job] }
      const next = insertEmergency(withJob, plan, job, from)
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
      const cs = needCase(plan.case_id)
      const techId = String(req.body?.tech_id ?? '')
      const tech = cs.technicians.find((t) => t.id === techId)
      if (!tech)
        throw Object.assign(new Error(`Technician ${techId} is not in this case.`), { status: 404 })
      const from = req.body?.from_time ? parseHHMM(String(req.body.from_time), 'from_time') : 0

      const next = markSick(cs, plan, techId, from)
      if (persist) await store.savePlan(next, 'sick')
      await logEvent(
        next.id,
        'tech_sick',
        `${techId} ${tech.name} is off from ${req.body?.from_time ?? 'the start of the day'}; their remaining jobs were redistributed.`,
        `${next.score.assigned}/${next.score.total_jobs} assigned · ${next.unassigned.length} unassigned`,
      )
      res.json(next)
    }),
  )

  app.post(
    '/api/plans/compare',
    wrap(async (req, res) => {
      const [a, b] = await Promise.all([needPlan(String(req.body?.a)), needPlan(String(req.body?.b))])
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
