-- Additive product update. Historical versions, evidence and delivery IDs are retained.
alter table public.watches drop constraint watches_status_check;
alter table public.watches add constraint watches_status_check check(status in ('draft','preparing','checking','starting','backfilling','watching','delayed','paused','failed','archived'));
alter table public.watches add column destination_overrides jsonb;
create table public.account_preferences (
 user_id uuid primary key references auth.users(id) on delete cascade,
 timezone text not null default 'UTC', telegram boolean not null default true,
 email boolean not null default false, cooldown_seconds integer not null default 900 check(cooldown_seconds between 300 and 3600)
);
alter table public.account_preferences enable row level security;
create policy preferences_owner on public.account_preferences for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.account_preferences from anon,authenticated;
grant select on public.account_preferences to authenticated;
create table app_private.email_connections (
 id uuid primary key default gen_random_uuid(), user_id uuid not null unique references auth.users(id) on delete cascade,
 address text not null, verified_at timestamptz not null default now(), enabled boolean not null default true,
 suppressed boolean not null default false, error text, updated_at timestamptz not null default now()
);
create table app_private.email_suppressions(address text primary key, reason text not null, created_at timestamptz not null default now());
create table app_private.email_verifications (
 user_id uuid primary key references auth.users(id) on delete cascade, address text not null,
 token_hash text not null unique, expires_at timestamptz not null, consumed_at timestamptz
);
alter table public.notification_deliveries drop constraint notification_deliveries_incident_id_key;
alter table public.notification_deliveries drop constraint notification_deliveries_status_check;
alter table public.notification_deliveries add constraint notification_deliveries_status_check check(status in ('queued','sending','sent','delivered','delayed','failed','bounced','suppressed','ambiguous','muted'));
alter table public.notification_deliveries add column channel text not null default 'telegram' check(channel in ('telegram','email'));
alter table public.notification_deliveries add column destination text;
alter table public.notification_deliveries add column provider_id text unique;
alter table public.notification_deliveries add column provider_event_at timestamptz;
alter table public.notification_deliveries add constraint delivery_incident_channel unique(incident_id,channel);
create table app_private.email_outbox (
 id uuid primary key references public.notification_deliveries(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, connection_id uuid,
 kind text not null check(kind in ('incident','verification','test')), destination text not null,
 payload jsonb, first_attempt_at timestamptz, expires_at timestamptz,
 dedupe_key text not null unique, created_at timestamptz not null default now()
);
create table app_private.email_webhook_events (
 id text primary key, provider_id text not null, event_type text not null, occurred_at timestamptz not null,
 received_at timestamptz not null default now()
);
create index email_events_provider on app_private.email_webhook_events(provider_id);
alter table app_private.jobs drop constraint jobs_kind_check;
alter table app_private.jobs add constraint jobs_kind_check check(kind in ('build','enrich','notify','reconcile','test_alert','email'));
create index incidents_watch_history on public.incidents(watch_id,created_at desc,id);
grant all on all tables in schema app_private to service_role;

create function public.scout_preferences(preferences jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if not exists(select 1 from pg_timezone_names where name=preferences->>'timezone') or not coalesce((preferences->>'cooldownSeconds')::integer between 300 and 3600,false)
 or jsonb_typeof(preferences->'telegram')<>'boolean' or jsonb_typeof(preferences->'email')<>'boolean' then raise exception 'Invalid preferences'; end if;
 insert into public.account_preferences(user_id,timezone,telegram,email,cooldown_seconds) values(auth.uid(),preferences->>'timezone',(preferences->>'telegram')::boolean,(preferences->>'email')::boolean,(preferences->>'cooldownSeconds')::integer)
 on conflict(user_id) do update set timezone=excluded.timezone,telegram=excluded.telegram,email=excluded.email,cooldown_seconds=excluded.cooldown_seconds;
end $$;
create function public.scout_save_watch_v2(watch_spec jsonb, original_prompt text, existing_id uuid default null, save_draft boolean default false) returns uuid
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
    if exists(select 1 from public.watches where id=wid and pending_version_id is not null and status<>'draft') then raise exception 'A replacement is already preparing'; end if;
    select coalesce(max(version),0)+1 into version_number from public.watch_versions where watch_id=wid;
  end if;
  if save_draft and exists(select 1 from public.watches where id=wid and active_version_id is not null) then raise exception 'An active watch must use a replacement version'; end if;
  if not save_draft and not exists(
   select 1 from app_private.telegram_connections c where c.user_id=uid and coalesce((watch_spec->'notifications'->>'telegram')::boolean,false)
   union all select 1 from app_private.email_connections e where e.user_id=uid and e.enabled and not e.suppressed and coalesce((watch_spec->'notifications'->>'email')::boolean,false)
  ) then raise exception 'Connect and enable at least one verified alert destination before activation'; end if;
  insert into public.watch_versions(watch_id,user_id,version,prompt,spec) values(wid,uid,version_number,original_prompt,watch_spec) returning id into vid;
  update public.watches set pending_version_id=vid,updated_at=now(),error=null where id=wid;
  update public.watches set status=case when save_draft then 'draft' when active_version_id is null then 'preparing' else status end,
    desired_state=case when save_draft then 'paused' else 'running' end,
    destination_overrides=case when coalesce((watch_spec->'notifications'->>'useDefaults')::boolean,false) then null else watch_spec->'notifications' end where id=wid;
  if save_draft then return wid; end if;
  insert into public.pipeline_deployments(watch_id,user_id,version_id) values(wid,uid,vid) returning id into depid;
  perform app_private.enqueue('build',jsonb_build_object('deploymentId',depid),'build:'||depid);
  return wid;
end $$;

create or replace function public.scout_save_watch(watch_spec jsonb, original_prompt text, existing_id uuid default null) returns uuid language sql security definer set search_path='' as $$
 select public.scout_save_watch_v2(watch_spec,original_prompt,existing_id,false);
$$;
create or replace function public.scout_watch_action(watch_id uuid, action text, mute_minutes integer default 60) returns void
language plpgsql security definer set search_path='' as $$
declare w public.watches;
begin
  select * into w from public.watches where id=watch_id and user_id=auth.uid() for update;
  if w.id is null then raise exception 'Watch not found'; end if;
  if action='restore' and w.status='archived' then
    if (select count(*) from public.watches where user_id=auth.uid() and desired_state<>'archived')>=5 then raise exception 'Five-watch limit reached'; end if;
    update public.watches set desired_state='paused',status=case when active_version_id is null and not exists(select 1 from public.pipeline_deployments d where d.watch_id=w.id) then 'draft' else 'paused' end,updated_at=now() where id=w.id;
  elsif action='pause' then update public.watches set desired_state='paused',status='paused',updated_at=now() where id=w.id;
  elsif action='archive' then update public.watches set desired_state='archived',status='archived',updated_at=now() where id=w.id;
  elsif action='resume' and w.desired_state<>'archived' and w.status<>'draft' then
    update public.watches set desired_state='running',status='starting',error=null,updated_at=now() where id=w.id;
    update public.pipeline_deployments set state='starting',error=null where public.pipeline_deployments.watch_id=w.id and version_id in (w.active_version_id,w.pending_version_id) and artifact_hash is not null;
    update app_private.jobs set status='queued',run_at=now(),attempts=0,error_code=null where kind='build' and status='failed' and payload->>'deploymentId' in (select id::text from public.pipeline_deployments where public.pipeline_deployments.watch_id=w.id and artifact_hash is null);
  elsif action='mute' and mute_minutes between 1 and 10080 then update public.watches set muted_until=now()+make_interval(mins=>mute_minutes) where id=w.id;
  elsif action='unmute' then update public.watches set muted_until=null where id=w.id;
  else raise exception 'Unsupported action'; end if;
end $$;

create function public.scout_watch_destinations(watch_id uuid, channels jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if channels is not null and (jsonb_typeof(channels->'telegram') is distinct from 'boolean' or jsonb_typeof(channels->'email') is distinct from 'boolean') then raise exception 'Invalid destinations'; end if;
 update public.watches set destination_overrides=channels,updated_at=now() where id=watch_id and user_id=auth.uid();
 if not found then raise exception 'Watch not found'; end if;
end $$;
create function app_private.queue_email(uid uuid, kind text, destination text, payload jsonb, key text, connection_id uuid default null, incident_id uuid default null, expires_at timestamptz default null) returns uuid language plpgsql security definer set search_path='' as $$
declare did uuid;
begin
 select id into did from app_private.email_outbox where dedupe_key=key;
 if did is not null then return did; end if;
 insert into public.notification_deliveries(user_id,incident_id,channel,destination) values(uid,incident_id,'email',destination) returning id into did;
 insert into app_private.email_outbox(id,user_id,connection_id,kind,destination,payload,dedupe_key,expires_at) values(did,uid,connection_id,kind,destination,payload,key,expires_at);
 perform app_private.enqueue('email',jsonb_build_object('deliveryId',did),'email:'||did);
 return did;
end $$;
create function public.scout_email_begin(owner_id uuid, destination text, token_hash text, mail_payload jsonb, use_account boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=owner_id; target text:=lower(trim(destination));
begin
 if uid is null then raise exception 'Authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 if length(target)>254 or target !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid email'; end if;
 if exists(select 1 from app_private.email_suppressions where address=target) then raise exception 'This destination is suppressed after a bounce or complaint. Use another address or contact support'; end if;
 if use_account then
  if not exists(select 1 from auth.users where id=uid and lower(email)=target and email_confirmed_at is not null) then raise exception 'Account email is not verified'; end if;
  insert into app_private.email_connections(user_id,address) values(uid,target) on conflict(user_id) do update set id=gen_random_uuid(),address=excluded.address,verified_at=now(),enabled=true,suppressed=false,error=null,updated_at=now();
  delete from app_private.email_verifications where user_id=uid;
 else
  if token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid verification'; end if;
  insert into app_private.email_verifications values(uid,target,token_hash,now()+interval '10 minutes',null) on conflict(user_id) do update set address=excluded.address,token_hash=excluded.token_hash,expires_at=excluded.expires_at,consumed_at=null;
  perform app_private.queue_email(uid,'verification',target,mail_payload,'verification:'||token_hash,null,null,now()+interval '10 minutes');
 end if;
end $$;
create function public.scout_email_verify(token_hash text) returns void language plpgsql security definer set search_path='' as $$
declare v app_private.email_verifications;
begin
 update app_private.email_verifications set consumed_at=now() where user_id=auth.uid() and email_verifications.token_hash=scout_email_verify.token_hash and expires_at>now() and consumed_at is null returning * into v;
 if v.user_id is null then raise exception 'This verification link is invalid, expired, already used, or belongs to another account'; end if;
 if exists(select 1 from app_private.email_suppressions where address=v.address) then raise exception 'This destination is suppressed. Use another address'; end if;
 insert into app_private.email_connections(user_id,address) values(v.user_id,v.address) on conflict(user_id) do update set id=gen_random_uuid(),address=excluded.address,verified_at=now(),enabled=true,suppressed=false,error=null,updated_at=now();
end $$;
create function public.scout_email_action(action text) returns void language plpgsql security definer set search_path='' as $$
declare c app_private.email_connections;
begin
 select * into c from app_private.email_connections where user_id=auth.uid() for update;
 if c.id is null then raise exception 'Verify an email destination first'; end if;
 if action='disconnect' then
  delete from app_private.email_connections where user_id=auth.uid();
  delete from app_private.email_verifications where user_id=auth.uid();
 elsif action='disable' then update app_private.email_connections set enabled=false where id=c.id;
 elsif action='enable' and not c.suppressed then update app_private.email_connections set enabled=true where id=c.id;
 elsif action='test' and c.enabled and not c.suppressed then
  if not public.scout_rate_limit('_telegram_test',1,60) then raise exception 'Wait one minute before another test'; end if;
  perform app_private.queue_email(c.user_id,'test',c.address,null,'test:'||c.id||':'||floor(extract(epoch from now())/60),c.id);
 else raise exception 'This action is unavailable. Check destination status'; end if;
end $$;
-- Only a server-validated destination-specific HMAC can call this capability.
create function public.scout_email_disable(connection_id uuid) returns void language sql security definer set search_path='' as $$
 update app_private.email_connections set enabled=false where id=connection_id;
$$;

create function app_private.watch_json(w public.watches) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',w.id,'name',v.spec->>'name','prompt',v.prompt,
 'spec',jsonb_set(v.spec,'{notifications}',coalesce(w.destination_overrides || '{"inbox":true,"useDefaults":false}'::jsonb,
   jsonb_build_object('inbox',true,'telegram',coalesce(p.telegram,true),'email',coalesce(p.email,false),'useDefaults',true))),
 'status',w.status,'version',v.version,'pendingVersion',(select version from public.watch_versions where id=w.pending_version_id),
 'createdAt',w.created_at,'lastBlock',w.last_block::text,'lastBlockTime',w.last_block_time,'error',w.error,'mutedUntil',w.muted_until,'lastEventAt',w.last_event_at)
 from public.watch_versions v left join public.account_preferences p on p.user_id=w.user_id where v.id=coalesce(w.active_version_id,w.pending_version_id);
$$;
-- Preserve existing per-watch Telegram intent when introducing account defaults.
update public.watches w set destination_overrides=v.spec->'notifications' from public.watch_versions v where v.id=coalesce(w.active_version_id,w.pending_version_id);
create function app_private.incident_json(i public.incidents, full_evidence boolean default false) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',i.id,'watchId',i.watch_id,'title',i.title,'createdAt',i.created_at,'updatedAt',i.updated_at,
 'read',i.read_at is not null,'status',i.status,'detection',i.detection,'spec',v.spec,'context',i.context,'explanation',i.explanation,'delivery',i.delivery,
 'evidence',case when full_evidence then coalesce((select jsonb_agg(e.payload order by e.payload->>'timestamp',e.event_id) from public.incident_evidence e where e.incident_id=i.id),'[]'::jsonb) else '[]'::jsonb end)
 from public.watch_versions v where v.id=i.version_id;
$$;
create function public.scout_watches_page(page_offset integer default 0, search_text text default '', status_filter text default 'all', sort_order text default 'newest') returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(value),'[]'::jsonb) from (select app_private.watch_json(w) value from public.watches w
 where w.user_id=auth.uid() and (w.name ilike '%'||left(search_text,100)||'%') and
 (case status_filter when 'archived' then w.status='archived' when 'all' then w.status<>'archived' when 'watching' then w.status in ('watching','delayed') when 'attention' then w.status in ('failed','delayed') or w.error is not null else w.status=status_filter end)
 order by case when sort_order='name' then w.name end asc,case when sort_order='oldest' then w.created_at end asc,w.created_at desc,w.id
 limit 21 offset greatest(0,least(page_offset,100000))) q;
$$;
create or replace function public.scout_snapshot() returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object(
 'watches',coalesce((select jsonb_agg(value) from (select app_private.watch_json(w) value from public.watches w where w.user_id=auth.uid() order by (w.status='archived'),w.created_at desc limit 100) q),'[]'::jsonb),
 'incidents',coalesce((select jsonb_agg(app_private.incident_json(i)) from (select distinct on(watch_id) * from public.incidents where user_id=auth.uid() order by watch_id,created_at desc limit 100) i),'[]'::jsonb),
 'telegram',coalesce((select jsonb_build_object('connected',true,'label',label,'mutedUntil',muted_until,'error',error) from app_private.telegram_connections where user_id=auth.uid()),'{"connected":false,"label":null,"mutedUntil":null,"error":null}'::jsonb),
 'emailConnection',jsonb_build_object('address',(select address from app_private.email_connections where user_id=auth.uid()),
 'verified',exists(select 1 from app_private.email_connections where user_id=auth.uid()),
 'enabled',coalesce((select enabled from app_private.email_connections where user_id=auth.uid()),false),
 'suppressed',coalesce((select suppressed from app_private.email_connections where user_id=auth.uid()),false),
 'error',(select error from app_private.email_connections where user_id=auth.uid()),
 'pendingAddress',(select address from app_private.email_verifications where user_id=auth.uid() and consumed_at is null),
 'expiresAt',(select expires_at from app_private.email_verifications where user_id=auth.uid() and consumed_at is null),
 'lastStatus',(select status from public.notification_deliveries where user_id=auth.uid() and channel='email' order by created_at desc limit 1),
 'lastSentAt',(select sent_at from public.notification_deliveries where user_id=auth.uid() and channel='email' order by created_at desc limit 1)),
 'preferences',coalesce((select jsonb_build_object('timezone',timezone,'telegram',telegram,'email',email,'cooldownSeconds',cooldown_seconds) from public.account_preferences where user_id=auth.uid()),'{"timezone":"UTC","telegram":true,"email":false,"cooldownSeconds":900}'::jsonb),
 'worker',jsonb_build_object('online',exists(select 1 from app_private.worker_heartbeats where last_seen>now()-interval '45 seconds'),'lastSeen',(select max(last_seen) from app_private.worker_heartbeats))
 ) where auth.uid() is not null;
$$;
create function public.scout_watch_history(watch_id uuid, page_offset integer default 0, search_text text default '', status_filter text default 'all') returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(value),'[]'::jsonb) from (select app_private.incident_json(i) value from public.incidents i where i.watch_id=scout_watch_history.watch_id and i.user_id=auth.uid()
 and (i.title ilike '%'||left(search_text,100)||'%') and (status_filter='all' or i.status=status_filter)
 order by i.created_at desc,i.id limit 21 offset greatest(0,least(page_offset,100000))) q;
