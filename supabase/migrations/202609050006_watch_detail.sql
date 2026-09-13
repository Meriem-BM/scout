
create function public.scout_watch_detail(watch_id uuid) returns jsonb language sql security definer set search_path='' as $$
 select app_private.watch_json(w) from public.watches w where id=watch_id and user_id=auth.uid();
$$;
revoke all on function public.scout_watch_detail(uuid) from public,anon;
grant execute on function public.scout_watch_detail(uuid) to authenticated;
