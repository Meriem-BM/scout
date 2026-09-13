-- Product data is intentionally empty. Replay fixtures never enter live tables.
insert into storage.buckets (id, name, public, file_size_limit)
values ('pipeline-artifacts', 'pipeline-artifacts', false, 52428800)
on conflict (id) do nothing;
