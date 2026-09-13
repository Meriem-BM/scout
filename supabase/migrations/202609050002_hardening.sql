-- Defense in depth for direct authenticated RPC calls, not only the web's Zod boundary.
create function app_private.validate_watch_version() returns trigger language plpgsql set search_path='' as $$
declare s jsonb:=new.spec; c jsonb; n integer;
begin
  if tg_op='UPDATE' then raise exception 'Watch versions are immutable'; end if;
  if not coalesce(s->>'schemaVersion'='1' and s->>'chainId'='1' and s->>'protocol'='uniswap_v3'
    and s->>'attribution'='transaction_initiator_eoa' and s->>'confirmation'='finalized'
    and s->>'valuation'='chainlink_at_block' and s->>'unvaluedPolicy'='exclude'
    and s->>'combine' in ('all','any') and length(s->>'name') between 3 and 72
    and s->>'sellToken' in ('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    and s->'notifications'->>'inbox'='true' and jsonb_typeof(s->'notifications'->'telegram')='boolean'
    and jsonb_typeof(s->'pools')='array' and jsonb_typeof(s->'conditions')='array'
    and jsonb_array_length(s->'pools') between 1 and 2 and jsonb_array_length(s->'conditions') between 1 and 3,false) then raise exception 'Invalid supported specification'; end if;
  select count(distinct value) into n from jsonb_array_elements_text(s->'pools');
  if n<>jsonb_array_length(s->'pools') or exists(select 1 from jsonb_array_elements_text(s->'pools') p where p not in ('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640','0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8')) then raise exception 'Invalid pools'; end if;
  for c in select value from jsonb_array_elements(s->'conditions') loop
    if not coalesce(c->>'kind' in ('large_swap','repeated_selling','pool_selling'),false) then raise exception 'Invalid condition'; end if;
    if c->>'kind'='large_swap' then
      if not coalesce(c->>'usd' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$',false) then raise exception 'Invalid USD threshold'; end if;
    else
      if not coalesce(c->>'windowSeconds' ~ '^[0-9]+$' and (c->>'windowSeconds')::integer between 60 and 3600,false) then raise exception 'Invalid window'; end if;
      if c->>'kind'='pool_selling' then
        if not coalesce(c->>'cumulativeUsd' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$',false) then raise exception 'Invalid total'; end if;
      else
        if not coalesce(c->>'minSwapUsd' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$',false) then raise exception 'Invalid minimum sale'; end if;
        if c->>'count' is null and c->>'cumulativeUsd' is null then raise exception 'Count or total required'; end if;
        if c->>'count' is not null and not coalesce(c->>'count' ~ '^[0-9]+$' and (c->>'count')::integer between 2 and 100,false) then raise exception 'Invalid count'; end if;
        if c->>'cumulativeUsd' is not null and not coalesce(c->>'cumulativeUsd' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$',false) then raise exception 'Invalid cumulative value'; end if;
      end if;
    end if;
  end loop;
  if auth.uid() is not null and not public.scout_rate_limit('_durable_watch_build',5,3600) then raise exception 'Five version builds per hour allowed'; end if;
  return new;
end $$;
create trigger immutable_valid_watch_version before insert or update on public.watch_versions for each row execute function app_private.validate_watch_version();

alter table app_private.telegram_connections add column test_status text check(test_status in ('queued','sending','sent','failed','ambiguous'));
alter table app_private.telegram_connections add column test_message_id bigint;
alter table app_private.telegram_connections add column test_sent_at timestamptz;

create or replace function public.scout_telegram_action(action text, mute_minutes integer default 60) returns void
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
    if not public.scout_rate_limit('_telegram_test',3,60) then raise exception 'Test alert limit reached'; end if;
    update app_private.telegram_connections set test_status='queued',error=null where user_id=auth.uid() and test_status is distinct from 'sending';
    perform app_private.enqueue('test_alert',jsonb_build_object('userId',auth.uid()),'test:'||auth.uid()::text||':'||floor(extract(epoch from now())/60)::text);
  else raise exception 'Unsupported action'; end if;
end $$;

create function public.scout_telegram_test_status() returns jsonb language sql security definer set search_path='' as $$
select coalesce((select jsonb_build_object('status',test_status,'messageId',test_message_id::text,'sentAt',test_sent_at,'error',error) from app_private.telegram_connections where user_id=auth.uid()),'null'::jsonb);
$$;
revoke all on function public.scout_telegram_test_status() from public,anon;
grant execute on function public.scout_telegram_test_status() to authenticated;
