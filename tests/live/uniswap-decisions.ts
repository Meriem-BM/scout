import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { createClient } from "@supabase/supabase-js";

import { connectDatabase, loadDeployment } from "@scout/database";
import { evaluate } from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";
import { GraphAdapter } from "@scout/integrations/graph";
import { consume, normalizeBlock } from "@scout/integrations/substreams";

import { WorkerEnv } from "../../apps/worker/src/config";
import { persistBlock } from "../../apps/worker/src/ingestion/persist";
import { handleJob } from "../../apps/worker/src/jobs/handlers";
import { withSubstreamsSession } from "../../apps/worker/src/pipeline/sessions";

const config = { ...WorkerEnv.parse(process.env), GROQ_API_KEY: undefined };
const sql = connectDatabase(config.DATABASE_URL, 4);
const rpc = ethereum(config.ETHEREUM_RPC_URL);
const storage = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
);
const saved = JSON.parse(
  await readFile(".scout/evidence/correctness/uniswap-workflow.json", "utf8"),
);
const row = (
  await sql`select * from public.pipeline_deployments where watch_id=${saved.watch}`
)[0]!;
const d = await loadDeployment(sql, row.id);
const graph = new GraphAdapter(config.GRAPH_API_KEY, config.GRAPH_SUBGRAPH_ID);
const verification = saved.outputs.find(
  (x: { kind: string }) => x.kind === "verification",
).payload;
const transactions = [
  ...new Set<string>(
    verification.comparisons
      .filter(
        (c: { field: string; actual: string }) =>
          c.field.endsWith(":amount0") && BigInt(c.actual) > 100000000000n,
      )
      .map((c: { field: string }) => c.field.split(":")[0]),
  ),
];
// Include actual previously observed high-value chain evidence, without changing its actor or amount.
const old =
  await sql`select distinct payload->>'transactionHash' hash from public.incident_evidence where (payload->>'amount0')::numeric>100000000000 limit 10`;

for (const item of old) {
  if (!transactions.includes(item.hash)) {
    transactions.push(item.hash);
  }
}

const results: unknown[] = [];

try {
  const a = (
    await sql`select storage_path from app_private.artifacts where hash=${d.artifact_hash}`
  )[0]!;
  const download = await storage.storage
    .from("pipeline-artifacts")
    .download(a.storage_path);

  if (download.error) {
    throw download.error;
  }

  const bytes = new Uint8Array(await download.data.arrayBuffer());

  for (const hash of transactions.slice(0, 12)) {
    if (
      process.env.SCOUT_CONTEXT_FAULT === "1" &&
      (
        await sql`select 1 from public.incident_evidence e join public.incidents i on i.id=e.incident_id where i.watch_id=${d.watch_id} and e.payload->>'transactionHash'=${hash}`
      )[0]
    ) {
      continue;
    }

    const receipt = await rpc.getTransactionReceipt({
      hash: hash as `0x${string}`,
    });

    await withSubstreamsSession(
      sql,
      config.SUBSTREAMS_SESSION_CAPACITY,
      "verification",
      AbortSignal.timeout(60000),
      async (signal) => {
        for await (const block of consume({
          endpoint: config.SUBSTREAMS_ENDPOINT,
          apiKey: config.SUBSTREAMS_API_KEY,
          token: config.SUBSTREAMS_API_TOKEN,
          packageBytes: bytes,
          startBlock: String(receipt.blockNumber),
          stopBlock: String(receipt.blockNumber + 1n),
          signal,
        })) {
          if (block.type === "undo") {
            throw Error("undo");
          }

          const events = await normalizeBlock(block, rpc, () => {});
          const selected = events.filter(
            (e) => e.transactionHash === hash && evaluate(d.spec, e, [e]),
          );

          for (const event of selected) {
            const prior = await graph.checkPriorActivity(event);

            // Isolated use of the real persistence/enrichment path; no external destinations are added.
            await sql.begin(async (transaction) => {
              const tx = new Proxy(transaction, {
                get(target, key) {
                  return key === "begin"
                    ? target.savepoint.bind(target)
                    : Reflect.get(target, key);
                },
              }) as unknown as typeof sql;

              await tx`update public.watches set desired_state='running' where id=${d.watch_id}`;
              await tx`insert into app_private.pipeline_leases(deployment_id,owner,expires_at) values(${d.id},'real-history-acceptance',now()+interval '5 minutes') on conflict(deployment_id) do update set owner=excluded.owner,expires_at=excluded.expires_at`;
              await tx`delete from app_private.checkpoints where deployment_id=${d.id}`;
              await persistBlock(
                tx,
                d,
                "real-history-acceptance",
                block,
                [event],
                false,
                String(receipt.blockNumber + 50n),
              );

              const incident = (
                await tx`select id from public.incidents where watch_id=${d.watch_id} and detection->>'initiator'=${event.initiator} order by created_at desc limit 1`
              )[0];

              assert(incident);

              let pendingEvidence: unknown = null;

              if (process.env.SCOUT_CONTEXT_FAULT === "1") {
                await handleJob(
                  {
                    id: incident.id,
                    kind: "enrich",
                    payload: { incidentId: incident.id },
                    attempts: 1,
                    max_attempts: 3,
                  },
                  tx,
                  storage,
                  rpc,
                  {
                    ...config,
                    GRAPH_API_KEY: "acceptance-intentionally-invalid",
                  },
                  signal,
                );
                pendingEvidence = (
                  await tx`select status,next_attempt_at,evidence from public.investigation_decisions where incident_id=${incident.id}`
                )[0];
                assert.equal(
                  (pendingEvidence as { status: string }).status,
                  "PENDING",
                );
                assert.equal(
                  (
                    await tx`select count(*)::int n from public.notification_deliveries where incident_id=${incident.id}`
                  )[0]!.n,
                  0,
                );
              }

              await handleJob(
                {
                  id: incident.id,
                  kind: "enrich",
                  payload: { incidentId: incident.id },
                  attempts: 1,
                  max_attempts: 3,
                },
                tx,
                storage,
                rpc,
                config,
                signal,
              );

              const decision = (
                await tx`select status,evidence from public.investigation_decisions where incident_id=${incident.id}`
              )[0];

              results.push({
                eventId: event.id,
                actor: event.initiator,
                value: event.valuation?.usdMicros,
                prior,
                decision,
                pendingEvidence,
                delivery: (
                  await tx`select delivery from public.incidents where id=${incident.id}`
                )[0],
                deliveryAttempted: false,
              });
              // Test Watch remains isolated; real evidence/decisions are retained, no live checkpoint claim is made.
              await tx`update public.watches set desired_state='paused',status='paused' where id=${d.watch_id}`;
              await tx`delete from app_private.pipeline_leases where deployment_id=${d.id}`;
            });
          }
        }
      },
    );
    console.log(JSON.stringify({ checked: hash, results }));

    if (results.length >= (process.env.SCOUT_CONTEXT_FAULT === "1" ? 1 : 3)) {
      break;
    }
  }

  await writeFile(
    `.scout/evidence/correctness/${process.env.SCOUT_CONTEXT_FAULT === "1" ? "uniswap-context-retry" : "uniswap-decisions"}.json`,
    JSON.stringify(
      {
        mode: "REAL_HISTORICAL_SUBSTREAMS_GRAPH_DATABASE",
        watch: d.watch_id,
        results,
        deliveryAttempted: false,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end();
}
