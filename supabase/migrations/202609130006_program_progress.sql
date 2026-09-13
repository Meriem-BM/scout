-- Coverage belongs to the normalized program consumer, not to a decoder's old backfill.
create table app_private.program_checkpoints (
  version_id uuid primary key references public.watch_programs(version_id) on delete cascade,
  deployment_id uuid not null references public.pipeline_deployments(id) on delete cascade,
  processed_from timestamptz not null,
  processed_through timestamptz not null,
  block_number numeric(78,0) not null,
  block_hash text not null,
  cursor text not null,
  updated_at timestamptz not null default now(),
  check(processed_through>=processed_from)
);
grant all on app_private.program_checkpoints to service_role;
