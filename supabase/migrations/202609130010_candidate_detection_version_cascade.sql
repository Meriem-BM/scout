-- Detections are derived from a Watch version. Deleting the version or account
-- must not be blocked by leftover candidate rows.
alter table public.candidate_detections
  drop constraint candidate_detections_rule_version_fkey;
alter table public.candidate_detections
  add constraint candidate_detections_rule_version_fkey
  foreign key (rule_version) references public.watch_versions(id) on delete cascade;
