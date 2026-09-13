-- Privy is Scout's only interactive authentication surface. Remove the
-- retired self-service Supabase OTP linking path without changing existing
-- account UUIDs, watch ownership, incidents, or delivery history.
drop function if exists public.scout_link_account(text, text, uuid, text);
drop function if exists public.scout_link_attempt(text, text, text);
drop function if exists public.scout_link_begin(text, text, text, text);

drop table if exists app_private.account_link_challenges;
drop trigger if exists scout_legacy_account on auth.users;
drop function if exists app_private.remember_legacy_account();

-- Remove budgets that belonged exclusively to the deleted linking endpoint.
create or replace function public.scout_rate_limit(
  bucket text,
  maximum integer default 10,
  period_seconds integer default 60
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
  allowed_max integer;
  allowed_period integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select m, s
  into allowed_max, allowed_period
  from (values
    ('interpret', 10, 86400),
    ('investigate', 10, 86400),
    ('preview', 10, 3600),
    ('watch-save', 5, 3600),
    ('_durable_watch_build', 5, 3600),
    ('watch-action', 20, 60),
    ('incident-action', 20, 60),
    ('telegram', 5, 60),
    ('_telegram_test', 1, 60),
    ('trade-quote', 10, 60),
    ('trade-approval', 20, 60),
    ('trade-prepare', 20, 60),
    ('trade-register', 20, 60)
  ) budgets(b, m, s)
  where b = bucket;

  if allowed_max is null
    or maximum <> allowed_max
    or period_seconds <> allowed_period
  then
    raise exception 'Invalid budget';
  end if;

  insert into app_private.rate_limits(key, count, resets_at)
  values(
    auth.uid()::text || ':' || bucket,
    1,
    now() + make_interval(secs => allowed_period)
  )
  on conflict(key) do update
  set
    count = case
      when app_private.rate_limits.resets_at < now() then 1
      else app_private.rate_limits.count + 1
    end,
    resets_at = case
      when app_private.rate_limits.resets_at < now()
        then now() + make_interval(secs => allowed_period)
      else app_private.rate_limits.resets_at
    end
  returning count into n;

  return n <= allowed_max;
end
$$;
