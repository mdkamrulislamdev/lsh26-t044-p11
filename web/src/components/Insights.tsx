import type { Plan, Rejection, Technician } from '../api/types'
import { dur } from '../lib/time'

/* ── Visual encoding ───────────────────────────────────────────────────────
   These marks use the board's own three states, unchanged: solid teal is
   service, hatched sage is travel, bare ground is idle. A compressed view of
   the board has to be readable as the same object, so the bar's teal is the
   block's teal. Travel carries texture and every segment carries a written
   value, so identity never rests on hue alone.
   ────────────────────────────────────────────────────────────────────────── */

interface Parts {
  service: number
  travel: number
  idle: number
  capacity: number
}

export function partsFor(plan: Plan, tech: Technician, durationOf: (id: string) => number): Parts {
  const r = plan.routes.find((x) => x.technician_id === tech.id)
  const service = r ? r.stops.reduce((a, s) => a + durationOf(s.job_id), 0) : 0
  const travel = r?.travel_minutes ?? 0
  const idle = r?.idle_minutes ?? 0
  return { service, travel, idle, capacity: tech.shift_end - tech.shift_start }
}

/** Row-level utilisation. 6px tall — it sits under a name, not beside a title. */
export function Meter({ p, height = 6 }: { p: Parts; height?: number }) {
  const pct = (v: number) => (p.capacity ? (v / p.capacity) * 100 : 0)
  return (
    <div
      className="flex w-full overflow-hidden rounded-[2px] bg-smog"
      style={{ height }}
      role="img"
      aria-label={`${Math.round(pct(p.service))}% on jobs, ${Math.round(
        pct(p.travel),
      )}% travelling, rest idle`}
    >
      <div style={{ width: `${pct(p.service)}%`, background: 'var(--color-service)' }} />
      <div className="ml-[2px] hatch" style={{ width: `${pct(p.travel)}%` }} />
    </div>
  )
}

