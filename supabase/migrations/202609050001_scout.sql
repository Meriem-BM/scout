create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to service_role;

create table public.watches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 3 and 72),
  status text not null default 'preparing' check (status in ('preparing','checking','starting','backfilling','watching','delayed','paused','failed','archived')),
  desired_state text not null default 'running' check (desired_state in ('running','paused','archived')),
  active_version_id uuid,
  pending_version_id uuid,
  muted_until timestamptz,
  last_event_at timestamptz,
  last_block numeric(20,0), last_block_time timestamptz,
  error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(id,user_id)
);
create index watches_user_created on public.watches(user_id,created_at desc);
create table public.watch_versions (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null, user_id uuid not null,
  version integer not null check(version > 0),
  prompt text not null check(length(prompt) between 1 and 2000),
  spec jsonb not null check(jsonb_typeof(spec)='object' and spec->>'chainId'='1' and spec->>'protocol'='uniswap_v3' and spec->>'confirmation'='finalized'),
  created_at timestamptz not null default now(),
  foreign key(watch_id,user_id) references public.watches(id,user_id) on delete cascade,
  unique(watch_id,version), unique(id,watch_id), unique(id,user_id)
);
alter table public.watches add constraint watch_active_version foreign key(active_version_id,id) references public.watch_versions(id,watch_id) deferrable initially deferred;
alter table public.watches add constraint watch_pending_version foreign key(pending_version_id,id) references public.watch_versions(id,watch_id) deferrable initially deferred;

