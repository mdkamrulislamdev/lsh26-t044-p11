import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from './api/client'
import type { Plan, PlanEvent, Violation } from './api/types'
import { Board } from './components/Timeline'
import { Agenda } from './components/Agenda'
import { useMediaQuery } from './lib/useMediaQuery'
import { Ledger } from './components/Ledger'
import { JobDrawer, MetricStrip, Unassigned } from './components/Panels'
import { Compare, Composition, Failures, Gain } from './components/Insights'
import { EmergencySheet, SickSheet } from './components/Disruptions'
import { longDate } from './lib/time'

let seq = 0
const nextId = () => `e${++seq}`
const clock = () =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export default function App() {
  const [caseId, setCaseId] = useState('PUB-01')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [events, setEvents] = useState<PlanEvent[]>([])
  const [ppm, setPpm] = useState(1.7)
  const [dragJob, setDragJob] = useState<string | null>(null)
  const [hoverTech, setHoverTech] = useState<string | null>(null)
  const [preview, setPreview] = useState<PlanEvent | null>(null)
  const [verdictOk, setVerdictOk] = useState<boolean | null>(null)
  const [offending, setOffending] = useState<Set<string>>(new Set())
  const [openJob, setOpenJob] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<Plan | null>(null)
  // The plan as generated, kept so a hand-edited plan can be measured against it.
  const [generated, setGenerated] = useState<Plan | null>(null)
  const [sheet, setSheet] = useState<null | 'emergency' | 'sick'>(null)
  const [busy, setBusy] = useState(false)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const phone = useMediaQuery('(max-width: 900px)')
  const debounce = useRef<number | undefined>(undefined)

  const cases = useQuery({ queryKey: ['cases'], queryFn: () => api.listCases() })
  const detail = useQuery({ queryKey: ['case', caseId], queryFn: () => api.getCase(caseId) })

  const log = (e: Omit<PlanEvent, 'id' | 'at'>) =>
    setEvents((prev) => [{ ...e, id: nextId(), at: clock() }, ...prev])

  // The ledger is a read of plan_events in Postgres. The local entries above
  // are the fallback for mock mode, where nothing is persisted.
  const refreshEvents = (planId: string) =>
    api
      .events(planId)
      .then((rows) => {
        if (rows.length)
          setEvents(
            rows.map((r) => ({
              ...r,
              at: new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
            })),
          )
      })
      .catch(() => {})

  const generate = useMutation({
    mutationFn: () => api.generatePlan(caseId),
    onSuccess: (p) => {
      setPlan(p)
      setOffending(new Set())
      setGenerated(p)
      api.baseline(p).then(setBaseline).catch(() => setBaseline(null))
      refreshEvents(p.id)
      log({
        kind: 'plan_generated',
        summary: `${caseId}: ${p.score.assigned} of ${p.score.total_jobs} jobs assigned across ${p.routes.length} technicians.`,
        detail: `${p.score.travel_minutes} travel min · ${p.unassigned.length} unassigned · score ${p.score.score}`,
      })
    },
  })

  // Regenerate whenever the case changes, so the board is never stale-but-plausible.
  useEffect(() => {
    setPlan(null)
    setBaseline(null)
    setGenerated(null)
    setEvents([])
    if (detail.data) generate.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.case_id])

  const jobs = useMemo(
    () => new Map((detail.data?.jobs ?? []).map((j) => [j.id, j])),
    [detail.data],
  )

  // ── Drag: preview the verdict before the drop ──────────────────────────────
  function previewMove(jobId: string, techId: string) {
    if (!plan) return
    window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(async () => {
      const v = await api.validateMove(plan, jobId, techId)
      setVerdictOk(v.ok)
      const tech = detail.data?.technicians.find((t) => t.id === techId)
      setPreview({
        id: 'preview',
        at: '',
        kind: v.ok ? 'move_applied' : 'move_refused',
        summary: v.ok
          ? `${jobId} → ${techId} ${tech?.name} is legal. Travel ${
              (v.travel_delta ?? 0) >= 0 ? '+' : ''
            }${v.travel_delta ?? 0} min.`
          : `${jobId} → ${techId} ${tech?.name} breaks a hard rule.`,
        violations: v.violations,
      })
    }, 120)
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))

  function onDragStart(e: DragStartEvent) {
    setDragJob(String(e.active.id))
    setOffending(new Set())
  }

  function onDragOver(e: DragOverEvent) {
    const tech = e.over ? String(e.over.id) : null
    if (tech === hoverTech) return
    setHoverTech(tech)
    setVerdictOk(null)
    setPreview(null)
    if (tech && dragJob) previewMove(dragJob, tech)
  }

  async function onDragEnd(e: DragEndEvent) {
    const jobId = String(e.active.id)
    const techId = e.over ? String(e.over.id) : null
    setDragJob(null)
    setHoverTech(null)
    setPreview(null)
    setVerdictOk(null)
    window.clearTimeout(debounce.current)
    if (!techId || !plan) return

    const holder = plan.routes.find((r) => r.stops.some((s) => s.job_id === jobId))
    if (holder?.technician_id === techId) return

    const res = await api.move(plan, jobId, techId)
    const tech = detail.data?.technicians.find((t) => t.id === techId)
    if (res.verdict.ok) {
      setPlan(res.plan)
      setOffending(new Set())
      refreshEvents(res.plan.id)
      log({
        kind: 'move_applied',
        summary: `${jobId} moved to ${techId} ${tech?.name}.`,
        detail: `Total travel ${(res.verdict.travel_delta ?? 0) >= 0 ? '+' : ''}${
          res.verdict.travel_delta ?? 0
        } min · now ${res.plan.score.travel_minutes} min`,
      })
    } else {
      setOffending(new Set(res.verdict.violations.map((v: Violation) => v.job_id)))
      refreshEvents(plan.id)
      log({
        kind: 'move_refused',
        summary: `${jobId} cannot go to ${techId} ${tech?.name}. The plan is unchanged.`,
        violations: res.verdict.violations,
      })
    }
  }

  async function runDisruption(kind: 'emergency' | 'sick', body: Record<string, unknown>) {
    if (!plan) return
    setBusy(true)
    try {
      const next =
        kind === 'emergency'
          ? await api.emergency(plan, body)
          : await api.sick(plan, body as { tech_id: string; from_time: string })
      setPlan(next)
      setSheet(null)
      setOffending(new Set())
      refreshEvents(next.id)
    } catch (e) {
      log({
        kind: 'move_refused',
        summary: (e as Error).message,
      })
    } finally {
      setBusy(false)
    }
  }

  const c = detail.data

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-rule bg-paper px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="display text-[34px] leading-none">Dispatch Board</h1>
            <p className="mt-1.5 text-[13px] text-muted">
              Goal: assign as many jobs as possible, then cut total travel.
              {c && (
                <>
                  {' '}
                  ·{' '}
                  <span className="mono">
                    {c.case_id} · {longDate(c.today)}
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="eyebrow" htmlFor="case">
              Case
            </label>
            <select
              id="case"
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
              className="mono border border-rule-strong bg-paper px-2 py-1.5 text-[13px]"
            >
              {(cases.data ?? []).map((s) => (
                <option key={s.case_id} value={s.case_id}>
                  {s.case_id} — {s.technicians} techs, {s.jobs} jobs
                </option>
              ))}
            </select>
            <label className={`eyebrow ${phone ? 'hidden' : ''}`} htmlFor="zoom">
              Zoom
            </label>
            <input
              className={phone ? 'hidden' : 'w-24'}
              id="zoom"
              type="range"
              min={0.8}
              max={3.5}
              step={0.1}
              value={ppm}
              onChange={(e) => setPpm(Number(e.target.value))}
            />
            <button
              onClick={() => setSheet('emergency')}
              disabled={!plan}
              className="border border-rule-strong px-3 py-2 text-[13px] font-medium disabled:opacity-40"
            >
              Emergency job
            </button>
            <button
              onClick={() => setSheet('sick')}
              disabled={!plan}
              className="border border-rule-strong px-3 py-2 text-[13px] font-medium disabled:opacity-40"
            >
              Technician off
            </button>
            <button
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="bg-ink px-3.5 py-2 text-[13px] font-medium text-paper disabled:opacity-50"
            >
              {generate.isPending ? 'Generating…' : 'Generate plan'}
            </button>
          </div>
        </div>
        {plan && plan.case_id === c?.case_id && (
          <div className="mt-4">
            <MetricStrip plan={plan} />
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          {(detail.isError || cases.isError) && (
            <section className="border border-rule bg-paper p-4">
              <h2 className="eyebrow" style={{ color: 'var(--color-flag)' }}>
                Can't reach the planner
              </h2>
              <p className="mt-2 text-[13px] leading-[19px]">
                The board needs <span className="mono">/api/cases</span>, and that request failed.
                The 25 cases ship inside the API, so this is the service being unavailable — not
                missing data.
              </p>
              <p className="mono mt-2 text-[12px] text-muted">
                {(cases.error as Error)?.message ?? (detail.error as Error)?.message}
              </p>
              <p className="mt-2 text-[13px]">
                Check <span className="mono">/api/readyz</span>. Retry once it responds.
              </p>
              <button
                onClick={() => {
                  cases.refetch()
                  detail.refetch()
                }}
                className="mt-3 bg-ink px-3 py-1.5 text-[13px] font-medium text-paper"
              >
                Try again
              </button>
            </section>
          )}
          {!c && !detail.isError && (
            <p className="text-[13px] text-muted">Loading cases…</p>
          )}
          {c && (!plan || plan.case_id !== c.case_id) && !generate.isPending && (
            <p className="text-[13px] text-muted">Pick a case and generate the day plan.</p>
          )}
          {c && generate.isPending && (
            <p className="text-[13px] text-muted">Building the day plan for {c.case_id}…</p>
          )}
          {c && plan && plan.case_id === c.case_id && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragEnd={onDragEnd}
            >
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="eyebrow">Day plan</h2>
                <p className="text-[12px] text-muted">
                  {phone
                    ? 'Each technician in order, with travel and idle between jobs. Press and hold a job to move it.'
                    : 'Solid is service, hatched is travel, bare board is idle. Drag a job onto another technician, or focus one and press Enter.'}
                </p>
              </div>
              {c.technicians.length === 0 && (
                <p className="border border-rule bg-paper p-4 text-[13px]">
                  This case has no technicians on shift, so nothing can be assigned. Every job is
                  listed below with its reason.
                </p>
              )}
              {phone ? (
                <Agenda
                  c={c}
                  plan={plan}
                  hoverTech={hoverTech}
                  verdictOk={verdictOk}
                  offending={offending}
                  onOpenJob={setOpenJob}
                />
              ) : (
                <Board
                  c={c}
                  plan={plan}
                  ppm={ppm}
                  hoverTech={hoverTech}
                  verdictOk={verdictOk}
                  offending={offending}
                  onOpenJob={setOpenJob}
                />
              )}
              <DragOverlay dropAnimation={null}>
                {dragJob && (
                  <div
                    className="mono rounded-[3px] px-2 py-1.5 text-[11px] text-paper"
                    style={{
                      background:
                        verdictOk === false ? 'var(--color-flag)' : 'var(--color-service)',
                    }}
                  >
                    {dragJob}
                  </div>
                )}
              </DragOverlay>
              <div className="mt-5 grid gap-5 lg:grid-cols-3">
                {(() => {
                  const parts = plan.routes.reduce(
                    (a, r) => ({
                      service:
                        a.service + r.stops.reduce((b, s) => b + (jobs.get(s.job_id)?.duration_minutes ?? 0), 0),
                      travel: a.travel + r.travel_minutes,
                      idle: a.idle + r.idle_minutes,
                      capacity: a.capacity,
                    }),
                    {
                      service: 0,
                      travel: 0,
                      idle: 0,
                      capacity: c.technicians.reduce((a2, t) => a2 + (t.shift_end - t.shift_start), 0),
                    },
                  )
                  return <Composition parts={parts} />
                })()}
                <Failures items={plan.unassigned} />
                {baseline && <Gain plan={plan} baseline={baseline} />}
              </div>
              {generated && generated.version !== plan.version && (
                <div className="mt-5">
                  <Compare current={plan} generated={generated} />
                </div>
              )}
              <div className="mt-5">
                <Unassigned items={plan.unassigned} jobs={jobs} />
              </div>
            </DndContext>
          )}
        </main>
        {!phone && <Ledger events={events} preview={preview} />}
      </div>

      {phone && (
        <>
          <button
            onClick={() => setLedgerOpen(true)}
            className="fixed right-4 bottom-4 z-40 bg-ink px-4 py-3 text-[13px] font-medium text-paper shadow-lg"
          >
            Ledger{events.length ? ` · ${events.length}` : ''}
          </button>
          {ledgerOpen && (
            <div
              className="fixed inset-0 z-50 flex justify-end bg-ink/25"
              onClick={() => setLedgerOpen(false)}
            >
              <div className="h-full" onClick={(e) => e.stopPropagation()}>
                <Ledger events={events} preview={preview} />
              </div>
            </div>
          )}
        </>
      )}

      {sheet === 'emergency' && c && plan && (
        <EmergencySheet
          c={c}
          plan={plan}
          busy={busy}
          onClose={() => setSheet(null)}
          onSubmit={(body) => runDisruption('emergency', body)}
        />
      )}
      {sheet === 'sick' && c && plan && (
        <SickSheet
          c={c}
          plan={plan}
          busy={busy}
          onClose={() => setSheet(null)}
          onSubmit={(body) => runDisruption('sick', body)}
        />
      )}

      {openJob && c && plan && jobs.get(openJob) && (
        <JobDrawer job={jobs.get(openJob)!} c={c} plan={plan} onClose={() => setOpenJob(null)} />
      )}
    </div>
  )
}
