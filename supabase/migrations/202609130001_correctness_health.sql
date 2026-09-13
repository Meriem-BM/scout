-- Fence direct Watch/build-attempt mutations as well as their workflow outputs.
create trigger fence_watch before insert or update on public.watches for each row execute function app_private.fence_workflow_write();
create trigger fence_build_attempt before insert or update on public.pipeline_build_attempts for each row execute function app_private.fence_workflow_write();

create or replace function app_private.watch_json(w public.watches)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', w.id,
    'name', coalesce(v.spec ->> 'name', w.name),
    'prompt', coalesce(v.prompt, f.original_prompt, ''),
    'spec', case
      when v.spec is null then null
      else jsonb_set(
        v.spec,
        '{notifications}',
        coalesce(
          w.destination_overrides || '{"inbox":true,"useDefaults":false}'::jsonb,
          jsonb_build_object(
            'inbox', true,
            'telegram', coalesce(p.telegram, true),
            'email', coalesce(p.email, false),
            'useDefaults', true
          )
        )
      )
    end,
    'executableSpec', v.spec,
    'intent', (
      select case
        when o.payload ? 'version'
          and o.payload ? 'subject'
          and o.payload ? 'activity'
          and o.payload ? 'temporal'
        then o.payload
        else null
      end
      from public.watch_workflow_outputs o
      where o.workflow_id = f.id
        and o.kind = 'intent'
    ),
    'status', case when w.status='watching' and not exists (
      select 1 from public.pipeline_deployments d where d.version_id=w.active_version_id and d.state='watching'
      and d.last_message_at>now()-interval '3 minutes' and d.last_block_time>now()-interval '20 minutes'
    ) then 'delayed' else w.status end,
    'workflowId', f.id,
    'workflowStage', f.state,
    'workflowUpdatedAt', f.updated_at,
    'version', coalesce(v.version, 0),
    'pendingVersion', (
      select version
      from public.watch_versions
      where id = w.pending_version_id
    ),
    'createdAt', w.created_at,
    'lastBlock', w.last_block::text,
    'lastBlockTime', w.last_block_time,
    'lastMessageAt', (select d.last_message_at from public.pipeline_deployments d where d.version_id=w.active_version_id),
    'error', coalesce(w.error, f.error_message),
    'mutedUntil', w.muted_until,
    'lastEventAt', w.last_event_at
  )
  from (select 1) seed
  left join public.watch_versions v
    on v.id = coalesce(w.active_version_id, w.pending_version_id)
  left join public.account_preferences p
    on p.user_id = w.user_id
  left join public.watch_workflows f
    on f.watch_id = w.id;
$$;
