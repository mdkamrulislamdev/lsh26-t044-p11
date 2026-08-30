import type { PlanEvent } from '../api/types'

/* ── The Rule Ledger ───────────────────────────────────────────────────────
   Append-only, newest first. Nothing happens on this board without a written
   reason — including a move that was refused. During a drag the top entry is a
   live preview of the verdict you would get on drop, in the same wording. */

const KIND_LABEL: Record<PlanEvent['kind'], string> = {
  plan_generated: 'Plan generated',
  move_applied: 'Job moved',
  move_refused: 'Move refused',
  emergency_added: 'Emergency added',
  tech_sick: 'Technician off',
  data_warning: 'Data warning',
}

function Entry({ e, preview }: { e: PlanEvent; preview?: boolean }) {
  const bad = e.kind === 'move_refused'
  return (
    <li
      className={`border-b border-rule px-4 py-3 ${preview ? 'bg-smog' : ''}`}
      style={bad ? { borderLeft: '2px solid var(--color-flag)' } : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="eyebrow" style={bad ? { color: 'var(--color-flag)' } : undefined}>
          {preview ? 'On drop · ' : ''}
          {KIND_LABEL[e.kind]}
        </span>
        {!preview && <span className="mono text-[11px] text-muted">{e.at}</span>}
      </div>
      <p className="mt-1 text-[13px] leading-[18px]">{e.summary}</p>
      {e.violations?.map((v, i) => (
        <p key={i} className="mt-1.5 text-[12px] leading-[17px]">
          <span className="mono text-[11px]" style={{ color: 'var(--color-flag)' }}>
            {v.code}
          </span>
          <span className="text-muted"> — {v.message}</span>
        </p>
      ))}
      {e.detail && <p className="mt-1 text-[12px] text-muted">{e.detail}</p>}
    </li>
  )
}

export function Ledger({ events, preview }: { events: PlanEvent[]; preview: PlanEvent | null }) {
  return (
    <aside className="flex h-full min-h-0 w-[300px] max-w-[85vw] shrink-0 flex-col border-l border-rule bg-paper">
      <header className="border-b border-rule px-4 py-3">
        <h2 className="eyebrow">Rule ledger</h2>
        <p className="mt-1 text-[12px] leading-[16px] text-muted">
          Every decision, and the rule behind it.
        </p>
      </header>
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {preview && <Entry e={preview} preview />}
        {events.length === 0 && !preview && (
          <li className="px-4 py-6 text-[13px] text-muted">
            Nothing has happened yet. Generate a plan to start the log.
          </li>
        )}
        {events.map((e) => (
          <Entry key={e.id} e={e} />
        ))}
      </ul>
    </aside>
  )
}
