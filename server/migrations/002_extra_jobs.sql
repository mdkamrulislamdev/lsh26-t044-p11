-- Emergency jobs are created at runtime and belong to a single plan. Without
-- them the case is incomplete on reload and any later operation on that job
-- fails with "not in this case".
alter table plans add column if not exists extra_jobs jsonb not null default '[]'::jsonb;
