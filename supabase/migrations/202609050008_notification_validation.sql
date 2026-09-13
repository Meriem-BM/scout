create or replace function public.scout_save_watch_v2(watch_spec jsonb, original_prompt text, existing_id uuid default null, save_draft boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); wid uuid; vid uuid; version_number integer; depid uuid;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if coalesce((watch_spec->'notifications'->>'useDefaults')::boolean,false) then
    watch_spec:=jsonb_set(watch_spec,'{notifications}',jsonb_build_object('inbox',true,'useDefaults',true,
      'telegram',coalesce((select telegram from public.account_preferences where user_id=uid),true),
      'email',coalesce((select email from public.account_preferences where user_id=uid),false)));
  end if;

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


create function app_private.validate_notification_spec() returns trigger language plpgsql set search_path='' as $$
begin
 if new.spec ? 'cooldownSeconds' and not coalesce((new.spec->>'cooldownSeconds')::integer between 300 and 3600,false) then raise exception 'Invalid incident grouping window'; end if;
 if (new.spec->'notifications' ? 'email' and jsonb_typeof(new.spec->'notifications'->'email') is distinct from 'boolean') or (new.spec->'notifications' ? 'useDefaults' and jsonb_typeof(new.spec->'notifications'->'useDefaults') is distinct from 'boolean') then raise exception 'Invalid notification preferences'; end if;
 return new;
end $$;
create trigger valid_notification_spec before insert on public.watch_versions for each row execute function app_private.validate_notification_spec();
revoke all on function app_private.validate_notification_spec() from public,anon,authenticated;
