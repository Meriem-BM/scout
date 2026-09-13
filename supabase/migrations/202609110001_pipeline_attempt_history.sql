-- Provider and environment failures remain auditable without consuming the
-- separately enforced four-attempt build and semantic-repair budget.
alter table public.pipeline_build_attempts
  drop constraint if exists pipeline_build_attempts_attempt_check;

alter table public.pipeline_build_attempts
  add constraint pipeline_build_attempts_attempt_check
  check (attempt between 1 and 1000);
