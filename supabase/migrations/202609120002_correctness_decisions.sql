-- Final decisions are immutable per candidate revision; pending context is not a failed delivery.
create table public.investigation_decisions (
  incident_id uuid not null references public.incidents(id) on delete cascade,
  revision text not null,
  status text not null check(status in ('PENDING','ALERT','SUPPRESS')),
  evidence jsonb not null,
  attempts integer not null default 1,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(incident_id,revision)
);
alter table public.investigation_decisions enable row level security;
create policy decision_owner on public.investigation_decisions for select to authenticated using(exists(select 1 from public.incidents i where i.id=incident_id and i.user_id=(select auth.uid())));
grant select on public.investigation_decisions to authenticated;
grant all on public.investigation_decisions to service_role;
create index pending_investigations on public.investigation_decisions(next_attempt_at) where status='PENDING';
create function app_private.immutable_investigation_decision() returns trigger language plpgsql as $$
begin
  if old.status<>'PENDING' then raise exception 'Final investigation decisions are immutable'; end if;
  return new;
end $$;
create trigger immutable_investigation_decision before update on public.investigation_decisions for each row execute function app_private.immutable_investigation_decision();

-- A changed interpretation invalidates everything derived from it, including an old plan.
create function app_private.invalidate_intent_dependents() returns trigger language plpgsql as $$
begin
  if old.kind='intent' then
    delete from public.watch_workflow_outputs where workflow_id=old.workflow_id and kind<>'intent';
  end if;
  return old;
end $$;
create trigger invalidate_intent_dependents after delete on public.watch_workflow_outputs for each row when(old.kind='intent') execute function app_private.invalidate_intent_dependents();

create table app_private.substreams_sessions(id uuid primary key,kind text not null check(kind in ('live','verification')),expires_at timestamptz not null);
grant all on app_private.substreams_sessions to service_role;

-- Retain existing versions and permit only the second validated executable contract.
alter table public.watch_versions drop constraint watch_versions_spec_check;
alter table public.watch_versions add constraint watch_versions_spec_check check(
  jsonb_typeof(spec)='object' and spec->>'confirmation'='finalized' and (
    (spec->>'chainId'='1' and spec->>'protocol'='uniswap_v3') or
    (spec->>'chainId'='8453' and spec->>'protocol'='erc20' and spec->>'token'='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' and spec->>'valuation'='nominal_usdc' and spec->>'thresholdMicros' ~ '^[0-9]+$' and spec->>'operator' in ('gt','gte'))
  )
);
create table public.candidate_events(
  deployment_id uuid not null references public.pipeline_deployments(id) on delete cascade,
  event_id text not null,
  watch_id uuid not null references public.watches(id) on delete cascade,
  user_id uuid not null,
  envelope jsonb not null,
  created_at timestamptz not null default now(),
  primary key(deployment_id,event_id)
);
create table public.candidate_detections(
  deployment_id uuid not null,
  event_id text not null,
  rule_version uuid not null references public.watch_versions(id),
  detection jsonb not null,
  created_at timestamptz not null default now(),
  primary key(deployment_id,event_id,rule_version),
  foreign key(deployment_id,event_id) references public.candidate_events(deployment_id,event_id) on delete cascade
);
alter table public.candidate_events enable row level security;
alter table public.candidate_detections enable row level security;
create policy candidate_owner on public.candidate_events for select to authenticated using(user_id=(select auth.uid()));
create policy candidate_detection_owner on public.candidate_detections for select to authenticated using(exists(select 1 from public.candidate_events e where e.deployment_id=candidate_detections.deployment_id and e.event_id=candidate_detections.event_id and e.user_id=(select auth.uid())));
grant select on public.candidate_events,public.candidate_detections to authenticated;
grant all on public.candidate_events,public.candidate_detections to service_role;

create function app_private.fence_workflow_write() returns trigger language plpgsql as $$
declare jid text:=current_setting('scout.job_id',true); attempt text:=current_setting('scout.job_attempt',true);
begin
  if jid is not null and jid<>'' then
    perform 1 from app_private.jobs where id=jid::uuid and attempts=attempt::integer and status='running' and leased_until>clock_timestamp() for share;
    if not found then raise exception 'Stale workflow job cannot commit'; end if;
  end if;
  if TG_OP='DELETE' then return old; else return new; end if;
end $$;
create trigger fence_workflow before insert or update on public.watch_workflows for each row execute function app_private.fence_workflow_write();
create trigger fence_outputs before insert or update or delete on public.watch_workflow_outputs for each row execute function app_private.fence_workflow_write();
create trigger fence_events before insert on public.watch_workflow_events for each row execute function app_private.fence_workflow_write();
create trigger fence_versions before insert or update on public.watch_versions for each row execute function app_private.fence_workflow_write();
create trigger fence_deployments before insert or update on public.pipeline_deployments for each row execute function app_private.fence_workflow_write();

create or replace function app_private.watch_json(w public.watches)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', w.id,
    'name', coalesce(v.spec ->> 'name', w.name),
    'prompt', coalesce(v.prompt, f.original_prompt, ''),
    'spec', case
      when v.spec is null then null
      else jsonb_set(
        v.spec,
        '{notifications}',
        coalesce(
          w.destination_overrides || '{"inbox":true,"useDefaults":false}'::jsonb,
          jsonb_build_object(
            'inbox', true,
            'telegram', coalesce(p.telegram, true),
            'email', coalesce(p.email, false),
            'useDefaults', true
          )
        )
      )
    end,
    'executableSpec', v.spec,
    'intent', (
      select case
        when o.payload ? 'version'
          and o.payload ? 'subject'
          and o.payload ? 'activity'
          and o.payload ? 'temporal'
        then o.payload
        else null
      end
      from public.watch_workflow_outputs o
      where o.workflow_id = f.id
        and o.kind = 'intent'
    ),
    'status', w.status,
    'workflowId', f.id,
    'workflowStage', f.state,
    'workflowUpdatedAt', f.updated_at,
    'version', coalesce(v.version, 0),
    'pendingVersion', (
      select version
      from public.watch_versions
      where id = w.pending_version_id
    ),
    'createdAt', w.created_at,
    'lastBlock', w.last_block::text,
    'lastBlockTime', w.last_block_time,
    'lastMessageAt', (select d.last_message_at from public.pipeline_deployments d where d.version_id=w.active_version_id),
    'error', coalesce(w.error, f.error_message),
    'mutedUntil', w.muted_until,
    'lastEventAt', w.last_event_at
  )
  from (select 1) seed
  left join public.watch_versions v
    on v.id = coalesce(w.active_version_id, w.pending_version_id)
  left join public.account_preferences p
    on p.user_id = w.user_id
  left join public.watch_workflows f
    on f.watch_id = w.id;
$$;
