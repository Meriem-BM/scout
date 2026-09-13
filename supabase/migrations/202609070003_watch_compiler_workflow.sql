-- Durable Watch compiler workflow. A Watch exists before its first executable version.
alter table public.watches drop constraint watches_status_check;
alter table public.watches add constraint watches_status_check check(status in (
  'draft','preparing','checking','starting','backfilling','watching','delayed','paused','failed','archived',
  'received','intent_resolving','needs_clarification','intent_ready','data_planning','package_discovery',
  'package_evaluation','pipeline_planning','plan_validation','code_generating','building','build_repairing',
  'testing','semantic_verifying','verification_repairing','packaging','deploying','deployment_verifying',
  'catching_up','live','degraded'
));

create table public.watch_workflows (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null unique,
  user_id uuid not null,
  original_prompt text not null check(length(original_prompt) between 1 and 2000),
  state text not null default 'RECEIVED' check(state in (
    'RECEIVED','INTENT_RESOLVING','NEEDS_CLARIFICATION','INTENT_READY','DATA_PLANNING',
    'PACKAGE_DISCOVERY','PACKAGE_EVALUATION','PIPELINE_PLANNING','PLAN_VALIDATION','CODE_GENERATING',
    'BUILDING','BUILD_REPAIRING','TESTING','SEMANTIC_VERIFYING','VERIFICATION_REPAIRING',
    'PACKAGING','DEPLOYING','DEPLOYMENT_VERIFYING','CATCHING_UP','LIVE','FAILED'
  )),
  run_number integer not null default 1 check(run_number > 0),
  error_category text check(error_category in ('INTENT','PACKAGE_DISCOVERY','PLAN','GENERATION','BUILD','VERIFICATION','DEPLOYMENT','STREAM','INVESTIGATION','DELIVERY')),
  error_code text,
  error_message text,
  recoverable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(watch_id,user_id) references public.watches(id,user_id) on delete cascade
);
create index watch_workflows_owner on public.watch_workflows(user_id,updated_at desc);

create table public.watch_workflow_events (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.watch_workflows(id) on delete cascade,
  watch_id uuid not null,
  user_id uuid not null,
  sequence integer not null check(sequence > 0),
  stage text not null,
  type text not null check(length(type) between 1 and 80),
  status text not null check(status in ('pending','active','complete','warning','failed')),
  title text not null check(length(title) between 1 and 160),
  summary text check(length(summary) <= 1000),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(workflow_id,sequence),
  foreign key(watch_id,user_id) references public.watches(id,user_id) on delete cascade
);
create index watch_workflow_events_stream on public.watch_workflow_events(workflow_id,sequence);

create table public.watch_clarifications (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.watch_workflows(id) on delete cascade,
  watch_id uuid not null,
  user_id uuid not null,
  field text not null check(length(field) between 1 and 80),
  reason text not null check(length(reason) between 1 and 500),
  question text not null check(length(question) between 1 and 500),
  choices jsonb not null check(jsonb_typeof(choices)='array' and jsonb_array_length(choices) between 1 and 8),
  allow_custom boolean not null default false,
  status text not null default 'open' check(status in ('open','answered','cancelled')),
  answer text check(length(answer) <= 500),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  foreign key(watch_id,user_id) references public.watches(id,user_id) on delete cascade
);
create unique index watch_clarification_one_open_field on public.watch_clarifications(workflow_id,field) where status='open';

create table public.watch_workflow_outputs (
  workflow_id uuid not null references public.watch_workflows(id) on delete cascade,
  kind text not null check(kind in ('intent','data_requirements','package_resolution','pipeline_plan','verification')),
  schema_version integer not null default 1,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(workflow_id,kind)
);

create table public.pipeline_build_attempts (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.watch_workflows(id) on delete cascade,
  deployment_id uuid references public.pipeline_deployments(id) on delete cascade,
  attempt integer not null check(attempt between 1 and 4),
  status text not null check(status in ('running','passed','failed')),
  error_code text,
  diagnostics jsonb not null default '{}',
  log_path text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(workflow_id,attempt)
);

alter table public.pipeline_deployments add column workflow_id uuid unique references public.watch_workflows(id) on delete set null;

