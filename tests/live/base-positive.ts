import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { connectDatabase } from "@scout/database";
import {
  BASE_USDC,
  type CandidateEvent,
  Erc20WatchSpecSchema,
  evaluateTransfer,
  TRANSFER_SIGNATURE,
} from "@scout/domain";
import {
  baseRpc,
  normalizeTransfers,
  transferAbi,
} from "@scout/integrations/erc20";
import { consumeOutput } from "@scout/integrations/substreams";

import { WorkerEnv } from "../../apps/worker/src/config";
import { persistCandidate } from "../../apps/worker/src/ingestion/candidates";
import { withSubstreamsSession } from "../../apps/worker/src/pipeline/sessions";

const config = WorkerEnv.parse(process.env);
const rpc = baseRpc(config.BASE_RPC_URL);
const sql = connectDatabase(config.DATABASE_URL, 2);
const previous = JSON.parse(
  await readFile(".scout/evidence/correctness/base-workflow.json", "utf8"),
);

try {
  const d = (
    await sql`select d.*,v.spec from public.pipeline_deployments d join public.watch_versions v on v.id=d.version_id where d.watch_id=${previous.watch}`
  )[0]!;
  const spec = Erc20WatchSpecSchema.parse(d.spec);
  const head = await rpc.getBlock({ blockTag: "finalized" });
  let target: bigint | undefined;

  for (let range = 0; range < 20; range++) {
    const to = head.number - BigInt(range * 100);
    const from = to - 99n;
    const logs = await rpc.getLogs({
      address: BASE_USDC,
      event: transferAbi,
      fromBlock: from,
      toBlock: to,
    });
    const match = logs.find((log) => (log.args.value ?? 0n) > 500000000000n);

    console.log(
      JSON.stringify({
        phase: "reference_search",
        from: String(from),
        to: String(to),
        logs: logs.length,
        found: !!match,
      }),
    );

    if (match) {
      target = match.blockNumber!;
      break;
    }
  }

  assert(
    target !== undefined,
    "No positive event found in the bounded real reference range",
  );

  const events: CandidateEvent[] = [];

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
        packageBytes: await readFile("substreams/vendor/ethereum-common.spkg"),
        network: "base",
        outputModule: "filtered_events",
        parameters: [
          {
            module: "filtered_events",
            name: "query",
            value: `evt_addr:${BASE_USDC} && evt_sig:${TRANSFER_SIGNATURE}`,
          },
        ],
        startBlock: String(target),
        stopBlock: String(target! + 1n),
        signal,
      })) {
        if (block.type === "undo") {
          throw Error("undo");
        }

        events.push(...(await normalizeTransfers(block, rpc)));
      }
    },
  );

  const selected = events.filter((e) => evaluateTransfer(spec, e));

  assert(selected.length > 0);

  for (let replay = 0; replay < 2; replay++) {
    await sql.begin(async (tx) => {
      for (const e of events) {
        await persistCandidate(
          tx as unknown as typeof sql,
          {
            id: d.id,
            watch_id: d.watch_id,
            user_id: d.user_id,
            version_id: d.version_id,
          },
          e,
          evaluateTransfer(spec, e),
        );
      }
    });
  }

  const counts = (
    await sql`select count(*)::int n from public.candidate_detections where deployment_id=${d.id} and event_id=any(${selected.map((e) => e.id)})`
  )[0]!;

  assert.equal(counts.n, selected.length);

  const below = events.filter((e) => !evaluateTransfer(spec, e));

  assert.equal(
    (
      await sql`select count(*)::int n from public.candidate_detections where deployment_id=${d.id} and event_id=any(${below.map((e) => e.id)})`
    )[0]!.n,
    0,
  );

  const normalized = (
    await sql`select count(*)::int n from public.watch_findings where version_id=${d.version_id} and anchor_event_id=any(${selected.map((e) => e.id)})`
  )[0]!;

  assert.equal(normalized.n, selected.length);

  const report = {
    mode: "REAL_HISTORICAL_SUBSTREAMS_TO_DATABASE",
    watch: d.watch_id,
    deployment: d.id,
    block: String(target),
    observed: events.length,
    positive: selected,
    belowThreshold: below.length,
    detections: counts.n,
    genericFindings: normalized.n,
    replays: 2,
    deliveryAttempted: false,
  };

  await writeFile(
    process.env.SCOUT_EVIDENCE_OUTPUT ??
      ".scout/evidence/correctness/base-positive.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      block: String(target),
      observed: events.length,
      detections: counts.n,
      genericFindings: normalized.n,
      below: below.length,
      deliveryAttempted: false,
    }),
  );
} finally {
  await sql.end();
}
