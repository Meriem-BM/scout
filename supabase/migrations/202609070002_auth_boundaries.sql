-- Fixed budgets for migration code issuance and verification are independent.
do $$ declare definition text; begin
 select pg_get_functiondef('public.scout_rate_limit(text,integer,integer)'::regprocedure) into definition;
 definition:=replace(definition,'''interpret'',10,86400','''account-link-send'',5,3600),(''account-link-verify'',10,3600),(''interpret'',10,86400');
 execute definition;
end $$;

create function public.scout_email_begin_for_account(destination text,token_hash text,mail_payload jsonb,use_account boolean default false) returns void language sql security definer set search_path='' as $$
 select public.scout_email_begin(auth.uid(),destination,token_hash,mail_payload,use_account);
$$;
create function public.scout_quote_save(expected_owner uuid,quote_id uuid,wallet_address text,intent_data jsonb,quote_data jsonb,quote_expires timestamptz) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or auth.uid()<>expected_owner then raise exception 'Account changed while preparing quote. Request a fresh quote'; end if;
 insert into public.transaction_intents(id,user_id,wallet,chain_id,intent,quote,expires_at)
 values(quote_id,auth.uid(),wallet_address,1,intent_data,quote_data,quote_expires);
end $$;
revoke all on function public.scout_email_begin_for_account(text,text,jsonb,boolean),public.scout_quote_save(uuid,uuid,text,jsonb,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.scout_email_begin_for_account(text,text,jsonb,boolean),public.scout_quote_save(uuid,uuid,text,jsonb,jsonb,timestamptz) to service_role;

-- Serialize account operations with account linking: a concurrent first write
-- must either precede the empty-account check or use the new resolved owner.
do $$ declare definition text; begin
 select pg_get_functiondef('public.scout_account_rpc(text,text,text,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,'uid:=app_private.privy_account(privy_subject,privy_session);','perform pg_advisory_xact_lock(hashtextextended(privy_subject,71)); uid:=app_private.privy_account(privy_subject,privy_session);');
 definition:=replace(definition,'case operation', $replacement$case operation
 when 'scout_email_begin_for_account' then perform public.scout_email_begin_for_account(args->>'destination',args->>'token_hash',args->'mail_payload',coalesce((args->>'use_account')::boolean,false));
 when 'scout_quote_save' then perform public.scout_quote_save((args->>'expected_owner')::uuid,(args->>'quote_id')::uuid,args->>'wallet_address',args->'intent_data',args->'quote_data',(args->>'quote_expires')::timestamptz);
 $replacement$);
 execute definition;
end $$;