alter table public.watch_workflows enable row level security;
alter table public.watch_workflow_events enable row level security;
alter table public.watch_clarifications enable row level security;
alter table public.watch_workflow_outputs enable row level security;
alter table public.pipeline_build_attempts enable row level security;
create policy watch_workflows_owner on public.watch_workflows for select to authenticated using(user_id=(select auth.uid()));
create policy watch_workflow_events_owner on public.watch_workflow_events for select to authenticated using(user_id=(select auth.uid()));
create policy watch_clarifications_owner on public.watch_clarifications for select to authenticated using(user_id=(select auth.uid()));
create policy watch_workflow_outputs_owner on public.watch_workflow_outputs for select to authenticated using(exists(select 1 from public.watch_workflows w where w.id=workflow_id and w.user_id=(select auth.uid())));
create policy pipeline_build_attempts_owner on public.pipeline_build_attempts for select to authenticated using(exists(select 1 from public.watch_workflows w where w.id=workflow_id and w.user_id=(select auth.uid())));
revoke insert,update,delete on public.watch_workflows,public.watch_workflow_events,public.watch_clarifications,public.watch_workflow_outputs,public.pipeline_build_attempts from anon,authenticated;
grant select on public.watch_workflows,public.watch_workflow_events,public.watch_clarifications,public.watch_workflow_outputs,public.pipeline_build_attempts to authenticated;
grant all on public.watch_workflows,public.watch_workflow_events,public.watch_clarifications,public.watch_workflow_outputs,public.pipeline_build_attempts to service_role;

alter table app_private.jobs drop constraint jobs_kind_check;
alter table app_private.jobs add constraint jobs_kind_check check(kind in ('workflow','build','enrich','notify','reconcile','test_alert','email'));

create function app_private.append_workflow_event(
  workflow uuid, next_stage text, event_type text, event_status text,
  event_title text, event_summary text default null, event_metadata jsonb default '{}'
) returns integer language plpgsql security definer set search_path='' as $$
declare flow public.watch_workflows; next_sequence integer; watch_status text;
begin
  select * into flow from public.watch_workflows where id=workflow for update;
  if flow.id is null then raise exception 'Workflow not found'; end if;
  if next_stage not in ('RECEIVED','INTENT_RESOLVING','NEEDS_CLARIFICATION','INTENT_READY','DATA_PLANNING','PACKAGE_DISCOVERY','PACKAGE_EVALUATION','PIPELINE_PLANNING','PLAN_VALIDATION','CODE_GENERATING','BUILDING','BUILD_REPAIRING','TESTING','SEMANTIC_VERIFYING','VERIFICATION_REPAIRING','PACKAGING','DEPLOYING','DEPLOYMENT_VERIFYING','CATCHING_UP','LIVE','FAILED') then raise exception 'Invalid workflow stage'; end if;
  select coalesce(max(sequence),0)+1 into next_sequence from public.watch_workflow_events where workflow_id=workflow;
  insert into public.watch_workflow_events(workflow_id,watch_id,user_id,sequence,stage,type,status,title,summary,metadata)
  values(flow.id,flow.watch_id,flow.user_id,next_sequence,next_stage,event_type,event_status,event_title,event_summary,coalesce(event_metadata,'{}'));
  update public.watch_workflows set state=next_stage,updated_at=now() where id=flow.id;
  watch_status:=lower(next_stage);
  update public.watches set status=watch_status,updated_at=now() where id=flow.watch_id and desired_state<>'archived';
  return next_sequence;
end $$;

create function app_private.put_workflow_output(workflow uuid, output_kind text, output_payload jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  if output_kind not in ('intent','data_requirements','package_resolution','pipeline_plan','verification') then raise exception 'Invalid workflow output'; end if;
  insert into public.watch_workflow_outputs(workflow_id,kind,payload) values(workflow,output_kind,output_payload)
  on conflict(workflow_id,kind) do update set payload=excluded.payload,schema_version=public.watch_workflow_outputs.schema_version+1,updated_at=now();
end $$;

create function public.scout_create_watch(original_prompt text) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); wid uuid; flow_id uuid; generated_name text;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if length(trim(original_prompt)) not between 1 and 2000 then raise exception 'Describe what Scout should watch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if (select count(*) from public.watches where user_id=uid and desired_state<>'archived')>=5 then raise exception 'Five-watch limit reached'; end if;
  generated_name:=left(regexp_replace(trim(original_prompt),'[[:space:]]+',' ','g'),72);
  insert into public.watches(user_id,name,status,desired_state) values(uid,generated_name,'received','running') returning id into wid;
  insert into public.watch_workflows(watch_id,user_id,original_prompt) values(wid,uid,trim(original_prompt)) returning id into flow_id;
  perform app_private.append_workflow_event(flow_id,'RECEIVED','watch.received','complete','Request received','Scout saved the request and queued intent resolution.',jsonb_build_object('promptLength',length(trim(original_prompt))));
  perform app_private.enqueue('workflow',jsonb_build_object('workflowId',flow_id),'workflow:'||flow_id||':1');
  return wid;
end $$;

