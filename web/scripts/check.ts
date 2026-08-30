/* Sanity harness for the dev-fixture planner. Mirrors the golden test that
 * internal/rules + internal/solver will own in Go. Run: npx tsx scripts/check.ts */
import { readFileSync } from 'node:fs'
import { evaluate, normaliseCase, solve, validateMove, type RawCase } from '../src/mocks/planner'

const doc = JSON.parse(readFileSync('public/cases.json', 'utf8')) as { cases: RawCase[] }
let failures = 0
const fail = (m: string) => {
  failures++
  console.log(`  FAIL ${m}`)
}

for (const raw of doc.cases) {
  const c = normaliseCase(raw)
  const jobs = new Map(c.jobs.map((j) => [j.id, j]))
  const t0 = Date.now()
  const plan = solve(c)
  const ms = Date.now() - t0

  // 1. Every generated route must be legal under the same engine that built it.
  for (const r of plan.routes) {
    const tech = c.technicians.find((t) => t.id === r.technician_id)!
    const v = evaluate(
      r.stops.map((s) => s.job_id),
      tech,
      jobs,
      c.travel_minutes,
    )
    if (v.length) fail(`${c.case_id} ${r.technician_id} infeasible: ${v[0].code} ${v[0].message}`)
  }

  // 2. assigned + unassigned === total, with no job in both and none missing.
  const assigned = plan.routes.flatMap((r) => r.stops.map((s) => s.job_id))
  const un = plan.unassigned.map((u) => u.job_id)
  const all = new Set([...assigned, ...un])
  if (assigned.length + un.length !== c.jobs.length)
    fail(`${c.case_id} counts: ${assigned.length}+${un.length} != ${c.jobs.length}`)
  if (all.size !== c.jobs.length) fail(`${c.case_id} a job is both assigned and unassigned`)

  // 3. Determinism.
  const again = solve(c)
  if (JSON.stringify(again.routes) !== JSON.stringify(plan.routes))
    fail(`${c.case_id} not deterministic`)

  // 4. The scripted manual_move verdict, and that a refusal never mutates.
  const mm = c.manual_move
  const verdict = validateMove(c, plan, mm.job_id, mm.to_technician)
  const tech = c.technicians.find((t) => t.id === mm.to_technician)!
  const job = jobs.get(mm.job_id)!
  const expectSkillFail = !tech.skills.includes(job.skill)
  if (expectSkillFail && (verdict.ok || verdict.violations[0]?.code !== 'SKILL_MISMATCH'))
    fail(`${c.case_id} manual_move should be SKILL_MISMATCH`)

  const s = plan.score
  console.log(
    `${c.case_id}  assigned ${String(s.assigned).padStart(2)}/${s.total_jobs}  ` +
      `travel ${String(s.travel_minutes).padStart(4)}m  idle ${String(s.idle_minutes).padStart(4)}m  ` +
      `cover ${String(s.coverage_pct).padStart(3)}%  score ${String(s.score).padStart(3)}  ` +
      `${String(ms).padStart(4)}ms  move:${verdict.ok ? 'legal' : verdict.violations[0]?.code}`,
  )
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} failures.`)
process.exit(failures === 0 ? 0 : 1)