$$;
create function public.scout_incident(incident_id uuid) returns jsonb language sql security definer set search_path='' as $$
 select app_private.incident_json(i,true) from public.incidents i where i.id=incident_id and i.user_id=auth.uid();
$$;
create function public.scout_delivery_history(incident_id uuid) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'channel',channel,'status',status,'destination',destination,'createdAt',created_at,'sentAt',sent_at,'error',error_code,'providerId',coalesce(provider_id,message_id::text)) order by created_at),'[]'::jsonb)
 from public.notification_deliveries where notification_deliveries.incident_id=scout_delivery_history.incident_id and user_id=auth.uid();
$$;
-- Persist authenticated webhook metadata before matching. Early webhooks are reconciled after API acceptance.
create function app_private.reconcile_email(provider text) returns void language plpgsql security definer set search_path='' as $$
declare e app_private.email_webhook_events; d public.notification_deliveries; next_status text;
begin
 select * into d from public.notification_deliveries where provider_id=provider for update;
 if d.id is null then return; end if;
 select * into e from app_private.email_webhook_events where provider_id=provider
 order by case event_type when 'email.complained' then 100 when 'email.suppressed' then 95 when 'email.bounced' then 90 when 'email.delivered' then 80 when 'email.failed' then 70 when 'email.delivery_delayed' then 30 when 'email.sent' then 20 else 0 end desc,occurred_at desc limit 1;
 next_status:=case e.event_type when 'email.complained' then 'suppressed' when 'email.suppressed' then 'suppressed' when 'email.bounced' then 'bounced' when 'email.delivered' then 'delivered' when 'email.failed' then 'failed' when 'email.delivery_delayed' then 'delayed' when 'email.sent' then 'sent' else null end;
 if next_status is null then return; end if;
 update public.notification_deliveries set status=next_status,provider_event_at=e.occurred_at,error_code=case when next_status in ('bounced','suppressed','failed') then e.event_type else null end where id=d.id;
 if next_status in ('bounced','suppressed') then
  insert into app_private.email_suppressions(address,reason) values(d.destination,e.event_type) on conflict(address) do update set reason=excluded.reason;
  update app_private.email_connections set suppressed=true,enabled=false,error='Email was suppressed after a permanent rejection or complaint. Verify another address.' where address=d.destination;
 end if;