create table app_private.artifacts (
  hash text primary key check(hash ~ '^[a-f0-9]{64}$'),
  template_version text not null, manifest text not null, source_hash text not null,
  storage_path text not null unique, build_log_path text not null,
  module_name text not null, package_sha256 text not null,
  created_at timestamptz not null default now()
);
create table public.pipeline_deployments (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null, user_id uuid not null, version_id uuid not null,
  artifact_hash text references app_private.artifacts(hash),
  state text not null default 'preparing' check(state in ('preparing','checking','starting','backfilling','watching','delayed','paused','failed','retired')),
  proof jsonb not null default '{}', error text,
  last_block numeric(20,0), last_block_time timestamptz, last_message_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(watch_id,user_id) references public.watches(id,user_id) on delete cascade,
  foreign key(version_id,watch_id) references public.watch_versions(id,watch_id),
  unique(version_id)
);
create index deployments_runnable on public.pipeline_deployments(state);
create table app_private.pipeline_leases (
  deployment_id uuid primary key references public.pipeline_deployments(id) on delete cascade,
  owner text not null, expires_at timestamptz not null, generation bigint not null default 1
);
create table app_private.checkpoints (
  deployment_id uuid primary key references public.pipeline_deployments(id) on delete cascade,
  cursor text not null, block_number numeric(20,0) not null, block_hash text not null,
  block_time timestamptz not null, updated_at timestamptz not null default now()
);
create table app_private.events (
  deployment_id uuid not null references public.pipeline_deployments(id) on delete cascade,
  id text not null, block_number numeric(20,0) not null, block_time timestamptz not null,
  pool text not null, payload jsonb not null,
  primary key(deployment_id,id)
);
create index events_window on app_private.events(deployment_id,block_time);
create table public.incidents (
  id uuid primary key default gen_random_uuid(), watch_id uuid not null, user_id uuid not null,
  version_id uuid not null references public.watch_versions(id),
  group_key text not null, title text not null,
  status text not null default 'open' check(status in ('open','reviewed','retracted')),
  read_at timestamptz,
  detection jsonb not null, context jsonb, explanation jsonb,
  delivery text not null default 'inbox_only' check(delivery in ('inbox_only','queued','sent','failed','ambiguous','muted')),
  last_enriched_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(watch_id,user_id) references public.watches(id,user_id) on delete cascade,
  unique(id,user_id), unique(watch_id,group_key)
);
create index incidents_inbox on public.incidents(user_id,created_at desc);
create table public.incident_evidence (
  incident_id uuid not null, user_id uuid not null, event_id text not null, payload jsonb not null,
  foreign key(incident_id,user_id) references public.incidents(id,user_id) on delete cascade,
  primary key(incident_id,event_id)
);
create table app_private.jobs (
  id uuid primary key default gen_random_uuid(), kind text not null check(kind in ('build','enrich','notify','reconcile','test_alert')),
  payload jsonb not null, dedupe_key text not null unique,
  status text not null default 'queued' check(status in ('queued','running','complete','failed')),
  attempts integer not null default 0, max_attempts integer not null default 5,
  run_at timestamptz not null default now(), leased_until timestamptz, leased_by text,
  error_code text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index jobs_claim on app_private.jobs(kind,run_at) where status in ('queued','running');
create table app_private.telegram_pairings (
  token_hash text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null, consumed_at timestamptz
);
create index pairings_user on app_private.telegram_pairings(user_id);
create table app_private.telegram_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_id text not null unique, telegram_user_id text not null unique,
  label text, muted_until timestamptz, error text, connected_at timestamptz not null default now()
);
create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid, user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check(status in ('queued','sending','sent','failed','ambiguous','muted')),
  message_id bigint, attempts integer not null default 0, error_code text,
  created_at timestamptz not null default now(), sent_at timestamptz,
  foreign key(incident_id,user_id) references public.incidents(id,user_id) on delete cascade,
  unique(incident_id)
);
create table public.transaction_intents (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  wallet text not null, chain_id integer not null check(chain_id=1),
  intent jsonb not null, quote jsonb not null, expires_at timestamptz not null,
  state text not null default 'quoted' check(state in ('quoted','prepared','pending','confirmed','reverted','expired','unknown')),
  prepared_transaction jsonb, transaction_hash text unique,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index intents_user on public.transaction_intents(user_id,created_at desc);
create table app_private.rate_limits (
  key text primary key, count integer not null, resets_at timestamptz not null
);
create table app_private.worker_heartbeats (
  id text primary key, last_seen timestamptz not null default now(), details jsonb not null default '{}'
);
create table app_private.webhook_updates (update_id bigint primary key, received_at timestamptz not null default now());

alter table public.watches enable row level security;
alter table public.watch_versions enable row level security;
alter table public.pipeline_deployments enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_evidence enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.transaction_intents enable row level security;
create policy watches_owner on public.watches for select to authenticated using(user_id=(select auth.uid()));
create policy versions_owner on public.watch_versions for select to authenticated using(user_id=(select auth.uid()));
create policy deployments_owner on public.pipeline_deployments for select to authenticated using(user_id=(select auth.uid()));
create policy incidents_owner on public.incidents for select to authenticated using(user_id=(select auth.uid()));
create policy evidence_owner on public.incident_evidence for select to authenticated using(user_id=(select auth.uid()));
create policy deliveries_owner on public.notification_deliveries for select to authenticated using(user_id=(select auth.uid()));
create policy intents_owner on public.transaction_intents for select to authenticated using(user_id=(select auth.uid()));
revoke insert,update,delete on public.watches,public.watch_versions,public.pipeline_deployments,public.incidents,public.incident_evidence,public.notification_deliveries,public.transaction_intents from anon,authenticated;
grant select on public.watches,public.watch_versions,public.pipeline_deployments,public.incidents,public.incident_evidence,public.notification_deliveries,public.transaction_intents to authenticated;
grant all on all tables in schema app_private to service_role;

create function app_private.enqueue(job_kind text, body jsonb, key text) returns uuid
language sql security definer set search_path='' as $$
  insert into app_private.jobs(kind,payload,dedupe_key) values(job_kind,body,key)
  on conflict(dedupe_key) do update set dedupe_key=excluded.dedupe_key returning id;
$$;
create function public.scout_rate_limit(bucket text, maximum integer default 10, period_seconds integer default 60) returns boolean
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if maximum not between 1 and 20 or period_seconds not between 60 and 86400 or length(bucket)>64 then raise exception 'Invalid budget'; end if;
  insert into app_private.rate_limits(key,count,resets_at) values(auth.uid()::text||':'||bucket,1,now()+make_interval(secs=>period_seconds))
  on conflict(key) do update set count=case when app_private.rate_limits.resets_at<now() then 1 else app_private.rate_limits.count+1 end,
  resets_at=case when app_private.rate_limits.resets_at<now() then now()+make_interval(secs=>period_seconds) else app_private.rate_limits.resets_at end returning count into n;
  return n<=maximum;
end $$;

create function public.scout_save_watch(watch_spec jsonb, original_prompt text, existing_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); wid uuid; vid uuid; version_number integer; depid uuid;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if length(original_prompt) not between 1 and 2000 or watch_spec->>'chainId'<>'1' or watch_spec->>'protocol'<>'uniswap_v3' or watch_spec->>'confirmation'<>'finalized' or watch_spec->>'attribution'<>'transaction_initiator_eoa' or watch_spec->>'valuation'<>'chainlink_at_block' or watch_spec->>'unvaluedPolicy'<>'exclude' or jsonb_array_length(watch_spec->'conditions') not between 1 and 3 or jsonb_array_length(watch_spec->'pools') not between 1 and 2 or watch_spec->>'sellToken' not in ('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') then raise exception 'Unsupported specification'; end if;
  if exists(select 1 from jsonb_array_elements_text(watch_spec->'pools') p where p not in ('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640','0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8')) then raise exception 'Unsupported pool'; end if;
  if existing_id is null then
    if (select count(*) from public.watches where user_id=uid and desired_state<>'archived')>=5 then raise exception 'Five-watch limit reached'; end if;
    insert into public.watches(user_id,name) values(uid,watch_spec->>'name') returning id into wid;
    version_number:=1;
  else
    select id into wid from public.watches where id=existing_id and user_id=uid and desired_state<>'archived' for update;
    if wid is null then raise exception 'Watch not found'; end if;
    if exists(select 1 from public.watches where id=wid and pending_version_id is not null) then raise exception 'A replacement is already preparing'; end if;
    select coalesce(max(version),0)+1 into version_number from public.watch_versions where watch_id=wid;
  end if;
  insert into public.watch_versions(watch_id,user_id,version,prompt,spec) values(wid,uid,version_number,original_prompt,watch_spec) returning id into vid;
  update public.watches set pending_version_id=vid,updated_at=now(),error=null where id=wid;
  insert into public.pipeline_deployments(watch_id,user_id,version_id) values(wid,uid,vid) returning id into depid;
  perform app_private.enqueue('build',jsonb_build_object('deploymentId',depid),'build:'||depid);
  return wid;
end $$;

create function public.scout_watch_action(watch_id uuid, action text, mute_minutes integer default 60) returns void
language plpgsql security definer set search_path='' as $$
declare w public.watches;
begin
  select * into w from public.watches where id=watch_id and user_id=auth.uid() for update;
  if w.id is null then raise exception 'Watch not found'; end if;
  if action='pause' then update public.watches set desired_state='paused',status='paused',updated_at=now() where id=w.id;
  elsif action='archive' then update public.watches set desired_state='archived',status='archived',updated_at=now() where id=w.id;
  elsif action='resume' and w.desired_state<>'archived' then
    update public.watches set desired_state='running',status='starting',error=null,updated_at=now() where id=w.id;
    update public.pipeline_deployments set state='starting',error=null where public.pipeline_deployments.watch_id=w.id and version_id in (w.active_version_id,w.pending_version_id) and artifact_hash is not null;
    update app_private.jobs set status='queued',run_at=now(),attempts=0,error_code=null where kind='build' and status='failed' and payload->>'deploymentId' in (select id::text from public.pipeline_deployments where public.pipeline_deployments.watch_id=w.id and artifact_hash is null);
  elsif action='mute' and mute_minutes between 1 and 10080 then update public.watches set muted_until=now()+make_interval(mins=>mute_minutes) where id=w.id;
  elsif action='unmute' then update public.watches set muted_until=null where id=w.id;
  else raise exception 'Unsupported action'; end if;
end $$;

create function public.scout_incident_action(incident_id uuid, action text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if action not in ('read','unread','reviewed','open') then raise exception 'Unsupported action'; end if;
  update public.incidents set read_at=case when action='unread' then null else now() end,
  status=case when status='retracted' then status when action in ('reviewed','open') then action else status end
  where id=incident_id and user_id=auth.uid();
  if not found then raise exception 'Incident not found'; end if;
end $$;

create function public.scout_pair_telegram(token_hash text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid pairing'; end if;
  delete from app_private.telegram_pairings where user_id=auth.uid();
  insert into app_private.telegram_pairings values(token_hash,auth.uid(),now()+interval '10 minutes',null);
end $$;
create function public.scout_telegram_action(action text, mute_minutes integer default 60) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if action='disconnect' then
    delete from app_private.telegram_connections where user_id=auth.uid();
    delete from app_private.telegram_pairings where user_id=auth.uid();
  elsif action='mute' and mute_minutes between 1 and 10080 then update app_private.telegram_connections set muted_until=now()+make_interval(mins=>mute_minutes) where user_id=auth.uid();
  elsif action='unmute' then update app_private.telegram_connections set muted_until=null where user_id=auth.uid();
  elsif action='test' then
    if not exists(select 1 from app_private.telegram_connections where user_id=auth.uid()) then raise exception 'Connect Telegram first'; end if;
    perform app_private.enqueue('test_alert',jsonb_build_object('userId',auth.uid()),'test:'||auth.uid()::text||':'||floor(extract(epoch from now())/60)::text);
  else raise exception 'Unsupported action'; end if;
end $$;

create function public.scout_telegram_webhook(update_id bigint, pairing_hash text default null, chat_id text default null, telegram_user_id text default null, display_label text default null, callback_watch_id uuid default null) returns text
language plpgsql security definer set search_path='' as $$
declare uid uuid;
begin
  insert into app_private.webhook_updates(update_id) values(update_id) on conflict do nothing;
  if not found then return 'duplicate'; end if;
  if pairing_hash is not null then
    update app_private.telegram_pairings set consumed_at=now() where token_hash=pairing_hash and expires_at>now() and consumed_at is null returning user_id into uid;
    if uid is null then return 'expired'; end if;
    if chat_id is null or telegram_user_id is null then raise exception 'Private chat required'; end if;
    delete from app_private.telegram_connections c where c.user_id=uid or c.chat_id=scout_telegram_webhook.chat_id or c.telegram_user_id=scout_telegram_webhook.telegram_user_id;
    insert into app_private.telegram_connections(user_id,chat_id,telegram_user_id,label) values(uid,chat_id,telegram_user_id,left(display_label,80));
    return 'connected';
  elsif callback_watch_id is not null then
    select c.user_id into uid from app_private.telegram_connections c where c.chat_id=scout_telegram_webhook.chat_id and c.telegram_user_id=scout_telegram_webhook.telegram_user_id;
    update public.watches set muted_until=now()+interval '1 hour' where id=callback_watch_id and user_id=uid;
    if not found then return 'unauthorized'; end if;
    return 'muted';
  end if;
  return 'ignored';
end $$;

create function public.scout_snapshot() returns jsonb language sql security definer set search_path='' as $$
select jsonb_build_object(
 'watches',coalesce((select jsonb_agg(jsonb_build_object(
   'id',w.id,'name',v.spec->>'name','prompt',v.prompt,'spec',v.spec,'status',w.status,'version',v.version,
   'pendingVersion',(select version from public.watch_versions where id=w.pending_version_id),'createdAt',w.created_at,
   'lastBlock',w.last_block::text,'lastBlockTime',w.last_block_time,'error',w.error,'mutedUntil',w.muted_until,'lastEventAt',w.last_event_at
 ) order by w.created_at desc) from public.watches w join public.watch_versions v on v.id=coalesce(w.active_version_id,w.pending_version_id) where w.user_id=auth.uid()),'[]'::jsonb),
 'incidents',coalesce((select jsonb_agg(row_data order by created_at desc) from (select i.created_at,jsonb_build_object(
   'id',i.id,'watchId',i.watch_id,'title',i.title,'createdAt',i.created_at,'updatedAt',i.updated_at,'read',i.read_at is not null,
   'status',i.status,'detection',i.detection,'spec',v.spec,'context',i.context,'explanation',i.explanation,'delivery',i.delivery,
   'evidence',coalesce((select jsonb_agg(e.payload order by e.payload->>'timestamp') from public.incident_evidence e where e.incident_id=i.id),'[]'::jsonb)
 ) row_data from public.incidents i join public.watch_versions v on v.id=i.version_id where i.user_id=auth.uid() order by i.created_at desc limit 100) q),'[]'::jsonb),
 'telegram',coalesce((select jsonb_build_object('connected',true,'label',label,'mutedUntil',muted_until,'error',error) from app_private.telegram_connections where user_id=auth.uid()),jsonb_build_object('connected',false,'label',null,'mutedUntil',null,'error',null)),
 'worker',jsonb_build_object('online',exists(select 1 from app_private.worker_heartbeats where last_seen>now()-interval '45 seconds'),'lastSeen',(select max(last_seen) from app_private.worker_heartbeats))
) where auth.uid() is not null;
$$;

insert into storage.buckets(id,name,public,file_size_limit) values('pipeline-artifacts','pipeline-artifacts',false,52428800) on conflict(id) do nothing;
-- Artifacts use shared content hashes. Access is authorized through the download endpoint
-- against the caller's deployment; no direct browser Storage policy is granted.
revoke all on function app_private.enqueue(text,jsonb,text) from public,anon,authenticated;
revoke all on function public.scout_rate_limit(text,integer,integer),public.scout_save_watch(jsonb,text,uuid),public.scout_watch_action(uuid,text,integer),public.scout_incident_action(uuid,text),public.scout_pair_telegram(text),public.scout_telegram_action(text,integer),public.scout_snapshot() from public,anon;
grant execute on function public.scout_rate_limit(text,integer,integer),public.scout_save_watch(jsonb,text,uuid),public.scout_watch_action(uuid,text,integer),public.scout_incident_action(uuid,text),public.scout_pair_telegram(text),public.scout_telegram_action(text,integer),public.scout_snapshot() to authenticated;
revoke all on function public.scout_telegram_webhook(bigint,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.scout_telegram_webhook(bigint,text,text,text,text,uuid) to service_role;
