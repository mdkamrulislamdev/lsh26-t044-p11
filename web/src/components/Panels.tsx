import type { CaseDetail, Job, Plan, Rejection, Technician } from '../api/types'
import { dur, hhmm } from '../lib/time'

export function MetricStrip({ plan }: { plan: Plan }) {
  const s = plan.score
  const items: Array<[string, string]> = [
    ['assigned', `${s.assigned}/${s.total_jobs}`],
    ['travel', `${s.travel_minutes} min`],
    ['idle', `${s.idle_minutes} min`],
    ['tightest slack', `${s.min_slack_minutes} min`],
    ['coverage', `${s.coverage_pct}%`],
    ['score', String(s.score)],
  ]
  return (
    <div className="flex flex-wrap items-baseline gap-x-7 gap-y-1" aria-live="polite">
      {items.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-2">
          <span className="mono text-[20px] leading-none font-medium">{v}</span>
          <span className="eyebrow">{k}</span>
        </div>
      ))}
    </div>
  )
}

export function Unassigned({ items, jobs }: { items: Rejection[]; jobs: Map<string, Job> }) {
  return (
    <section className="border border-rule bg-paper">
      <header className="flex items-baseline gap-3 border-b border-rule px-4 py-3">
        <h2 className="eyebrow">Unassigned — {items.length}</h2>
        <p className="text-[12px] text-muted">Each one names the rule that blocked it.</p>
      </header>
      {items.length === 0 ? (
        <p className="px-4 py-4 text-[13px]">Every job is assigned.</p>
      ) : (
        <ul>
          {items.map((r) => {
            const j = jobs.get(r.job_id)
            return (
              <li key={r.job_id} className="border-b border-rule px-4 py-3 last:border-b-0">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="mono text-[13px] font-medium">{r.job_id}</span>
                  {j && (
                    <span className="text-[12px] text-muted">
                      {j.area} · {j.skill} · {dur(j.duration_minutes)} ·{' '}
                      <span className="mono">
                        {hhmm(j.window_start)}–{hhmm(j.window_end)}
                      </span>
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[13px] leading-[18px]">
                  <span className="mono text-[11px]" style={{ color: 'var(--color-flag)' }}>
                    {r.code}
                  </span>
                  <span> — {r.message}</span>
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function JobDrawer({
  job,
  c,
  plan,
  onClose,
}: {
  job: Job
  c: CaseDetail
  plan: Plan
  onClose: () => void
}) {
  const holder = plan.routes.find((r) => r.stops.some((s) => s.job_id === job.id))
  const stop = holder?.stops.find((s) => s.job_id === job.id)
  const tech = c.technicians.find((t) => t.id === holder?.technician_id)
  const skilled = c.technicians.filter((t: Technician) => t.skills.includes(job.skill))

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/25" onClick={onClose}>
      <div
        className="flex w-[380px] max-w-full flex-col overflow-y-auto bg-paper"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-rule px-5 py-4">
          <div>
            <div className="eyebrow">Job</div>
            <h2 className="display text-[20px]">{job.id}</h2>
            <p className="text-[13px] text-muted">
              {job.area} · {job.skill} · {dur(job.duration_minutes)}
            </p>
          </div>
          <button onClick={onClose} className="text-[13px] underline underline-offset-2">
            Close
          </button>
        </header>

        <dl className="grid grid-cols-2 gap-px border-b border-rule bg-rule">
          {[
            ['Customer window', `${hhmm(job.window_start)}–${hhmm(job.window_end)}`],
            ['Technician', tech ? `${tech.id} ${tech.name}` : 'Unassigned'],
            ['Scheduled', stop ? `${hhmm(stop.start)}–${hhmm(stop.end)}` : '—'],
            ['Slack to window end', stop ? dur(Math.max(job.window_end - stop.end, 0)) : '—'],
            ['Travel in', stop ? `${stop.travel_in} min` : '—'],
            ['Idle before', stop ? `${stop.start - stop.arrive} min` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="bg-paper px-5 py-3">
              <dt className="eyebrow">{k}</dt>
              <dd className="mono mt-0.5 text-[15px]">{v}</dd>
            </div>
          ))}
        </dl>

        <section className="px-5 py-4">
          <h3 className="eyebrow">Who could take this</h3>
          <ul className="mt-2 space-y-1.5">
            {c.technicians.map((t) => {
              const ok = t.skills.includes(job.skill)
              return (
                <li key={t.id} className="flex items-baseline gap-2 text-[13px]">
                  <span className="mono w-9 shrink-0 text-muted">{t.id}</span>
                  <span className="w-20 shrink-0 truncate">{t.name}</span>
                  {ok ? (
                    <span className="text-muted">has {job.skill}</span>
                  ) : (
                    <span style={{ color: 'var(--color-flag)' }} className="mono text-[11px]">
                      SKILL_MISMATCH
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="mt-3 text-[12px] text-muted">
            {skilled.length} of {c.technicians.length} technicians have the {job.skill} skill. Drag
            the block onto a row to test a move — the ledger names any rule it breaks.
          </p>
        </section>
      </div>
    </div>
  )
}