create function public.scout_answer_clarification(target_watch_id uuid, target_clarification_id uuid, answer_value text) returns void
language plpgsql security definer set search_path='' as $$
declare clarification public.watch_clarifications; flow public.watch_workflows;
begin
  if length(trim(answer_value)) not between 1 and 500 then raise exception 'Choose or enter an answer'; end if;
  select c.* into clarification from public.watch_clarifications c where c.id=target_clarification_id and c.watch_id=target_watch_id and c.user_id=auth.uid() and c.status='open' for update;
  if clarification.id is null then raise exception 'Clarification is no longer available'; end if;
  select * into flow from public.watch_workflows where id=clarification.workflow_id for update;
  if flow.state<>'NEEDS_CLARIFICATION' then raise exception 'Workflow is not waiting for input'; end if;
  update public.watch_clarifications set status='answered',answer=trim(answer_value),answered_at=now() where id=clarification.id;
  delete from public.watch_workflow_outputs where workflow_id=flow.id and kind='intent';
  update public.watch_workflows set run_number=run_number+1,error_category=null,error_code=null,error_message=null,recoverable=false where id=flow.id;
  perform app_private.append_workflow_event(flow.id,'INTENT_RESOLVING','clarification.answered','complete','Answer received','Scout is resolving the request with this detail.',jsonb_build_object('field',clarification.field,'answer',trim(answer_value)));
  perform app_private.enqueue('workflow',jsonb_build_object('workflowId',flow.id),'workflow:'||flow.id||':'||(flow.run_number+1));
end $$;

create function public.scout_retry_workflow(target_watch_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare flow public.watch_workflows;
begin
  select f.* into flow from public.watch_workflows f where f.watch_id=target_watch_id and f.user_id=auth.uid() for update;
  if flow.id is null or flow.state<>'FAILED' or not flow.recoverable then raise exception 'This workflow cannot be retried without changing its request'; end if;
  update public.watch_workflows set run_number=run_number+1,error_category=null,error_code=null,error_message=null,recoverable=false where id=flow.id;
  update public.watches set error=null where id=flow.watch_id;
  perform app_private.append_workflow_event(flow.id,'INTENT_RESOLVING','workflow.retry','active','Retrying workflow','Scout will reuse persisted successful outputs where they remain valid.','{}');
  perform app_private.enqueue('workflow',jsonb_build_object('workflowId',flow.id),'workflow:'||flow.id||':'||(flow.run_number+1));
end $$;

create function public.scout_duplicate_watch(source_watch_id uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); source_watch public.watches; source_version public.watch_versions; wid uuid; vid uuid;
begin
  select * into source_watch from public.watches where id=source_watch_id and user_id=uid;
  if source_watch.id is null then raise exception 'Watch not found'; end if;
  select * into source_version from public.watch_versions where id=coalesce(source_watch.active_version_id,source_watch.pending_version_id);
  if source_version.id is null then raise exception 'This Watch has no completed definition to duplicate'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if (select count(*) from public.watches where user_id=uid and desired_state<>'archived')>=5 then raise exception 'Five-watch limit reached'; end if;
  insert into public.watches(user_id,name,status,desired_state,destination_overrides)
    values(uid,left((source_version.spec->>'name')||' copy',72),'draft','paused',source_watch.destination_overrides) returning id into wid;
  insert into public.watch_versions(watch_id,user_id,version,prompt,spec)
    values(wid,uid,1,source_version.prompt,jsonb_set(source_version.spec,'{name}',to_jsonb(left((source_version.spec->>'name')||' copy',72)))) returning id into vid;
  update public.watches set pending_version_id=vid where id=wid;
  return wid;
end $$;

create function app_private.workflow_json(flow public.watch_workflows, after_sequence integer default 0) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object(
  'id',flow.id,'watchId',flow.watch_id,'state',flow.state,'originalPrompt',flow.original_prompt,
  'errorCategory',flow.error_category,'errorCode',flow.error_code,'errorMessage',flow.error_message,'recoverable',flow.recoverable,
  'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'sequence',e.sequence,'stage',e.stage,'type',e.type,'status',e.status,'title',e.title,'summary',e.summary,'metadata',e.metadata,'createdAt',e.created_at) order by e.sequence) from public.watch_workflow_events e where e.workflow_id=flow.id and e.sequence>after_sequence),'[]'::jsonb),
  'clarification',(select jsonb_build_object('id',c.id,'field',c.field,'reason',c.reason,'question',c.question,'choices',c.choices,'allowCustom',c.allow_custom,'status',c.status,'answer',c.answer,'createdAt',c.created_at) from public.watch_clarifications c where c.workflow_id=flow.id and c.status='open' order by c.created_at desc limit 1),
  'outputs',jsonb_build_object(
    'intent',(select payload from public.watch_workflow_outputs where workflow_id=flow.id and kind='intent'),
    'dataRequirements',(select payload from public.watch_workflow_outputs where workflow_id=flow.id and kind='data_requirements'),
    'packageResolution',(select payload from public.watch_workflow_outputs where workflow_id=flow.id and kind='package_resolution'),
    'pipelinePlan',(select payload from public.watch_workflow_outputs where workflow_id=flow.id and kind='pipeline_plan'),
    'verification',(select payload from public.watch_workflow_outputs where workflow_id=flow.id and kind='verification')
  ),
  'updatedAt',flow.updated_at
)
$$;

create function public.scout_watch_workflow(target_watch_id uuid, after_sequence integer default 0) returns jsonb language sql security definer set search_path='' as $$
  select app_private.workflow_json(f,greatest(after_sequence,0)) from public.watch_workflows f where f.watch_id=target_watch_id and f.user_id=auth.uid();
$$;

create or replace function app_private.watch_json(w public.watches) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
 'id',w.id,'name',coalesce(v.spec->>'name',w.name),'prompt',coalesce(v.prompt,f.original_prompt,''),
 'spec',case when v.spec is null then null else jsonb_set(v.spec,'{notifications}',coalesce(w.destination_overrides || '{"inbox":true,"useDefaults":false}'::jsonb,jsonb_build_object('inbox',true,'telegram',coalesce(p.telegram,true),'email',coalesce(p.email,false),'useDefaults',true))) end,
 'status',w.status,'workflowId',f.id,'workflowStage',f.state,'workflowUpdatedAt',f.updated_at,
 'version',coalesce(v.version,0),'pendingVersion',(select version from public.watch_versions where id=w.pending_version_id),
 'createdAt',w.created_at,'lastBlock',w.last_block::text,'lastBlockTime',w.last_block_time,'error',coalesce(w.error,f.error_message),'mutedUntil',w.muted_until,'lastEventAt',w.last_event_at)
 from (select 1) seed
 left join public.watch_versions v on v.id=coalesce(w.active_version_id,w.pending_version_id)
 left join public.account_preferences p on p.user_id=w.user_id
 left join public.watch_workflows f on f.watch_id=w.id;