/** Fleet composition — the number behind "coverage". */
export function Composition({ parts }: { parts: Parts }) {
  const total = parts.capacity || 1
  const rows: Array<[string, number, string]> = [
    ['On jobs', parts.service, 'solid'],
    ['Travelling', parts.travel, 'hatch'],
    ['Idle', parts.idle, 'ground'],
  ]
  return (
    <section className="border border-rule bg-paper p-4">
      <h3 className="eyebrow">Where the fleet's hours go</h3>
      <div className="mt-3 flex h-9 w-full overflow-hidden rounded-[3px] bg-smog">
        <div
          style={{ width: `${(parts.service / total) * 100}%`, background: 'var(--color-service)' }}
        />
        <div className="hatch ml-[2px]" style={{ width: `${(parts.travel / total) * 100}%` }} />
        <div className="ground ml-[2px]" style={{ width: `${(parts.idle / total) * 100}%` }} />
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1">
        {rows.map(([label, v, kind]) => (
          <div key={label} className="flex items-center gap-2">
            <span
              className={`h-3 w-3 shrink-0 rounded-[2px] ${kind === 'hatch' ? 'hatch' : kind === 'ground' ? 'ground border border-rule-strong' : ''}`}
              style={kind === 'solid' ? { background: 'var(--color-service)' } : undefined}
              aria-hidden
            />
            <dt className="text-[12px] text-muted">{label}</dt>
            <dd className="mono text-[13px]">
              {dur(v)} · {Math.round((v / total) * 100)}%
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[12px] text-muted">
        Shift capacity {dur(parts.capacity)}. Idle is the bare board — the gaps you can see on the
        timeline.
      </p>
    </section>
  )
}

/** Why the day is failing. One series, so no legend — the heading names it. */
export function Failures({ items }: { items: Rejection[] }) {
  const counts = new Map<string, number>()
  for (const r of items) counts.set(r.code, (counts.get(r.code) ?? 0) + 1)
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const max = Math.max(1, ...rows.map(([, n]) => n))

  return (
    <section className="border border-rule bg-paper p-4">
      <h3 className="eyebrow">Why jobs went unassigned</h3>
      {rows.length === 0 ? (
        <p className="mt-3 text-[13px]">Every job is assigned.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map(([code, n]) => (
            <li key={code} className="grid grid-cols-[150px_1fr_auto] items-center gap-3">
              <span className="mono truncate text-[11px]" title={code}>
                {code}
              </span>
              <span className="h-3 bg-smog">
                <span
                  className="block h-3 rounded-r-[2px]"
                  style={{ width: `${(n / max) * 100}%`, background: 'var(--color-flag)' }}
                />
              </span>
              <span className="mono text-[13px]">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Not a chart. Two numbers and the delta between them — the brief asks us to
 *  show the plan is better than a naive one, and that is a headline, not a plot. */
export function Gain({ plan, baseline }: { plan: Plan; baseline: Plan }) {
  const saved = baseline.score.travel_minutes - plan.score.travel_minutes
  const pct = baseline.score.travel_minutes
    ? Math.round((saved / baseline.score.travel_minutes) * 100)
    : 0
  const more = plan.score.assigned - baseline.score.assigned
  return (
    <section className="border border-rule bg-paper p-4">
      <h3 className="eyebrow">Against a naive plan</h3>
      <p className="mt-2">
        <span className="mono text-[34px] leading-none font-medium">
          {saved >= 0 ? '−' : '+'}
          {Math.abs(saved)}
        </span>
        <span className="ml-2 text-[13px] text-muted">travel minutes ({Math.abs(pct)}%)</span>
      </p>
      <p className="mt-2 text-[13px]">
        {more > 0 ? `${more} more jobs assigned. ` : more < 0 ? `${-more} fewer assigned. ` : ''}
        Baseline takes jobs in id order and gives each to the first technician who can legally take
        it — <span className="mono">{baseline.score.assigned}</span>/
        {baseline.score.total_jobs} jobs, <span className="mono">{baseline.score.travel_minutes}</span>{' '}
        travel min.
      </p>
    </section>
  )
}

/**
 * Bonus 3: the dispatcher's edited plan measured against the one the optimiser
 * produced. Only shown once the plan has actually diverged — an unchanged plan
 * comparing to itself is noise.
 */
export function Compare({ current, generated }: { current: Plan; generated: Plan }) {
  const rows: Array<[string, number, number, 'up' | 'down']> = [
    ['Assigned', generated.score.assigned, current.score.assigned, 'up'],
    ['Travel minutes', generated.score.travel_minutes, current.score.travel_minutes, 'down'],
    ['Idle minutes', generated.score.idle_minutes, current.score.idle_minutes, 'down'],
    ['Tightest slack', generated.score.min_slack_minutes, current.score.min_slack_minutes, 'up'],
    ['Score', generated.score.score, current.score.score, 'up'],
  ]

  return (
    <section className="border border-rule bg-paper p-4">
      <h3 className="eyebrow">Your plan vs the generated one</h3>
      <table className="mt-3 w-full">
        <thead>
          <tr className="border-b border-rule text-left">
            <th className="eyebrow pb-1 font-normal">Measure</th>
            <th className="eyebrow pb-1 text-right font-normal">Generated</th>
            <th className="eyebrow pb-1 text-right font-normal">Now</th>
            <th className="eyebrow pb-1 text-right font-normal">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, was, now, goodDirection]) => {
            const delta = now - was
            const worse = delta !== 0 && (goodDirection === 'up' ? delta < 0 : delta > 0)
            return (
              <tr key={name} className="border-b border-rule last:border-b-0">
                <td className="py-1.5 text-[13px]">{name}</td>
                <td className="mono py-1.5 text-right text-[13px] text-muted">{was}</td>
                <td className="mono py-1.5 text-right text-[13px]">{now}</td>
                <td
                  className="mono py-1.5 text-right text-[13px]"
                  style={worse ? { color: 'var(--color-flag)' } : undefined}
                >
                  {delta === 0 ? '—' : `${delta > 0 ? '+' : ''}${delta}`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[12px] text-muted">
        Red marks a measure your edits made worse against the stated goal.
      </p>
    </section>
  )
}
