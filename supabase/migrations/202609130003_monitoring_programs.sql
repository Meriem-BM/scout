-- Additive migration: original Watch versions, incidents and cursors remain intact.
alter table public.watch_workflow_outputs drop constraint watch_workflow_outputs_kind_check;
alter table public.watch_workflow_outputs add constraint watch_workflow_outputs_kind_check
  check(kind in ('intent','data_requirements','package_resolution','pipeline_plan','verification','watch_program','capability_plan','acceptance_report'));

create table public.watch_programs (
  version_id uuid primary key references public.watch_versions(id) on delete cascade,
  watch_id uuid not null,
  user_id uuid not null,
  language_version integer not null check(language_version=1),
  chain_id bigint not null check(chain_id>0),
  event_type text not null,
  program jsonb not null check(jsonb_typeof(program)='object' and program->>'version'='1'),
  program_hash text generated always as (md5(program::text)) stored,
  created_at timestamptz not null default now(),
  foreign key(watch_id,user_id) references public.watches(id,user_id) on delete cascade
);
create function app_private.immutable_monitoring_record() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Monitoring evidence is immutable; create a new version'; end $$;
create trigger immutable_program before update on public.watch_programs for each row execute function app_private.immutable_monitoring_record();
create trigger fence_program before insert or delete on public.watch_programs for each row execute function app_private.fence_workflow_write();

-- Canonical chain evidence is separate from the package that observed it.
create table app_private.normalized_events (
  id text primary key,
  chain_id bigint not null check(chain_id>0),
  block_number numeric(78,0) not null check(block_number>=0),
  block_hash text not null,
  block_time timestamptz not null,
  transaction_hash text not null,
  transaction_index integer check(transaction_index>=0),
  event_index integer not null check(event_index>=0),
  actor text, subject text, contract text not null, protocol text, event_type text not null,
  attributes jsonb not null check(jsonb_typeof(attributes)='object'),
  unique(chain_id,block_hash,transaction_hash,event_index)
);
create table app_private.normalized_assets (
  event_id text not null references app_private.normalized_events(id) on delete cascade,
  asset text not null, direction text check(direction in ('buy','sell','transfer')),
  raw_amount numeric(78,0) not null check(raw_amount>=0),
  decimals integer not null check(decimals between 0 and 36),
  valuation jsonb,
  primary key(event_id,asset)
);
create table app_private.program_events (
  version_id uuid not null references public.watch_programs(version_id) on delete cascade,
  event_id text not null references app_private.normalized_events(id),
  deployment_id uuid not null references public.pipeline_deployments(id) on delete cascade,
  package text not null, module text not null, decoder text not null, pipeline_version text not null,
  primary key(version_id,event_id)
);
create index program_events_deployment on app_private.program_events(deployment_id);
create index normalized_events_window on app_private.normalized_events(block_time);

create table public.watch_findings (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.watch_programs(version_id),
  watch_id uuid not null, user_id uuid not null,
  deployment_id uuid not null references public.pipeline_deployments(id),
  anchor_event_id text not null references app_private.normalized_events(id),
  primary_subject text, actor_set text[] not null,
  window_from timestamptz not null, window_through timestamptz not null,
  evaluation jsonb not null,
  status text not null check(status in ('MATCH','PENDING_CONTEXT','SUPPRESSED')),
  created_at timestamptz not null default now(),
  unique(version_id,anchor_event_id),
  foreign key(watch_id,user_id) references public.watches(id,user_id) on delete cascade
);
create table public.finding_events (
  finding_id uuid not null references public.watch_findings(id) on delete cascade,
  event_id text not null references app_private.normalized_events(id),
  primary key(finding_id,event_id)
);
create trigger immutable_finding before update on public.watch_findings for each row execute function app_private.immutable_monitoring_record();

alter table public.watch_programs enable row level security;
alter table public.watch_findings enable row level security;
alter table public.finding_events enable row level security;
create policy own_programs on public.watch_programs for select using(user_id=auth.uid());
create policy own_findings on public.watch_findings for select using(user_id=auth.uid());
create policy own_finding_events on public.finding_events for select using(exists(select 1 from public.watch_findings f where f.id=finding_id and f.user_id=auth.uid()));
revoke all on public.watch_programs,public.watch_findings,public.finding_events from anon,authenticated;
grant select on public.watch_programs,public.watch_findings,public.finding_events to authenticated;
grant all on public.watch_programs,public.watch_findings,public.finding_events to service_role;
grant all on app_private.normalized_events,app_private.normalized_assets,app_private.program_events to service_role;
