-- One explicit test request per minute; do not reset a completed deduplicated job to queued.
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
    if not public.scout_rate_limit('_telegram_test',1,60) then raise exception 'Wait one minute before requesting another test'; end if;
    if exists(select 1 from app_private.telegram_connections where user_id=auth.uid() and test_status='sending') then raise exception 'A test is already being sent'; end if;
    update app_private.telegram_connections set test_status='queued',test_message_id=null,test_sent_at=null,error=null where user_id=auth.uid();
    perform app_private.enqueue('test_alert',jsonb_build_object('userId',auth.uid()),'test:'||auth.uid()::text||':'||floor(extract(epoch from now())/60)::text);
  else raise exception 'Unsupported action'; end if;
end $$;
