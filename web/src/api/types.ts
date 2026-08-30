/** Wire types. These mirror the Go DTOs in internal/api — keep them in step. */

export type Minutes = number // minutes since midnight; "09:30" === 570

export interface Technician {
  id: string
  name: string
  skills: string[]
  shift_start: Minutes
  shift_end: Minutes
  home_area: string
}

export interface Job {
  id: string
  area: string
  skill: string
  duration_minutes: Minutes
  window_start: Minutes
  window_end: Minutes
}

export interface CaseSummary {
  case_id: string
  today: string
  technicians: number
  jobs: number
  areas: number
}

export interface CaseDetail {
  case_id: string
  today: string
  areas: string[]
  travel_minutes: Record<string, Record<string, Minutes>>
  technicians: Technician[]
  jobs: Job[]
  manual_move: { job_id: string; to_technician: string }
}

export type RuleCode =
  | 'SKILL_MISMATCH'
  | 'SHIFT_START_BEFORE'
  | 'SHIFT_END_OVERRUN'
  | 'WINDOW_LATE'
  | 'WINDOW_TOO_SHORT'
  | 'WINDOW_INVALID'
  | 'OVERLAP'
  | 'UNKNOWN_AREA'
  | 'NO_TECHNICIANS'
  | 'NO_CAPACITY'
  | 'ALREADY_STARTED'
  | 'INVALID_SHIFT'

export interface Violation {
  code: RuleCode
  job_id: string
  tech_id: string
  message: string
  detail?: Record<string, unknown>
}

export interface Stop {
  job_id: string
  depart: Minutes
  arrive: Minutes
  start: Minutes
  end: Minutes
  travel_in: Minutes
}

export interface Route {
  technician_id: string
  stops: Stop[]
  travel_minutes: Minutes
  idle_minutes: Minutes
}

export interface Rejection {
  job_id: string
  code: RuleCode
  message: string
}

export interface Score {
  assigned: number
  total_jobs: number
  travel_minutes: number
  idle_minutes: number
  min_slack_minutes: number
  coverage_pct: number
  score: number
}

export interface Plan {
  id: string
  case_id: string
  version: number
  routes: Route[]
  unassigned: Rejection[]
  score: Score
  partial?: boolean
}

export type EventKind =
  | 'plan_generated'
  | 'move_applied'
  | 'move_refused'
  | 'emergency_added'
  | 'tech_sick'
  | 'data_warning'

export interface PlanEvent {
  id: string
  at: string
  kind: EventKind
  summary: string
  detail?: string
  violations?: Violation[]
}

export interface MoveVerdict {
  ok: boolean
  violations: Violation[]
  travel_delta?: number
}
