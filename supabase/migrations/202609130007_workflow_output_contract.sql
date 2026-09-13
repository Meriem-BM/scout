-- Keep output-kind validation in the table constraint so new compiler outputs
-- cannot be accepted by persistence but rejected by its write function.
create or replace function app_private.put_workflow_output(workflow uuid, output_kind text, output_payload jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into public.watch_workflow_outputs(workflow_id,kind,payload) values(workflow,output_kind,output_payload)
  on conflict(workflow_id,kind) do update set payload=excluded.payload,schema_version=public.watch_workflow_outputs.schema_version+1,updated_at=now();
end $$;
