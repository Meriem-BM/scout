-- Keep card summaries bounded to the visible page, including old archived watches.
create or replace function public.scout_watches_page(page_offset integer default 0, search_text text default '', status_filter text default 'all', sort_order text default 'newest') returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(value),'[]'::jsonb) from (select app_private.watch_json(w) || jsonb_build_object('recentIncidents',coalesce((select jsonb_agg(app_private.incident_json(i) || '{"context":null,"explanation":null}'::jsonb order by i.created_at desc,i.id) from (select * from public.incidents where watch_id=w.id and user_id=auth.uid() order by created_at desc,id limit 6) i),'[]'::jsonb)) value from public.watches w join public.watch_versions v on v.id=coalesce(w.active_version_id,w.pending_version_id)
 where w.user_id=auth.uid() and ((v.spec->>'name') ilike '%'||left(search_text,100)||'%') and
 (case status_filter when 'archived' then w.status='archived' when 'all' then w.status<>'archived' when 'watching' then w.status in ('watching','delayed') when 'attention' then w.status in ('failed','delayed') or w.error is not null else w.status=status_filter end)
 order by case when sort_order='name' then (v.spec->>'name') end asc,case when sort_order='oldest' then w.created_at end asc,w.created_at desc,w.id
 limit 21 offset greatest(0,least(page_offset,100000))) q;
$$;

create or replace function public.scout_snapshot() returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object(
 'watches',coalesce((select jsonb_agg(value) from (select app_private.watch_json(w) value from public.watches w where w.user_id=auth.uid() order by (w.status='archived'),w.created_at desc limit 100) q),'[]'::jsonb),
 'incidents',coalesce((select jsonb_agg(app_private.incident_json(i)) from (select latest.* from (select id from public.watches where user_id=auth.uid() order by (status='archived'),created_at desc limit 100) w cross join lateral (select * from public.incidents where watch_id=w.id and user_id=auth.uid() order by created_at desc,id limit 1) latest) i),'[]'::jsonb),
 'telegram',coalesce((select jsonb_build_object('connected',true,'label',label,'mutedUntil',muted_until,'error',error) from app_private.telegram_connections where user_id=auth.uid()),'{"connected":false,"label":null,"mutedUntil":null,"error":null}'::jsonb),
 'emailConnection',jsonb_build_object('address',(select address from app_private.email_connections where user_id=auth.uid()),
 'verified',exists(select 1 from app_private.email_connections where user_id=auth.uid()),
 'enabled',coalesce((select enabled from app_private.email_connections where user_id=auth.uid()),false),
 'suppressed',coalesce((select suppressed from app_private.email_connections where user_id=auth.uid()),false),
 'error',(select error from app_private.email_connections where user_id=auth.uid()),
 'pendingAddress',(select address from app_private.email_verifications where user_id=auth.uid() and consumed_at is null),
 'expiresAt',(select expires_at from app_private.email_verifications where user_id=auth.uid() and consumed_at is null),
 'lastStatus',(select status from public.notification_deliveries where user_id=auth.uid() and channel='email' and destination=coalesce((select address from app_private.email_connections where user_id=auth.uid()),(select address from app_private.email_verifications where user_id=auth.uid() and consumed_at is null)) order by created_at desc limit 1),
 'lastSentAt',(select sent_at from public.notification_deliveries where user_id=auth.uid() and channel='email' and destination=coalesce((select address from app_private.email_connections where user_id=auth.uid()),(select address from app_private.email_verifications where user_id=auth.uid() and consumed_at is null)) order by created_at desc limit 1)),
 'preferences',coalesce((select jsonb_build_object('timezone',timezone,'telegram',telegram,'email',email,'cooldownSeconds',cooldown_seconds) from public.account_preferences where user_id=auth.uid()),'{"timezone":"UTC","telegram":true,"email":false,"cooldownSeconds":900}'::jsonb),
 'worker',jsonb_build_object('online',exists(select 1 from app_private.worker_heartbeats where last_seen>now()-interval '45 seconds'),'lastSeen',(select max(last_seen) from app_private.worker_heartbeats))
 ) where auth.uid() is not null;
$$;
