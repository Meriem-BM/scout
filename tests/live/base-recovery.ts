import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import { createClient } from "@supabase/supabase-js";

import { connectDatabase } from "@scout/database";
import { BASE_USDC, TRANSFER_SIGNATURE } from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";
import { consumeOutput } from "@scout/integrations/substreams";

import { WorkerEnv } from "../../apps/worker/src/config";
import { runPipeline } from "../../apps/worker/src/ingestion/run";
import { withSubstreamsSession } from "../../apps/worker/src/pipeline/sessions";

const config = WorkerEnv.parse(process.env);
const sql = connectDatabase(config.DATABASE_URL, 4);
const evidence = JSON.parse(
  await readFile(".scout/evidence/correctness/base-workflow.json", "utf8"),
);

assert(
  ["localhost", "127.0.0.1"].includes(new URL(config.DATABASE_URL).hostname),
);

const d = (
  await sql`select d.id from public.pipeline_deployments d join public.watches w on w.id=d.watch_id where w.id=${evidence.watch} and d.proof->>'strategy'='PARAMETERIZE'`
)[0]!;
const owner = "base-recovery-" + process.pid;

try {
  if (process.argv.includes("--child")) {
    await sql`insert into app_private.pipeline_leases(deployment_id,owner,expires_at) values(${d.id},${owner},now()+interval '5 minutes') on conflict(deployment_id) do update set owner=excluded.owner,expires_at=excluded.expires_at,generation=app_private.pipeline_leases.generation+1`;

    const stop = new AbortController();

    process.on("SIGTERM", () => stop.abort());

    try {
      await runPipeline(
        sql,
        createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
        ethereum(config.ETHEREUM_RPC_URL),
        config,
        d.id,
        owner,
        stop.signal,
      );
    } catch (error) {
      if (!stop.signal.aborted) {
        throw error;
      }
    }
  } else {
    // Re-execute this isolated acceptance Watch's verified historical range after fixing catch-up evaluation.
    // No production Watch is rewound. The second child resumes the cursor without a reset.
    await sql`update public.watches set desired_state='running' where id=${evidence.watch}`;

    const positive = JSON.parse(
      await readFile(".scout/evidence/correctness/base-positive.json", "utf8"),
    );
    const before = BigInt(positive.block) - 1n;

    await withSubstreamsSession(
      sql,
      config.SUBSTREAMS_SESSION_CAPACITY,
      "verification",
      AbortSignal.timeout(120000),
      async (signal) => {
        for await (const block of consumeOutput({
          endpoint: config.BASE_SUBSTREAMS_ENDPOINT,
          apiKey: config.SUBSTREAMS_API_KEY,
          token: config.SUBSTREAMS_API_TOKEN,
          packageBytes: await readFile(
            "substreams/vendor/ethereum-common.spkg",
          ),
          network: "base",
          outputModule: "filtered_events",
          parameters: [
            {
              module: "filtered_events",
              name: "query",
              value: `evt_addr:${BASE_USDC} && evt_sig:${TRANSFER_SIGNATURE}`,
            },
          ],
          startBlock: String(before),
          stopBlock: positive.block,
          signal,
        })) {
          if (block.type === "undo") {
            throw new Error("Unexpected undo");
          }

          await sql`insert into app_private.checkpoints(deployment_id,cursor,block_number,block_hash,block_time) values(${d.id},${block.cursor},${block.number},${block.hash},to_timestamp(${block.timestamp})) on conflict(deployment_id) do update set cursor=excluded.cursor,block_number=excluded.block_number,block_hash=excluded.block_hash,block_time=excluded.block_time,updated_at=now()`;
        }
      },
    );

    const snapshots = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "tests/live/base-recovery.ts", "--child"],
          { env: process.env, stdio: "inherit" },
        );
        const timer = setTimeout(
          () => child.kill("SIGTERM"),
          attempt ? 20000 : 45000,
        );

        child.on("error", reject);
        child.on("exit", (code) => {
          clearTimeout(timer);

          if (code === 0) {
            resolve();
          } else {
            reject(Error("Child exited " + code));
          }
        });
      });
      snapshots.push({
        attempt,
        checkpoint: (
          await sql`select block_number::text,updated_at from app_private.checkpoints where deployment_id=${d.id}`
        )[0],
        counts: (
          await sql`select count(*)::int candidates,count(*) filter(where (envelope->'value'->>'usdMicros')::numeric>500000000000)::int above,count(*) filter(where (envelope->'value'->>'usdMicros')::numeric<=500000000000)::int below,(select count(*)::int from public.candidate_detections where deployment_id=${d.id}) detections from public.candidate_events where deployment_id=${d.id}`
        )[0],
      });
    }

    const wrong = (
      await sql`select count(*)::int n from public.candidate_detections d join public.candidate_events e using(deployment_id,event_id) where d.deployment_id=${d.id} and (e.envelope->'value'->>'usdMicros')::numeric<=500000000000`
    )[0]!.n;

    console.log(JSON.stringify({ snapshots, wrong }));
    assert.equal(wrong, 0);
    assert(snapshots[1]!.counts!.detections > 0);

    const report = {
      watch: evidence.watch,
      deployment: d.id,
      snapshots,
      belowThresholdDetections: wrong,
      duplicateProtection:
        "Database primary keys; repeated historical input and a separate-process cursor resume",
      deliveryAttempted: false,
    };

    await writeFile(
      ".scout/evidence/correctness/base-recovery.json",
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
} finally {
  await sql`delete from app_private.pipeline_leases where owner=${owner}`;

  if (!process.argv.includes("--child")) {
    await sql`update public.watches set desired_state='paused',status='paused' where id=${evidence.watch}`;
  }

  await sql.end();
}
