import { useState } from 'react'
import type { CaseDetail, Plan } from '../api/types'
import { hhmm } from '../lib/time'

/* ── Disruptions ───────────────────────────────────────────────────────────
   The two things that actually happen to a dispatcher's morning: a job comes
   in hot, and someone doesn't make it in. Both replan only what hasn't started
   yet, through the same rule engine, so anything that can't be rehomed lands in
   Unassigned with its reason rather than disappearing.
   ────────────────────────────────────────────────────────────────────────── */

const field =
  'mono w-full border border-rule-strong bg-paper px-2 py-1.5 text-[13px] focus:outline-none'
const label = 'eyebrow block mb-1'

function Sheet({
  title,
  blurb,
  onClose,
  children,
}: {
  title: string
  blurb: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/25" onClick={onClose}>
      <div
        className="flex w-[380px] max-w-full flex-col overflow-y-auto bg-paper"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-rule px-5 py-4">
          <div>
            <h2 className="display text-[20px] leading-tight">{title}</h2>
            <p className="mt-1 text-[12px] leading-[16px] text-muted">{blurb}</p>
          </div>
          <button onClick={onClose} className="text-[13px] underline underline-offset-2">
            Close
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

export function EmergencySheet({
  c,
  plan,
  busy,
  onClose,
  onSubmit,
}: {
  c: CaseDetail
  plan: Plan
  busy: boolean
  onClose: () => void
  onSubmit: (body: Record<string, unknown>) => void
}) {
  const skills = [...new Set(c.technicians.flatMap((t) => t.skills))].sort()
  const [form, setForm] = useState({
    id: `E${plan.routes.length}${c.jobs.length + 1}`,
    area: c.areas[0],
    skill: skills[0] ?? 'ac',
    duration_minutes: 60,
    window_start: '14:00',
    window_end: '17:00',
    from_time: '13:00',
  })
  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }))

  const windowTooShort =
    Number(form.window_end.slice(0, 2)) * 60 +
      Number(form.window_end.slice(3)) -
      (Number(form.window_start.slice(0, 2)) * 60 + Number(form.window_start.slice(3))) <
    form.duration_minutes

  return (
    <Sheet
      title="Add an emergency job"
      blurb="Jobs already under way stay put. Everything not yet started is replanned around it."
      onClose={onClose}
    >
      <div className="space-y-3">
        <div>
          <label className={label} htmlFor="e-id">
            Job reference
          </label>
          <input id="e-id" className={field} value={form.id} onChange={(e) => set('id', e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="e-area">
              Area
            </label>
            <select id="e-area" className={field} value={form.area} onChange={(e) => set('area', e.target.value)}>
              {c.areas.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="e-skill">
              Skill needed
            </label>
            <select id="e-skill" className={field} value={form.skill} onChange={(e) => set('skill', e.target.value)}>
              {skills.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={label} htmlFor="e-dur">
              Minutes
            </label>
            <input
              id="e-dur"
              type="number"
              min={15}
              step={15}
              className={field}
              value={form.duration_minutes}
              onChange={(e) => set('duration_minutes', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={label} htmlFor="e-ws">
              Window from
            </label>
            <input id="e-ws" type="time" className={field} value={form.window_start} onChange={(e) => set('window_start', e.target.value)} />
          </div>
          <div>
            <label className={label} htmlFor="e-we">
              Window to
            </label>
            <input id="e-we" type="time" className={field} value={form.window_end} onChange={(e) => set('window_end', e.target.value)} />
          </div>
        </div>

        <div>
          <label className={label} htmlFor="e-from">
            Replan from
          </label>
          <input id="e-from" type="time" className={field} value={form.from_time} onChange={(e) => set('from_time', e.target.value)} />
          <p className="mt-1 text-[12px] text-muted">
            Anything starting before this is treated as already under way.
          </p>
        </div>

        {windowTooShort && (
          <p className="text-[12px]" style={{ color: 'var(--color-flag)' }}>
            The window is shorter than the job takes. It will be added and reported as
            WINDOW_TOO_SHORT — never silently dropped.
          </p>
        )}

        <button
          disabled={busy || !form.id.trim()}
          onClick={() => onSubmit(form)}
          className="w-full bg-ink px-3.5 py-2 text-[13px] font-medium text-paper disabled:opacity-50"
        >
          {busy ? 'Replanning…' : 'Add job and replan'}
        </button>
      </div>
    </Sheet>
  )
}

export function SickSheet({
  c,
  plan,
  busy,
  onClose,
  onSubmit,
}: {
  c: CaseDetail
  plan: Plan
  busy: boolean
  onClose: () => void
  onSubmit: (body: { tech_id: string; from_time: string }) => void
}) {
  const [techId, setTechId] = useState(c.technicians[0]?.id ?? '')
  const [from, setFrom] = useState('12:00')

  const tech = c.technicians.find((t) => t.id === techId)
  const route = plan.routes.find((r) => r.technician_id === techId)
  const fromMin = Number(from.slice(0, 2)) * 60 + Number(from.slice(3))
  const remaining = (route?.stops ?? []).filter((s) => s.start >= fromMin)
  const kept = (route?.stops ?? []).length - remaining.length

  return (
    <Sheet
      title="Mark a technician off"
      blurb="Work they have already started stays on their row. The rest is redistributed."
      onClose={onClose}
    >
      <div className="space-y-3">
        <div>
          <label className={label} htmlFor="s-tech">
            Technician
          </label>
          <select id="s-tech" className={field} value={techId} onChange={(e) => setTechId(e.target.value)}>
            {c.technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} — {t.name} ({t.skills.join(', ')})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="s-from">
            Off from
          </label>
          <input id="s-from" type="time" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>

        <div className="border border-rule p-3">
          <p className="eyebrow">What this moves</p>
          <p className="mt-1.5 text-[13px] leading-[18px]">
            {tech?.name} keeps <span className="mono">{kept}</span>{' '}
            {kept === 1 ? 'job' : 'jobs'} already under way.{' '}
            <span className="mono">{remaining.length}</span>{' '}
            {remaining.length === 1 ? 'job needs' : 'jobs need'} a new technician.
          </p>
          {remaining.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {remaining.map((s) => (
                <li key={s.job_id} className="mono text-[12px] text-muted">
                  {s.job_id} · {hhmm(s.start)}–{hhmm(s.end)}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[12px] text-muted">
            Anything that cannot be rehomed moves to Unassigned with the rule that blocked it.
          </p>
        </div>

        <button
          disabled={busy || !techId}
          onClick={() => onSubmit({ tech_id: techId, from_time: from })}
          className="w-full bg-ink px-3.5 py-2 text-[13px] font-medium text-paper disabled:opacity-50"
        >
          {busy ? 'Redistributing…' : `Mark ${tech?.name ?? ''} off and replan`}
        </button>
      </div>
    </Sheet>
  )
}
