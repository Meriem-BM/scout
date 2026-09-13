-- Preserve legacy contracts while admitting validated, immutable WatchProgram versions.
alter table public.watch_versions drop constraint watch_versions_spec_check;
alter table public.watch_versions add constraint watch_versions_spec_check check(coalesce(
  jsonb_typeof(spec)='object' and (
    (spec->>'protocol'='program' and spec->>'schemaVersion'='1'
      and jsonb_typeof(spec->'program')='object' and spec->'program'->>'version'='1')
    or (spec->>'confirmation'='finalized' and (
      (spec->>'chainId'='1' and spec->>'protocol'='uniswap_v3') or
      (spec->>'chainId'='8453' and spec->>'protocol'='erc20' and spec->>'token'='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' and spec->>'valuation'='nominal_usdc' and spec->>'thresholdMicros' ~ '^[0-9]+$' and spec->>'operator' in ('gt','gte'))
    ))
  ),false
));
