-- A program and its finding must belong to the same immutable Watch version/owner.
alter table public.watch_versions add constraint version_watch_owner unique(id,watch_id,user_id);
alter table public.watch_programs add constraint program_version_owner foreign key(version_id,watch_id,user_id) references public.watch_versions(id,watch_id,user_id) on delete cascade;
alter table public.watch_programs add constraint program_watch_owner unique(version_id,watch_id,user_id);
alter table public.watch_findings add constraint finding_program_owner foreign key(version_id,watch_id,user_id) references public.watch_programs(version_id,watch_id,user_id);
create trigger immutable_normalized_event before update on app_private.normalized_events for each row execute function app_private.immutable_monitoring_record();
create trigger immutable_normalized_asset before update on app_private.normalized_assets for each row execute function app_private.immutable_monitoring_record();
create index program_events_event on app_private.program_events(event_id);
create index finding_events_event on public.finding_events(event_id);
