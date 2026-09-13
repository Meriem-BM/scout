update public.pipeline_build_attempts
set error_code = 'PROVIDER_TIMEOUT'
where error_code = 'BUILD_OR_VERIFICATION_FAILED'
  and diagnostics ->> 'message' ~* 'aborted due to timeout|operation timed out|provider timeout';

update public.pipeline_build_attempts
set error_code = 'RPC_RATE_LIMIT'
where error_code = 'BUILD_OR_VERIFICATION_FAILED'
  and diagnostics ->> 'message' ~* 'rate limit|too many requests|status: 429';
