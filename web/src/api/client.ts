import type { CaseDetail, CaseSummary, MoveVerdict, Plan, PlanEvent } from './types'
import {
  applyMove,
  normaliseCase,
  solve,
  solveBaseline,
  validateMove,
  type RawCase,
} from '../mocks/planner'

/** The Express API is the default. VITE_USE_MOCK=1 runs the browser fixture. */
const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1'

let cache: Map<string, CaseDetail> | null = null

async function loadCases(): Promise<Map<string, CaseDetail>> {
  if (cache) return cache
  const res = await fetch('/cases.json')
  if (!res.ok) throw new Error(`Can't load the case file (${res.status}).`)
  const doc = (await res.json()) as { cases: RawCase[] }
  cache = new Map(doc.cases.map((r) => [r.case_id, normaliseCase(r)]))
  return cache
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message ?? `Request failed (${res.status}).`)
  }
  return res.json() as Promise<T>
}

export const api = {
  async listCases(): Promise<CaseSummary[]> {
    if (!USE_MOCK) return json('/cases')
    const cs = await loadCases()
    return [...cs.values()].map((c) => ({
      case_id: c.case_id,
      today: c.today,
      technicians: c.technicians.length,
      jobs: c.jobs.length,
      areas: c.areas.length,
    }))
  },

  async getCase(id: string): Promise<CaseDetail> {
    if (!USE_MOCK) return json(`/cases/${id}`)
    const cs = await loadCases()
    const c = cs.get(id)
    if (!c) throw new Error(`Case ${id} is not in the case file.`)
    return c
  },

  async generatePlan(caseId: string): Promise<Plan> {
    if (!USE_MOCK) return json('/plans', { method: 'POST', body: JSON.stringify({ case_id: caseId }) })
    return solve(await this.getCase(caseId))
  },

  async validateMove(plan: Plan, jobId: string, toTech: string): Promise<MoveVerdict> {
    if (!USE_MOCK)
      return json(`/plans/${plan.id}/validate-move`, {
        method: 'POST',
        body: JSON.stringify({ job_id: jobId, to_technician: toTech }),
      })
    return validateMove(await this.getCase(plan.case_id), plan, jobId, toTech)
  },

  async move(plan: Plan, jobId: string, toTech: string): Promise<{ plan: Plan; verdict: MoveVerdict }> {
    if (USE_MOCK) return applyMove(await this.getCase(plan.case_id), plan, jobId, toTech)
    // A refused move is a 409 carrying the unchanged plan and the named rules.
    // That is a normal answer here, not a transport failure.
    const res = await fetch(`/api/plans/${plan.id}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, to_technician: toTech, version: plan.version }),
    })
    const body = await res.json()
    if (res.ok) return { plan: body.plan, verdict: body.verdict }
    if (res.status === 409) {
      // Two shapes arrive as 409: a rule refusal (carries a verdict) and a
      // stale-version conflict (carries only the current plan). Normalise both
      // so callers never touch an undefined verdict.
      return {
        plan: body.plan ?? plan,
        verdict: body.verdict ?? {
          ok: false,
          violations: body.error?.violations ?? [
            {
              code: body.error?.code ?? 'REFUSED',
              job_id: jobId,
              tech_id: toTech,
              message: body.error?.message ?? 'The move was refused.',
            },
          ],
        },
      }
    }
    throw new Error(body?.error?.message ?? `Move failed (${res.status}).`)
  },

  async emergency(plan: Plan, body: Record<string, unknown>): Promise<Plan> {
    if (USE_MOCK) throw new Error('Emergency replanning needs the API.')
    return json(`/plans/${plan.id}/emergency`, { method: 'POST', body: JSON.stringify(body) })
  },

  async sick(plan: Plan, body: { tech_id: string; from_time: string }): Promise<Plan> {
    if (USE_MOCK) throw new Error('Sick redistribution needs the API.')
    return json(`/plans/${plan.id}/sick`, { method: 'POST', body: JSON.stringify(body) })
  },

  async version(): Promise<{ solver_version: string; commit: string; cache: Record<string, unknown> }> {
    return json('/version')
  },

  async events(planId: string): Promise<PlanEvent[]> {
    if (USE_MOCK) return []
    return json(`/plans/${planId}/events`)
  },

  async baseline(plan: Plan): Promise<Plan> {
    if (USE_MOCK) return solveBaseline(await this.getCase(plan.case_id))
    return json(`/plans/${plan.id}/baseline`)
  },
}
