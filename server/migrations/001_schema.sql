-- Forward-only. Run under an advisory lock so concurrent boots cannot race.

create table if not exists plans (
  id             text primary key,
  case_id        text not null,
  version        integer not null default 1,
  source         text not null check (source in ('generated','baseline','manual','emergency','sick')),
  solver_version text not null,
  score          jsonb not null,
  routes         jsonb not null,
  unassigned     jsonb not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists plans_case_idx on plans (case_id, created_at desc);

-- Append-only audit trail. Backs the Rule Ledger in the UI.
create table if not exists plan_events (
  id         bigserial primary key,
  plan_id    text not null,
  at         timestamptz not null default now(),
  kind       text not null,
  summary    text not null,
  detail     text,
  violations jsonb not null default '[]'::jsonb
);

create index if not exists plan_events_plan_idx on plan_events (plan_id, at desc, id desc);
