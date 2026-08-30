/**
 * The only module that knows SQL. Neon Postgres over the pooled endpoint, so
 * this works the same from Docker and from a Vercel function.
 */

import { setDefaultResultOrder } from 'node:dns'
import { setDefaultAutoSelectFamily } from 'node:net'
import pg from 'pg'

// Neon publishes both A and AAAA records. A Docker bridge network typically has
// no IPv6 egress, so the AAAA answers are unroutable. Node 22 turns Happy
// Eyeballs on by default, and racing a dead address family here stalls the
// connection until pg's timeout fires instead of failing over — the symptom is
// a bare ETIMEDOUT even though plain TCP to the IPv4 address succeeds.
// Prefer IPv4 and connect to one family. Both are harmless where IPv6 works.
try {
  setDefaultResultOrder('ipv4first')
  setDefaultAutoSelectFamily(false)
} catch {
  /* older runtimes */
}

/**
 * The pool is built lazily. Importing this module must never throw: /api/cases
 * and plan generation need no database at all, and a missing or unreachable
 * DATABASE_URL should degrade those paths to "no ledger, no persistence"
 * rather than take the whole function down at import time.
 */
let _pool = null

export function getPool() {
  if (_pool) return _pool
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!url) return null
  _pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  })
  _pool.on('error', (err) =>
    console.error(JSON.stringify({ level: 'error', msg: 'pg pool', err: err.message })),
  )
  return _pool
}

export const hasDatabase = () => Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL)

class NoDatabase extends Error {
  constructor() {
    super('No DATABASE_URL is configured, so plans are not persisted.')
    this.code = 'NO_DATABASE'
  }
}

export const q = (text, params) => {
  const p = getPool()
  if (!p) throw new NoDatabase()
  return p.query(text, params)
}

export async function tx(fn) {
  const p = getPool()
  if (!p) throw new NoDatabase()
  const client = await p.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── Plans ────────────────────────────────────────────────────────────────────

export async function savePlan(plan, source) {
  return tx(async (c) => {
    await c.query(
      `insert into plans (id, case_id, version, source, solver_version, score, routes, unassigned)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set
         version = excluded.version, source = excluded.source, score = excluded.score,
         routes = excluded.routes, unassigned = excluded.unassigned, updated_at = now()`,
      [
        plan.id,
        plan.case_id,
        plan.version,
        source,
        plan.solver_version,
        JSON.stringify(plan.score),
        JSON.stringify(plan.routes),
        JSON.stringify(plan.unassigned),
      ],
    )
    return plan
  })
}

export async function loadPlan(id) {
  const { rows } = await q(
    `select id, case_id, version, solver_version, score, routes, unassigned from plans where id = $1`,
    [id],
  )
  if (!rows.length) return null
  const r = rows[0]
  return {
    id: r.id,
    case_id: r.case_id,
    version: r.version,
    solver_version: r.solver_version,
    partial: false,
    score: r.score,
    routes: r.routes,
    unassigned: r.unassigned,
  }
}

// ── The ledger ───────────────────────────────────────────────────────────────
// Append-only. A refused move is an event too: the dispatcher's failed attempt
// and the rule that blocked it is exactly the history worth keeping.

export async function addEvent(planId, kind, summary, detail, violations) {
  const { rows } = await q(
    `insert into plan_events (plan_id, kind, summary, detail, violations)
     values ($1,$2,$3,$4,$5) returning id, at`,
    [planId, kind, summary, detail ?? null, JSON.stringify(violations ?? [])],
  )
  return { id: String(rows[0].id), at: rows[0].at, kind, summary, detail, violations: violations ?? [] }
}

export async function listEvents(planId, limit = 100) {
  const { rows } = await q(
    `select id, at, kind, summary, detail, violations from plan_events
     where plan_id = $1 order by at desc, id desc limit $2`,
    [planId, limit],
  )
  return rows.map((r) => ({
    id: String(r.id),
    at: r.at,
    kind: r.kind,
    summary: r.summary,
    detail: r.detail ?? undefined,
    violations: r.violations ?? [],
  }))
}

export async function ping() {
  if (!hasDatabase()) return false
  const { rows } = await q('select 1 as ok')
  return rows[0].ok === 1
}
