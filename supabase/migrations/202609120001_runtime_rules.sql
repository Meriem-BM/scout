-- Preserve the existing immutable version boundary while admitting bounded runtime rules.
create function app_private.valid_swap_runtime_rule(r jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare p jsonb; f text; duration integer; baseline_duration integer:=0;
begin
  if not coalesce(jsonb_typeof(r)='object'
    and r->>'id' ~ '^[a-zA-Z][a-zA-Z0-9_]{0,63}$'
    and r->>'threshold' ~ '^[0-9]{1,78}$'
    and r->>'operator' in ('gt','gte','lt','lte','eq')
    and r->>'windowSeconds' ~ '^[0-9]{1,5}$'
    and jsonb_typeof(r->'groupBy')='array'
    and jsonb_typeof(r->'predicates')='array'
    and jsonb_typeof(r->'aggregate')='object'
    and r->'aggregate'->>'operation' in ('sum','count','distinct')
    and r ? 'baseline',false) then return false; end if;
  duration:=(r->>'windowSeconds')::integer;
  if duration not between 1 and 7200 or jsonb_array_length(r->'groupBy') not between 1 and 4
    or not r->'groupBy' @> '["pool"]'::jsonb or jsonb_array_length(r->'predicates')>20 then return false; end if;
  for f in select value from jsonb_array_elements_text(r->'groupBy') loop
    if f is null or f not in ('pool','participant','transaction','soldToken','usdMicros') then return false; end if;
  end loop;
  if r->'aggregate'->>'operation'='sum' and (r->'aggregate'->>'field') is distinct from 'usdMicros' then return false; end if;
  if r->'aggregate'->>'operation'='distinct' and not coalesce(r->'aggregate'->>'field' in ('pool','participant','transaction','soldToken','usdMicros'),false) then return false; end if;
  for p in select value from jsonb_array_elements(r->'predicates') loop
    if not coalesce(p->>'field' in ('pool','participant','transaction','soldToken','usdMicros'),false) then return false; end if;
    if p->>'kind'='numeric' then
      if not coalesce(p->>'field'='usdMicros' and p->>'operator' in ('gt','gte','lt','lte','eq') and p->>'value' ~ '^[0-9]{1,78}$',false) then return false; end if;
    elsif p->>'kind'='field' then
      if jsonb_typeof(p->'values') is distinct from 'array' then return false; end if;
      if jsonb_array_length(p->'values') not between 1 and 100 or exists(select 1 from jsonb_array_elements(p->'values') v where jsonb_typeof(v)<>'string' or length(v#>>'{}')>250) then return false; end if;
    else return false;
    end if;
  end loop;
  if r->'baseline'<>'null'::jsonb then
    if not coalesce(jsonb_typeof(r->'baseline')='object'
      and r->'baseline'->>'windowSeconds' ~ '^[0-9]{1,5}$'
      and r->'baseline'->>'multiplierMicros' ~ '^[0-9]{1,78}$'
      and r->'baseline'->>'minimum' ~ '^[0-9]{1,78}$',false) then return false; end if;
    baseline_duration:=(r->'baseline'->>'windowSeconds')::integer;
    if baseline_duration<1 or (r->'baseline'->>'multiplierMicros')::numeric<=0 or (r->'baseline'->>'minimum')::numeric<=0 then return false; end if;
  end if;
  return duration+baseline_duration<=7200;
end $$;
revoke all on function app_private.valid_swap_runtime_rule(jsonb) from public,anon,authenticated;

-- Defense in depth for direct authenticated RPC calls, not only the web's Zod boundary.
create or replace function app_private.validate_watch_version() returns trigger language plpgsql set search_path='' as $$
declare s jsonb:=new.spec; c jsonb; n integer;
begin
  if s ? 'streamDirection' and not coalesce(s->>'streamDirection' in ('selected','either'),false) then raise exception 'Invalid stream direction'; end if;
  if tg_op='UPDATE' then raise exception 'Watch versions are immutable'; end if;
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
