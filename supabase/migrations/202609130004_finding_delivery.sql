alter table public.watch_findings add constraint finding_owner_identity unique(id,user_id);
create table public.finding_decisions (
  finding_id uuid primary key references public.watch_findings(id) on delete cascade,
  status text not null check(status in ('PENDING','ALERT','SUPPRESS')),
  evidence jsonb not null,
  legacy_incident_id uuid references public.incidents(id) on delete set null,
  updated_at timestamptz not null default now()
);
create function app_private.fence_finding_decision() returns trigger language plpgsql set search_path='' as $$
begin
  if old.status<>'PENDING' then raise exception 'A final finding decision is immutable'; end if;
  return new;
end $$;
create trigger immutable_finding_decision before update on public.finding_decisions for each row execute function app_private.fence_finding_decision();
alter table public.finding_decisions enable row level security;
create policy own_finding_decision on public.finding_decisions for select using(exists(select 1 from public.watch_findings f where f.id=finding_id and f.user_id=auth.uid()));
revoke all on public.finding_decisions from anon,authenticated;
grant select on public.finding_decisions to authenticated;
grant all on public.finding_decisions to service_role;

-- Reuse the existing delivery and email outbox, rather than adding a second dispatcher.
alter table public.notification_deliveries add column finding_id uuid;
alter table public.notification_deliveries add constraint delivery_finding_owner foreign key(finding_id,user_id) references public.watch_findings(id,user_id) on delete cascade;
alter table public.notification_deliveries add constraint one_delivery_subject check(incident_id is null or finding_id is null);
alter table public.notification_deliveries add constraint finding_channel unique(finding_id,channel);
alter table app_private.email_outbox drop constraint email_outbox_kind_check;
alter table app_private.email_outbox add constraint email_outbox_kind_check check(kind in ('incident','finding','verification','test'));
