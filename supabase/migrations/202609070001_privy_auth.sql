-- Privy is the authentication authority. Scout IDs remain UUIDs so watch,
-- incident, outbox and worker ownership do not change during migration.
create table app_private.accounts (
 id uuid primary key default gen_random_uuid(),
 legacy_user_id uuid unique,
 verified_email text,
 created_at timestamptz not null default now()
);
insert into app_private.accounts(id,legacy_user_id,verified_email)
 select id,id,case when email_confirmed_at is not null then lower(email) end from auth.users;

-- Replace only direct auth.users references; compound evidence/watch FKs stay.
do $$ declare c record; begin
 for c in select conrelid::regclass tbl,conname,pg_get_constraintdef(oid) definition
  from pg_constraint where contype='f' and confrelid='auth.users'::regclass
  and connamespace in ('public'::regnamespace,'app_private'::regnamespace)
 loop
  execute format('alter table %s drop constraint %I',c.tbl,c.conname);
  execute format('alter table %s add constraint %I %s',c.tbl,c.conname,
   replace(c.definition,'REFERENCES auth.users(id)','REFERENCES app_private.accounts(id)'));
 end loop;
end $$;

-- Supports explicitly provisioned legacy accounts during a staged rollout.
create function app_private.remember_legacy_account() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into app_private.accounts(id,legacy_user_id,verified_email)
 values(new.id,new.id,case when new.email_confirmed_at is not null then lower(new.email) end)
 on conflict(id) do nothing;
 return new;
end $$;
create trigger scout_legacy_account after insert on auth.users for each row execute function app_private.remember_legacy_account();

create table app_private.privy_accounts (
 subject text primary key check(subject like 'did:privy:%'),
 account_id uuid not null unique references app_private.accounts(id),
 linked_at timestamptz not null default now(),
 migrated_at timestamptz
);
create table app_private.privy_sessions (
 session_id text primary key,
 subject text not null references app_private.privy_accounts(subject),
 expires_at timestamptz not null,
 revoked_at timestamptz
);
create table app_private.account_link_challenges (
 token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'),
 subject text not null references app_private.privy_accounts(subject),
 session_id text not null references app_private.privy_sessions(session_id),
 email text not null,
 expires_at timestamptz not null default now()+interval '10 minutes',
 attempts integer not null default 0,
 consumed_at timestamptz
);
alter table app_private.accounts enable row level security;
alter table app_private.privy_accounts enable row level security;
alter table app_private.privy_sessions enable row level security;
alter table app_private.account_link_challenges enable row level security;

