import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { CaseDetail, Job, Plan, Route, Technician } from '../api/types'
import { dur, hhmm } from '../lib/time'
import { Meter } from './Insights'

const LABEL_W = 148

interface Geometry {
  from: number
  to: number
  ppm: number
}

export function geometry(c: CaseDetail, ppm: number): Geometry {
  // An empty technician list would make Math.min/max return ±Infinity and the
  // whole board would compute NaN widths. Fall back to a plain working day.
  if (!c.technicians.length) return { from: 480, to: 1080, ppm }
  const from = Math.floor(Math.min(...c.technicians.map((t) => t.shift_start)) / 60) * 60
  const to = Math.ceil(Math.max(...c.technicians.map((t) => t.shift_end)) / 60) * 60
  return { from, to, ppm: ppm }
}

const x = (g: Geometry, t: number) => (t - g.from) * g.ppm
const w = (g: Geometry, mins: number) => Math.max(mins * g.ppm, 2)

/* ── Hour axis ─────────────────────────────────────────────────────────────
   The hours are the only numbering on this board. Technicians are not a
   sequence, so they get no 01/02/03 markers. */
export function Axis({ g }: { g: Geometry }) {
  const hours: number[] = []
  for (let t = g.from; t <= g.to; t += 60) hours.push(t)
  return (
    <div className="sticky top-0 z-20 flex bg-smog">
      <div style={{ width: LABEL_W }} className="shrink-0" />
      <div className="relative h-7" style={{ width: (g.to - g.from) * g.ppm }}>
        {hours.map((t) => (
          <div key={t} className="absolute top-0 bottom-0" style={{ left: x(g, t) }}>
            <span className="mono absolute top-1 left-1 text-[11px] text-muted">
              {String(Math.floor(t / 60)).padStart(2, '0')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function HourRules({ g }: { g: Geometry }) {
  const hours: number[] = []
  for (let t = g.from; t <= g.to; t += 60) hours.push(t)
  return (
    <>
      {hours.map((t) => (
        <div
          key={t}
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-rule"
          style={{ left: x(g, t) }}
        />
      ))}
    </>
  )
}

function JobBlock({
  g,
  stop,
  job,
  offending,
  onOpen,
}: {
  g: Geometry
  stop: Route['stops'][number]
  job: Job
  offending: boolean
  onOpen: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: job.id })
  const slack = job.window_end - stop.end
  return (
    <>
      {stop.travel_in > 0 && (
        <div
          className="hatch block-move absolute top-1/2 h-3 -translate-y-1/2"
          style={{ left: x(g, stop.depart), width: w(g, stop.travel_in) }}
          title={`${stop.travel_in} min travel — arrives ${hhmm(stop.arrive)}`}
          aria-hidden
        />
      )}
      <button
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        onClick={onOpen}
        className={`block-move absolute top-1/2 h-9 -translate-y-1/2 overflow-hidden rounded-[3px] px-2 text-left text-paper ${
          isDragging ? 'opacity-40' : ''
        } ${offending ? 'ring-2 ring-flag' : ''}`}
        style={{
          left: x(g, stop.start),
          width: w(g, job.duration_minutes),
          background: 'var(--color-service)',
          cursor: 'grab',
        }}
        title={`${job.id} · ${job.area} · ${job.skill} · ${hhmm(stop.start)}–${hhmm(
          stop.end,
        )} · window ${hhmm(job.window_start)}–${hhmm(job.window_end)} · slack ${dur(
          Math.max(slack, 0),
        )}`}
      >
        <span className="mono block truncate text-[11px] leading-[14px] font-medium">{job.id}</span>
        <span className="block truncate text-[11px] leading-[13px] opacity-75">{job.area}</span>
      </button>
    </>
  )
}

export function TechRow({
  g,
  tech,
  route,
  jobs,
  hover,
  verdictOk,
  offending,
  onOpenJob,
}: {
  g: Geometry
  tech: Technician
  route: Route
  jobs: Map<string, Job>
  hover: boolean
  verdictOk: boolean | null
  offending: Set<string>
  onOpenJob: (id: string) => void
}) {
  const { setNodeRef } = useDroppable({ id: tech.id })
  const ring = hover ? (verdictOk === false ? 'ring-flag' : 'ring-ink') : ''
  return (
    <div className="flex border-b border-rule last:border-b-0">
      <div
        style={{ width: LABEL_W }}
        className="shrink-0 border-r border-rule bg-paper px-3 py-1.5"
      >
        <div className="mono text-[11px] text-muted">{tech.id}</div>
        <div className="truncate text-[13px] leading-[16px] font-medium">{tech.name}</div>
        <div className="truncate text-[11px] text-muted">{tech.skills.join(' · ')}</div>
        <div className="mono text-[11px] text-muted">
          {hhmm(tech.shift_start)}–{hhmm(tech.shift_end)}
        </div>
        <div className="mt-1.5">
          <Meter
            p={{
              service: route.stops.reduce((a, s) => a + (jobs.get(s.job_id)?.duration_minutes ?? 0), 0),
              travel: route.travel_minutes,
              idle: route.idle_minutes,
              capacity: tech.shift_end - tech.shift_start,
            }}
          />
        </div>
      </div>
      <div
        ref={setNodeRef}
        className={`ground relative h-[62px] ${ring ? `ring-2 ring-inset ${ring}` : ''}`}
        style={{ width: (g.to - g.from) * g.ppm }}
      >
        <HourRules g={g} />
        {/* Outside the shift is not board — it is not available at all. */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-smog opacity-70"
          style={{ width: w(g, tech.shift_start - g.from) }}
        />
        <div
          className="absolute top-0 right-0 bottom-0 bg-smog opacity-70"
          style={{ width: w(g, g.to - tech.shift_end) }}
        />
        {route.stops.map((s) => {
          const job = jobs.get(s.job_id)
          if (!job) return null
          return (
            <JobBlock
              key={s.job_id}
              g={g}
              stop={s}
              job={job}
              offending={offending.has(s.job_id)}
              onOpen={() => onOpenJob(s.job_id)}
            />
          )
        })}
        {route.stops.length === 0 && (
          <span className="absolute top-1/2 left-3 -translate-y-1/2 text-[12px] text-muted">
            No jobs assigned
          </span>
        )}
      </div>
    </div>
  )
}

export function Board({
  c,
  plan,
  ppm,
  hoverTech,
  verdictOk,
  offending,
  onOpenJob,
}: {
  c: CaseDetail
  plan: Plan
  ppm: number
  hoverTech: string | null
  verdictOk: boolean | null
  offending: Set<string>
  onOpenJob: (id: string) => void
}) {
  const g = geometry(c, ppm)
  const jobs = new Map(c.jobs.map((j) => [j.id, j]))
  const routes = new Map(plan.routes.map((r) => [r.technician_id, r]))
  return (
    <div className="overflow-x-auto">
      <div style={{ width: LABEL_W + (g.to - g.from) * g.ppm }}>
        <Axis g={g} />
        <div className="border border-rule bg-paper">
          {c.technicians.map((t) => (
            <TechRow
              key={t.id}
              g={g}
              tech={t}
              route={routes.get(t.id) ?? { technician_id: t.id, stops: [], travel_minutes: 0, idle_minutes: 0 }}
              jobs={jobs}
              hover={hoverTech === t.id}
              verdictOk={verdictOk}
              offending={offending}
              onOpenJob={onOpenJob}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
