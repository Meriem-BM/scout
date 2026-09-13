-- Generic programs are validated again at build and runtime admission.
create or replace function app_private.validate_watch_version() returns trigger language plpgsql set search_path='' as $$
declare s jsonb:=new.spec; c jsonb; n integer;
begin
  if tg_op='UPDATE' then raise exception 'Watch versions are immutable'; end if;
  if s->>'protocol'='program' then
    if not coalesce(s->>'schemaVersion'='1' and length(s->>'name') between 3 and 72
      and s->'program'->>'version'='1' and jsonb_typeof(s->'program'->'source')='object'
      and jsonb_typeof(s->'program'->'metrics')='array' and jsonb_array_length(s->'program'->'metrics')>0
      and s->'program'->>'decision'='alert_on_match' and s->'notifications'->>'inbox'='true', false)
    then raise exception 'Invalid executable WatchProgram envelope'; end if;
    if auth.uid() is not null and not public.scout_rate_limit('_durable_watch_build',5,3600) then raise exception 'Five version builds per hour allowed'; end if;
    return new;
  end if;
  if s ? 'streamDirection' and not coalesce(s->>'streamDirection' in ('selected','either'),false) then raise exception 'Invalid stream direction'; end if;
  if tg_op='UPDATE' then raise exception 'Watch versions are immutable'; end if;
  if s->>'protocol'='erc20' then
    if not coalesce(s->>'schemaVersion'='1' and s->>'chainId'='8453' and s->>'token'='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      and s->>'confirmation'='finalized' and s->>'valuation'='nominal_usdc'
      and s->>'thresholdMicros' ~ '^[0-9]{1,78}$' and s->>'operator' in ('gt','gte')
      and length(s->>'name') between 3 and 72 and s->'notifications'->>'inbox'='true'
      and jsonb_typeof(s->'notifications'->'telegram')='boolean'
      and jsonb_typeof(s->'notifications'->'email')='boolean'
      and jsonb_typeof(s->'notifications'->'useDefaults')='boolean',false) then raise exception 'Invalid ERC20 executable specification'; end if;
    if auth.uid() is not null and not public.scout_rate_limit('_durable_watch_build',5,3600) then raise exception 'Five version builds per hour allowed'; end if;
    return new;
  end if;

  if not coalesce(s->>'schemaVersion'='1' and s->>'chainId'='1' and s->>'protocol'='uniswap_v3'
    and s->>'attribution'='transaction_initiator_eoa' and s->>'confirmation'='finalized'
    and s->>'valuation'='chainlink_at_block' and s->>'unvaluedPolicy'='exclude'
    and s->>'combine' in ('all','any') and length(s->>'name') between 3 and 72
    and s->>'sellToken' in ('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    and s->'notifications'->>'inbox'='true' and jsonb_typeof(s->'notifications'->'telegram')='boolean'
    and jsonb_typeof(s->'pools')='array' and jsonb_typeof(s->'conditions')='array'
    and jsonb_array_length(s->'pools') between 1 and 2 and jsonb_array_length(s->'conditions') between 1 and 3,false) then raise exception 'Invalid supported specification'; end if;
  select count(distinct value) into n from jsonb_array_elements_text(s->'pools');
  if n<>jsonb_array_length(s->'pools') or exists(select 1 from jsonb_array_elements_text(s->'pools') p where p not in ('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640','0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8')) then raise exception 'Invalid pools'; end if;
  for c in select value from jsonb_array_elements(s->'conditions') loop
    if not coalesce(c->>'kind' in ('large_swap','repeated_selling','pool_selling','aggregate'),false) then raise exception 'Invalid condition'; end if;
    if c->>'kind'='aggregate' then
      if not app_private.valid_swap_runtime_rule(c->'rule') or not coalesce(length(c->>'description') between 1 and 300,false) then raise exception 'Invalid runtime rule'; end if;
    elsif c->>'kind'='large_swap' then
      if not coalesce(c->>'usd' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$',false) then raise exception 'Invalid USD threshold'; end if;
    else
      if not coalesce(c->>'windowSeconds' ~ '^[0-9]+$' and (c->>'windowSeconds')::integer between 60 and 3600,false) then raise exception 'Invalid window'; end if;
      if c->>'kind'='pool_selling' then
        if not coalesce(c->>'cumulativeUsd' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$',false) then raise exception 'Invalid total'; end if;
      else
        if not coalesce(c->>'minSwapUsd' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$',false) then raise exception 'Invalid minimum sale'; end if;
        if c->>'count' is null and c->>'cumulativeUsd' is null then raise exception 'Count or total required'; end if;
        if c->>'count' is not null and not coalesce(c->>'count' ~ '^[0-9]+$' and (c->>'count')::integer between 2 and 100,false) then raise exception 'Invalid count'; end if;
        if c->>'cumulativeUsd' is not null and not coalesce(c->>'cumulativeUsd' ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$',false) then raise exception 'Invalid cumulative value'; end if;
      end if;
    end if;
  end loop;
  if auth.uid() is not null and not public.scout_rate_limit('_durable_watch_build',5,3600) then raise exception 'Five version builds per hour allowed'; end if;
  return new;
end $$;
