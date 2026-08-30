import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { CaseDetail, Job, Plan, Route, Technician } from '../api/types'
import { dur, hhmm } from '../lib/time'
import { Meter } from './Insights'

/* ── Phone layout ──────────────────────────────────────────────────────────
   A 12-hour timeline does not survive a 390px screen: every block collapses to
   a sliver and the whole point — reading the shape of a day — is lost. So on a
   phone the same plan becomes a per-technician agenda, and the encoding moves
   from width to sequence. Travel and idle stay visible as their own rows,
   because they are the waste the board exists to show.
   ────────────────────────────────────────────────────────────────────────── */

function StopCard({ stop, job, offending, onOpen }: {
  stop: Route['stops'][number]
  job: Job
  offending: boolean
  onOpen: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: job.id })
  const slack = job.window_end - stop.end
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onOpen}
      className={`w-full border-l-[3px] px-3 py-2 text-left ${isDragging ? 'opacity-40' : ''}`}
      style={{
        borderLeftColor: offending ? 'var(--color-flag)' : 'var(--color-service)',
        background: 'color-mix(in srgb, var(--color-service) 8%, transparent)',
        touchAction: 'none',
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="mono text-[13px] font-medium">{job.id}</span>
        <span className="mono text-[13px]">
          {hhmm(stop.start)}–{hhmm(stop.end)}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] text-muted">
          {job.area} · {job.skill} · {dur(job.duration_minutes)}
        </span>
        <span className="mono shrink-0 text-[11px] text-muted">
          {slack >= 0 ? `${slack}m slack` : 'late'}
        </span>
      </div>
    </button>
  )
}

function Gap({ travel, idle }: { travel: number; idle: number }) {
  if (travel <= 0 && idle <= 0) return null
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      {travel > 0 && (
        <>
          <span className="hatch h-2 w-8 shrink-0 rounded-[1px]" aria-hidden />
          <span className="mono text-[11px] text-muted">{travel}m travel</span>
        </>
      )}
      {idle > 0 && (
        <>
          <span className="ground h-2 w-8 shrink-0 rounded-[1px] border border-rule" aria-hidden />
          <span className="mono text-[11px] text-muted">{idle}m idle</span>
        </>
      )}
    </div>
  )
}

function TechCard({ tech, route, jobs, hover, verdictOk, offending, onOpenJob }: {
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
  const service = route.stops.reduce((a, s) => a + (jobs.get(s.job_id)?.duration_minutes ?? 0), 0)

  return (
    <section
      ref={setNodeRef}
      className={`border border-rule bg-paper ${ring ? `ring-2 ring-inset ${ring}` : ''}`}
    >
      <header className="border-b border-rule px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-medium">
            <span className="mono text-[11px] text-muted">{tech.id}</span> {tech.name}
          </span>
          <span className="mono text-[12px] text-muted">
            {hhmm(tech.shift_start)}–{hhmm(tech.shift_end)}
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <span className="truncate text-[12px] text-muted">{tech.skills.join(' · ')}</span>
          <span className="mono shrink-0 text-[11px] text-muted">
            {route.stops.length} {route.stops.length === 1 ? 'job' : 'jobs'} ·{' '}
            {route.travel_minutes}m travel
          </span>
        </div>
        <div className="mt-2">
          <Meter
            p={{
              service,
              travel: route.travel_minutes,
              idle: route.idle_minutes,
              capacity: tech.shift_end - tech.shift_start,
            }}
          />
        </div>
      </header>

      {route.stops.length === 0 ? (
        <p className="px-3 py-3 text-[12px] text-muted">No jobs assigned. Drop one here to try.</p>
      ) : (
        <div className="divide-y divide-rule">
          {route.stops.map((s) => {
            const job = jobs.get(s.job_id)
            if (!job) return null
            return (
              <div key={s.job_id}>
                <Gap travel={s.travel_in} idle={s.start - s.arrive} />
                <StopCard
                  stop={s}
                  job={job}
                  offending={offending.has(s.job_id)}
                  onOpen={() => onOpenJob(s.job_id)}
                />
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export function Agenda({ c, plan, hoverTech, verdictOk, offending, onOpenJob }: {
  c: CaseDetail
  plan: Plan
  hoverTech: string | null
  verdictOk: boolean | null
  offending: Set<string>
  onOpenJob: (id: string) => void
}) {
  const jobs = new Map(c.jobs.map((j) => [j.id, j]))
  const routes = new Map(plan.routes.map((r) => [r.technician_id, r]))
  return (
    <div className="space-y-3">
      {c.technicians.map((t) => (
        <TechCard
          key={t.id}
          tech={t}
          route={
            routes.get(t.id) ?? {
              technician_id: t.id,
              stops: [],
              travel_minutes: 0,
              idle_minutes: 0,
            }
          }
          jobs={jobs}
          hover={hoverTech === t.id}
          verdictOk={verdictOk}
          offending={offending}
          onOpenJob={onOpenJob}
        />
      ))}
    </div>
  )
}
