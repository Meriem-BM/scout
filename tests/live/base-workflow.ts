import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { createClient } from "@supabase/supabase-js";

import { connectDatabase, type Job } from "@scout/database";
import { POOLS } from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";
import { IntegrationError } from "@scout/integrations/http";

import { WorkerEnv } from "../../apps/worker/src/config";
import { runPipeline } from "../../apps/worker/src/ingestion/run";
import { handleJob } from "../../apps/worker/src/jobs/handlers";

const config = WorkerEnv.parse(process.env);
const sql = connectDatabase(config.DATABASE_URL, 4);

assert(
  ["localhost", "127.0.0.1"].includes(new URL(config.DATABASE_URL).hostname),
);

const storage = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
);
const rpc = ethereum(config.ETHEREUM_RPC_URL);
const path = process.env.SCOUT_TEST_PROTOCOL === "uniswap" ? "uniswap" : "base";
const prompt =
  path === "uniswap"
    ? "Watch Uniswap V3 ETH/USDC buys above $100K from wallets that haven't traded on Uniswap before."
    : "Watch USDC transfers above $500K on Base.";
const owner = "correctness-live-" + randomUUID();
let user = randomUUID();
let watch = "";
let workflow = "";

await mkdir(".scout/evidence/correctness", { recursive: true });

try {
  if (process.env.SCOUT_RESUME_WATCH) {
    watch = process.env.SCOUT_RESUME_WATCH;
    user = (await sql`select user_id from public.watches where id=${watch}`)[0]!
      .user_id;
    await sql`update public.watches set desired_state='running' where id=${watch}`;
  } else {
    await sql`insert into app_private.accounts(id) values(${user})`;
    watch = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claim.sub',${user},true)`;

      return (await tx`select public.scout_create_watch(${prompt}) id`)[0]!
        .id as string;
    });
  }

  workflow = (
    await sql`select id from public.watch_workflows where watch_id=${watch}`
  )[0]!.id;

  // The golden test explicitly selects both supported fee tiers through the normal clarification RPC.
  const row = (
    await sql`update app_private.jobs set status='running',attempts=attempts+1,leased_by=${owner},leased_until=now()+interval '4 minutes' where kind='workflow' and payload->>'workflowId'=${workflow} returning *`
  )[0]!;
  const job: Job = {
    id: row.id,
    kind: "workflow",
    payload: row.payload,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
  };
  const timer = setInterval(() => {
    void sql`update app_private.jobs set leased_until=now()+interval '4 minutes' where id=${job.id} and leased_by=${owner}`;
  }, 30000);

  const execute = async () => {
    for (let retry = 0; retry < 4; retry++) {
      try {
        return await handleJob(
          job,
          sql,
          storage,
          rpc,
          config,
          AbortSignal.timeout(600000),
        );
      } catch (error) {
        if (
          !(error instanceof IntegrationError) ||
          !error.retryAfterSeconds ||
          retry === 3
        ) {
          throw error;
        }

        console.log(
          JSON.stringify({
            phase: "provider_retry",
            code: error.code,
            retryAfter: error.retryAfterSeconds,
          }),
        );
        await delay(Math.min(60000, error.retryAfterSeconds * 1000));
      }
    }
  };

  try {
    await execute();

    if (path === "uniswap") {
      for (let clarification = 0; clarification < 3; clarification++) {
        const question = (
          await sql`select id,field from public.watch_clarifications where workflow_id=${workflow} and status='open'`
        )[0];

        if (!question) {
          break;
        }

        const answer =
          question.field === "poolScope"
            ? "Both supported pools: " + POOLS.map((p) => p.address).join(", ")
            : ["chain", "subject.chain", "network"].includes(question.field)
              ? "Ethereum mainnet"
              : null;

        if (!answer) {
          break;
        }

        await sql.begin(async (tx) => {
          await tx`select set_config('request.jwt.claim.sub',${user},true)`;
          await tx`select public.scout_answer_clarification(${watch},${question.id},${answer})`;
        });
        await execute();
      }
    }

    await sql`update app_private.jobs set status='complete',leased_until=null where id=${job.id}`;
  } finally {
    clearInterval(timer);
  }

  console.log(
    JSON.stringify({
      phase: "workflow",
      watch,
      workflow,
      state: (
        await sql`select state,error_code,error_message from public.watch_workflows where id=${workflow}`
      )[0],
    }),
  );

  const d = (
    await sql`select id,state,proof from public.pipeline_deployments where workflow_id=${workflow}`
  )[0];

  if (d?.proof?.intentAcceptanceStatus === "INTENT_ACCEPTANCE_VERIFIED") {
    for (let attempt = 0; attempt < 2; attempt++) {
      await sql`insert into app_private.pipeline_leases(deployment_id,owner,expires_at) values(${d.id},${owner},now()+interval '3 minutes') on conflict(deployment_id) do update set owner=excluded.owner,expires_at=excluded.expires_at,generation=app_private.pipeline_leases.generation+1`;

      const signal = AbortSignal.timeout(45000);

      try {
        await runPipeline(sql, storage, rpc, config, d.id, owner, signal);
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }

      console.log(
        JSON.stringify({
          phase: attempt ? "cursor_resume" : "stream",
          checkpoint: (
            await sql`select block_number::text,updated_at from app_private.checkpoints where deployment_id=${d.id}`
          )[0],
          state: (
            await sql`select state,last_message_at from public.pipeline_deployments where id=${d.id}`
          )[0],
        }),
      );
    }
  }
} finally {
  if (watch) {
    const evidence = {
      watch,
      workflow,
      workflowState: (
        await sql`select state,error_code,error_message from public.watch_workflows where watch_id=${watch}`
      )[0],
      events:
        await sql`select sequence,type,stage,status,title,metadata from public.watch_workflow_events where watch_id=${watch} order by sequence`,
      outputs:
        await sql`select kind,payload from public.watch_workflow_outputs where workflow_id=${workflow}`,
      deployments:
        await sql`select id,state,proof,last_block::text,last_message_at from public.pipeline_deployments where watch_id=${watch}`,
      detections:
        await sql`select d.* from public.candidate_detections d join public.candidate_events e using(deployment_id,event_id) where e.watch_id=${watch}`,
      candidateCount: (
        await sql`select count(*)::int n from public.candidate_events where watch_id=${watch}`
      )[0]?.n,
      deliveryAttempted: false,
    };

    await writeFile(
      `.scout/evidence/correctness/${path}-workflow.json`,
      JSON.stringify(evidence, null, 2),
    );
    console.log(
      JSON.stringify({
        phase: "evidence",
        watch,
        events: evidence.events.length,
        candidates: evidence.candidateCount,
        detections: evidence.detections.length,
        deliveryAttempted: false,
      }),
    );
    await sql`update public.watches set desired_state='paused',status='paused' where id=${watch}`;
    await sql`delete from app_private.pipeline_leases where owner=${owner}`;
  }

  await sql.end();
}