create function public.scout_authenticate(privy_subject text,privy_session text,token_expires timestamptz,account_email text default null,provision boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid; sid app_private.privy_sessions;
begin
 if privy_subject not like 'did:privy:%' or length(privy_subject)>256 or length(privy_session) not between 1 and 256 or token_expires<=now() then raise exception 'Invalid authentication'; end if;
 perform pg_advisory_xact_lock(hashtextextended(privy_subject,71));
 select account_id into uid from app_private.privy_accounts where subject=privy_subject;
 if uid is null then
  if not provision then return null; end if;
  insert into app_private.accounts(verified_email) values(lower(account_email)) returning id into uid;
  insert into app_private.privy_accounts(subject,account_id) values(privy_subject,uid);
 end if;
 select * into sid from app_private.privy_sessions where session_id=privy_session for update;
 if found and (sid.subject<>privy_subject or sid.revoked_at is not null) then raise exception 'Session revoked'; end if;
 insert into app_private.privy_sessions(session_id,subject,expires_at) values(privy_session,privy_subject,token_expires)
 on conflict(session_id) do update set expires_at=greatest(app_private.privy_sessions.expires_at,excluded.expires_at);
 if provision then update app_private.accounts set verified_email=lower(account_email) where id=uid; end if;
 return (select jsonb_build_object('userId',a.id,'email',a.verified_email,'migrated',p.migrated_at is not null) from app_private.accounts a join app_private.privy_accounts p on p.account_id=a.id where a.id=uid);
end $$;

create function public.scout_logout(privy_subject text,privy_session text) returns void language sql security definer set search_path='' as $$
 update app_private.privy_sessions set revoked_at=coalesce(revoked_at,now()) where session_id=privy_session and subject=privy_subject;
$$;

create function app_private.privy_account(privy_subject text,privy_session text) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid; begin
 select p.account_id into uid from app_private.privy_accounts p join app_private.privy_sessions s on s.subject=p.subject
 where p.subject=privy_subject and s.session_id=privy_session and s.revoked_at is null and s.expires_at>now();
 if uid is null then raise exception 'Session expired or revoked'; end if;
 return uid;
end $$;

-- Only the server service role may call this finite dispatch boundary. The
-- caller never supplies a Scout UUID or a SQL identifier. Existing RPCs retain
-- their auth.uid() ownership guards; claims are transaction-local and restored.
create function public.scout_account_rpc(privy_subject text,privy_session text,operation text,args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid; previous_claims text; previous_sub text; result jsonb;
begin
 uid:=app_private.privy_account(privy_subject,privy_session);
 previous_claims:=current_setting('request.jwt.claims',true);
 previous_sub:=current_setting('request.jwt.claim.sub',true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
 perform set_config('request.jwt.claim.sub',uid::text,true);
 case operation
 when 'scout_snapshot' then result:=public.scout_snapshot();
 when 'scout_rate_limit' then result:=to_jsonb(public.scout_rate_limit(args->>'bucket',coalesce((args->>'maximum')::int,10),coalesce((args->>'period_seconds')::int,60)));
 when 'scout_save_watch_v2' then result:=to_jsonb(public.scout_save_watch_v2(args->'watch_spec',args->>'original_prompt',(args->>'existing_id')::uuid,coalesce((args->>'save_draft')::boolean,false)));
 when 'scout_save_watch' then result:=to_jsonb(public.scout_save_watch(args->'watch_spec',args->>'original_prompt',(args->>'existing_id')::uuid));
 when 'scout_watch_action' then perform public.scout_watch_action((args->>'watch_id')::uuid,args->>'action',coalesce((args->>'mute_minutes')::int,60));
 when 'scout_watch_destinations' then perform public.scout_watch_destinations((args->>'watch_id')::uuid,nullif(args->'channels','null'::jsonb));
 when 'scout_watch_detail' then result:=public.scout_watch_detail((args->>'watch_id')::uuid);
 when 'scout_watches_page' then result:=public.scout_watches_page(coalesce((args->>'page_offset')::int,0),coalesce(args->>'search_text',''),coalesce(args->>'status_filter','all'),coalesce(args->>'sort_order','newest'));
 when 'scout_watch_history' then result:=public.scout_watch_history((args->>'watch_id')::uuid,coalesce((args->>'page_offset')::int,0),coalesce(args->>'search_text',''),coalesce(args->>'status_filter','all'));
 when 'scout_incident' then result:=public.scout_incident((args->>'incident_id')::uuid);
 when 'scout_delivery_history' then result:=public.scout_delivery_history((args->>'incident_id')::uuid);
 when 'scout_incident_action' then perform public.scout_incident_action((args->>'incident_id')::uuid,args->>'action');
 when 'scout_preferences' then perform public.scout_preferences(args->'preferences');
 when 'scout_pair_telegram' then perform public.scout_pair_telegram(args->>'token_hash');
 when 'scout_telegram_action' then perform public.scout_telegram_action(args->>'action',coalesce((args->>'mute_minutes')::int,60));
 when 'scout_telegram_test_status' then result:=public.scout_telegram_test_status();
 when 'scout_email_action' then perform public.scout_email_action(args->>'action');
 when 'scout_email_verify' then perform public.scout_email_verify(args->>'token_hash');
 else raise exception 'Operation not allowed';
 end case;
 perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
 perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 return result;
end $$;

create function public.scout_link_begin(privy_subject text,privy_session text,challenge_hash text,legacy_email text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform app_private.privy_account(privy_subject,privy_session);
 delete from app_private.account_link_challenges where subject=privy_subject;
 insert into app_private.account_link_challenges(token_hash,subject,session_id,email) values(challenge_hash,privy_subject,privy_session,lower(trim(legacy_email)));
end $$;
create function public.scout_link_attempt(privy_subject text,privy_session text,challenge_hash text) returns text language plpgsql security definer set search_path='' as $$
declare target text; begin
 perform app_private.privy_account(privy_subject,privy_session);
 update app_private.account_link_challenges set attempts=attempts+1 where token_hash=challenge_hash and subject=privy_subject and session_id=privy_session and expires_at>now() and consumed_at is null and attempts<5 returning email into target;
 if target is null then raise exception 'Link request expired. Request another code'; end if;
 return target;
end $$;
create function public.scout_link_account(privy_subject text,privy_session text,legacy_id uuid,challenge_hash text) returns uuid language plpgsql security definer set search_path='' as $$
declare current_id uuid; target_email text; begin
 perform pg_advisory_xact_lock(hashtextextended(privy_subject,71));
 current_id:=app_private.privy_account(privy_subject,privy_session);
 perform 1 from app_private.accounts where id=legacy_id and legacy_user_id=legacy_id for update;
 if not found then raise exception 'Previous account is unavailable'; end if;
 select email into target_email from app_private.account_link_challenges where token_hash=challenge_hash and subject=privy_subject and session_id=privy_session and consumed_at is null and expires_at>now() and attempts between 1 and 5 for update;
 if target_email is null or not exists(select 1 from auth.users where id=legacy_id and lower(email)=target_email and email_confirmed_at is not null) then raise exception 'Previous account proof was not accepted'; end if;
 if exists(select 1 from app_private.privy_accounts where account_id=legacy_id and subject<>privy_subject) then raise exception 'Previous account is already linked to another login'; end if;
 if current_id<>legacy_id then
  if exists(select 1 from public.watches where user_id=current_id) or exists(select 1 from public.transaction_intents where user_id=current_id) or exists(select 1 from public.account_preferences where user_id=current_id) or exists(select 1 from app_private.telegram_connections where user_id=current_id) or exists(select 1 from app_private.telegram_pairings where user_id=current_id) or exists(select 1 from app_private.email_connections where user_id=current_id) or exists(select 1 from app_private.email_verifications where user_id=current_id) or exists(select 1 from public.notification_deliveries where user_id=current_id) then raise exception 'This login already has Scout data. Accounts cannot be merged automatically. Contact support'; end if;
  update app_private.accounts set verified_email=(select verified_email from app_private.accounts where id=current_id) where id=legacy_id;
  update app_private.privy_accounts set account_id=legacy_id,migrated_at=now() where subject=privy_subject;
  -- Keep the unused account row for audit; never delete user evidence.
 end if;
 update app_private.account_link_challenges set consumed_at=now() where token_hash=challenge_hash;
 return legacy_id;
end $$;

-- Notification consent stays explicit; only server-verified Privy email is
-- eligible for the existing opt-in shortcut. No login creates a destination.
do $$ declare definition text; begin
 select pg_get_functiondef('public.scout_email_begin(uuid,text,text,jsonb,boolean)'::regprocedure) into definition;
 definition:=replace(definition,'select 1 from auth.users where id=uid and lower(email)=target and email_confirmed_at is not null','select 1 from app_private.accounts where id=uid and verified_email=target');
 execute definition;
end $$;

-- Existing Supabase JWTs remain useful solely for proving a legacy login.
-- They no longer authorize the Data API. RLS policies are retained in place.
revoke all on all tables in schema public from anon,authenticated;
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'scout_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
revoke all on all functions in schema app_private from public,anon,authenticated;
revoke all on all tables in schema app_private from public,anon,authenticated;
