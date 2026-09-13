import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { createClient } from "@supabase/supabase-js";

import { connectDatabase, loadDeployment } from "@scout/database";
import {
  evaluateWatchProgram,
  type HistoricalEvidence,
  migrateExecutableProgram,
  type NormalizedOnchainEvent,
  type ProgramEvaluation,
  verifyProgramAcceptance,
} from "@scout/domain";
import { uniswapDataAdapter } from "@scout/integrations/data-adapters";
import { ethereum } from "@scout/integrations/ethereum";
import { GraphAdapter } from "@scout/integrations/graph";
import { GraphPriorActivityProvider } from "@scout/integrations/investigation-provider";
import { consume } from "@scout/integrations/substreams";

import { WorkerEnv } from "../../apps/worker/src/config";
import { withSubstreamsSession } from "../../apps/worker/src/pipeline/sessions";
import { uniswapReferencePrograms } from "../../packages/domain/src/uniswap/programs";

const config = WorkerEnv.parse(process.env);
const sql = connectDatabase(config.DATABASE_URL, 2);
const saved = JSON.parse(
  await readFile(".scout/evidence/correctness/uniswap-workflow.json", "utf8"),
);

try {
  const row = (
    await sql`select d.id,a.storage_path,a.package_sha256,a.module_name from public.pipeline_deployments d join app_private.artifacts a on a.hash=d.artifact_hash where d.watch_id=${saved.watch}`
  )[0]!;
  const deployment = await loadDeployment(sql, row.id);
  const program = migrateExecutableProgram(deployment.spec)!;

  assert(program.history.length === 1);

  const evidence = (
    await sql`select e.payload from public.incident_evidence e join public.incidents i on i.id=e.incident_id where i.watch_id=${saved.watch} order by i.created_at limit 1`
  )[0]!.payload;
  const storage = createClient(
    config.SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY,
  );
  const download = await storage.storage
    .from("pipeline-artifacts")
    .download(row.storage_path);

  if (download.error) {
    throw download.error;
  }

  const rpc = ethereum(config.ETHEREUM_RPC_URL);
  const provider = new GraphPriorActivityProvider(
    new GraphAdapter(config.GRAPH_API_KEY, config.GRAPH_SUBGRAPH_ID),
  );
  const results: Array<{
    event: NormalizedOnchainEvent;
    history: HistoricalEvidence;
    withoutContext: ProgramEvaluation;
    result: ProgramEvaluation;
  }> = [];

  await withSubstreamsSession(
    sql,
    config.SUBSTREAMS_SESSION_CAPACITY,
    "verification",
    AbortSignal.timeout(90000),
    async (signal) => {
      for await (const block of consume({
        endpoint: config.SUBSTREAMS_ENDPOINT,
        apiKey: config.SUBSTREAMS_API_KEY,
        token: config.SUBSTREAMS_API_TOKEN,
        packageBytes: new Uint8Array(await download.data.arrayBuffer()),
        startBlock: evidence.blockNumber,
        stopBlock: String(BigInt(evidence.blockNumber) + 1n),
        signal,
      })) {
        if (block.type === "undo") {
          throw new Error("Unexpected rollback");
        }

        const adapter = uniswapDataAdapter(
          rpc,
          {
            source: "substreams",
            package: row.package_sha256,
            module: row.module_name,
            decoder: "uniswap-rpc-chainlink-v1",
            pipelineVersion: deployment.id,
          },
          (code) => console.log(JSON.stringify({ diagnostic: code })),
        );

        for (const event of await adapter.normalize(block)) {
          if (event.id !== evidence.id) {
            continue;
          }

          const withoutContext = evaluateWatchProgram(program, event);

          assert.equal(withoutContext.status, "PENDING_CONTEXT");

          const history = await provider.investigate(
            program.history[0]!,
            event,
          );
          const result = evaluateWatchProgram(program, event, [], undefined, [
            history,
          ]);

          assert.equal(
            result.status,
            history.status === "FOUND"
              ? "NO_MATCH"
              : history.status === "NONE_WITH_PROVEN_COVERAGE"
                ? "MATCH"
                : "PENDING_CONTEXT",
          );
          results.push({ event, history, withoutContext, result });
        }
      }
    },
  );
  assert(results.length > 0);

  const observed = results[0]!.event;
  const references = uniswapReferencePrograms({
    kind: "pool",
    address: observed.contract,
  });
  const acceptance = verifyProgramAcceptance(
    references.buys.program!,
    observed,
    "ETH buys above $100K; controlled boundaries from real seed",
  );

  assert.equal(acceptance.finalStatus, "INTENT_ACCEPTANCE_VERIFIED");

  const realBuyDecision = evaluateWatchProgram(
    references.buys.program!,
    observed,
  );

  assert.equal(realBuyDecision.status, "MATCH");

  const contextualAcceptance = verifyProgramAcceptance(
    references.firstTimeBuys.program!,
    observed,
    "Controlled history states from real seed; not observed first-time activity",
  );

  assert.equal(contextualAcceptance.finalStatus, "INTENT_ACCEPTANCE_VERIFIED");

  const contextual = evaluateWatchProgram(
    references.firstTimeBuys.program!,
    observed,
    [observed],
    undefined,
    [{ ...results[0]!.history, requirementId: "prior_protocol" }],
  );

  assert.equal(contextual.status, "NO_MATCH");
  await writeFile(
    "docs/evidence/uniswap-integration.json",
    JSON.stringify(
      {
        mode: "REAL_SUBSTREAMS_RPC_GRAPH_WITH_SEPARATE_CONTROLLED_ACCEPTANCE",
        chainId: observed.chainId,
        block: observed.blockNumber,
        blockHash: observed.blockHash,
        transaction: observed.transactionHash,
        eventId: observed.id,
        contract: observed.contract,
        package: observed.provenance,
        realHistory: results[0]!.history.status,
        contextualDecision: contextual.status,
        realBuyDecision,
        contextualAcceptance,
        acceptance,
        scope: references.buys.scope,
        deliveryAttempted: false,
        referencesArePublicWorkflowDeployable: false,
      },
      null,
      2,
    ),
  );

  const report = {
    mode: "REAL_HISTORICAL_SUBSTREAMS_RPC_GRAPH",
    watch: deployment.watch_id,
    results,
    databaseModified: false,
    deliveryAttempted: false,
  };

  await writeFile(
    ".scout/evidence/correctness/program-uniswap.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      evaluated: results.length,
      results: results.map((r) => ({
        history: r.history.status,
        evaluation: r.result.status,
      })),
      deliveryAttempted: false,
    }),
  );
} finally {
  await sql.end();
}