$$;

create or replace function public.scout_watches_page(page_offset integer default 0, search_text text default '', status_filter text default 'all', sort_order text default 'newest') returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(value),'[]'::jsonb) from (
  select app_private.watch_json(w) || jsonb_build_object('recentIncidents',coalesce((select jsonb_agg(app_private.incident_json(i) || '{"context":null,"explanation":null}'::jsonb order by i.created_at desc,i.id) from (select * from public.incidents where watch_id=w.id and user_id=auth.uid() order by created_at desc,id limit 6) i),'[]'::jsonb)) value
  from public.watches w
  where w.user_id=auth.uid()
    and (search_text='' or w.name ilike '%'||replace(replace(search_text,'%','\%'),'_','\_')||'%' escape '\')
    and (status_filter='all' or w.status=status_filter)
  order by case when sort_order='name' then lower(w.name) end, case when sort_order='oldest' then w.created_at end, case when sort_order not in ('name','oldest') then w.created_at end desc
  offset greatest(page_offset,0) limit 21
 ) q;
$$;

-- Privy tokens are verified by the web tier. This wrapper resolves the stable Scout account,
-- sets transaction-local auth claims, and exposes only workflow operations.
create function public.scout_workflow_account_rpc(privy_subject text,privy_session text,operation text,args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid; result jsonb;
begin
 uid:=app_private.privy_account(privy_subject,privy_session);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
 perform set_config('request.jwt.claim.sub',uid::text,true);
 case operation
  when 'create' then result:=to_jsonb(public.scout_create_watch(args->>'original_prompt'));
  when 'read' then result:=public.scout_watch_workflow((args->>'watch_id')::uuid,coalesce((args->>'after_sequence')::int,0));
  when 'answer' then perform public.scout_answer_clarification((args->>'watch_id')::uuid,(args->>'clarification_id')::uuid,args->>'answer');
  when 'retry' then perform public.scout_retry_workflow((args->>'watch_id')::uuid);
  when 'duplicate' then result:=to_jsonb(public.scout_duplicate_watch((args->>'watch_id')::uuid));
  else raise exception 'Operation not allowed';
 end case;
 return result;
end $$;

revoke all on function public.scout_create_watch(text),public.scout_answer_clarification(uuid,uuid,text),public.scout_retry_workflow(uuid),public.scout_duplicate_watch(uuid),public.scout_watch_workflow(uuid,integer),public.scout_workflow_account_rpc(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.scout_workflow_account_rpc(text,text,text,jsonb) to service_role;
grant all on function app_private.append_workflow_event(uuid,text,text,text,text,text,jsonb),app_private.put_workflow_output(uuid,text,jsonb),app_private.workflow_json(public.watch_workflows,integer) to service_role;
