create or replace function app_private.incident_json(i public.incidents, full_evidence boolean default false) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',i.id,'watchId',i.watch_id,'title',i.title,'createdAt',i.created_at,'updatedAt',i.updated_at,
 'deliveryStates',coalesce((select jsonb_agg(jsonb_build_object('channel',channel,'status',status)) from public.notification_deliveries where incident_id=i.id),'[]'::jsonb),
 'read',i.read_at is not null,'status',i.status,'detection',i.detection,'spec',v.spec,'context',i.context,'explanation',i.explanation,'delivery',i.delivery,
 'evidence',case when full_evidence then coalesce((select jsonb_agg(e.payload order by e.payload->>'timestamp',e.event_id) from public.incident_evidence e where e.incident_id=i.id),'[]'::jsonb) else '[]'::jsonb end)
 from public.watch_versions v where v.id=i.version_id;
$$;