end $$;
create function public.scout_email_event(event_id text, provider text, event_type text, occurred_at timestamptz) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into app_private.email_webhook_events(id,provider_id,event_type,occurred_at) values(event_id,provider,event_type,occurred_at) on conflict(id) do nothing;
 perform app_private.reconcile_email(provider);
end $$;
revoke all on all functions in schema app_private from public,anon,authenticated;
grant execute on all functions in schema app_private to service_role;
revoke all on function public.scout_preferences(jsonb) from public,anon,authenticated;
grant execute on function public.scout_preferences(jsonb) to authenticated;
revoke all on function public.scout_save_watch_v2(jsonb,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.scout_save_watch_v2(jsonb,text,uuid,boolean) to authenticated;
revoke all on function public.scout_save_watch(jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.scout_save_watch(jsonb,text,uuid) to authenticated;
revoke all on function public.scout_watch_action(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.scout_watch_action(uuid,text,integer) to authenticated;
revoke all on function public.scout_watch_destinations(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.scout_watch_destinations(uuid,jsonb) to authenticated;
revoke all on function public.scout_email_begin(uuid,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.scout_email_begin(uuid,text,text,jsonb,boolean) to service_role;
revoke all on function public.scout_email_verify(text) from public,anon,authenticated;
grant execute on function public.scout_email_verify(text) to authenticated;
revoke all on function public.scout_email_action(text) from public,anon,authenticated;
grant execute on function public.scout_email_action(text) to authenticated;
revoke all on function public.scout_email_disable(uuid) from public,anon,authenticated;
grant execute on function public.scout_email_disable(uuid) to service_role;
revoke all on function public.scout_watches_page(integer,text,text,text) from public,anon,authenticated;
grant execute on function public.scout_watches_page(integer,text,text,text) to authenticated;
revoke all on function public.scout_snapshot() from public,anon,authenticated;
grant execute on function public.scout_snapshot() to authenticated;
revoke all on function public.scout_watch_history(uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.scout_watch_history(uuid,integer,text,text) to authenticated;
revoke all on function public.scout_incident(uuid) from public,anon,authenticated;
grant execute on function public.scout_incident(uuid) to authenticated;
revoke all on function public.scout_delivery_history(uuid) from public,anon,authenticated;
grant execute on function public.scout_delivery_history(uuid) to authenticated;
revoke all on function public.scout_email_event(text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.scout_email_event(text,text,text,timestamptz) to service_role;
