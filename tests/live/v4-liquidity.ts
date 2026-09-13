import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import { z } from "zod";

import { connectDatabase } from "@scout/database";
import {
  compileV4LiquidityProgram,
  evaluateWatchProgram,
  V4_PACKAGE,
  V4_PACKAGE_URL,
  V4_POOL_MANAGER,
} from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";
import { consumeOutput } from "@scout/integrations/substreams";
import { downloadPackage } from "@scout/integrations/substreams-registry";
import {
  ModifyLiquiditySchema,
  normalizeV4Liquidity,
  v4Abi,
} from "@scout/integrations/uniswap-v4";

import { WorkerEnv } from "../../apps/worker/src/config";
import { withSubstreamsSession } from "../../apps/worker/src/pipeline/sessions";

const config = WorkerEnv.parse(process.env);
const sql = connectDatabase(config.DATABASE_URL, 2);
const rpc = ethereum(config.ETHEREUM_RPC_URL);
const start = 25956038n;
const stop = start + 100n;

try {
  const bytes = await downloadPackage(V4_PACKAGE_URL);
  const packageSha = createHash("sha256").update(bytes).digest("hex");
  const rows: z.infer<typeof ModifyLiquiditySchema>[] = [];
  const cursors: string[] = [];

  await withSubstreamsSession(
    sql,
    config.SUBSTREAMS_SESSION_CAPACITY,
    "verification",
    AbortSignal.timeout(120000),
    async (signal) => {
      for await (const block of consumeOutput({
        packageBytes: bytes,
        endpoint: config.SUBSTREAMS_ENDPOINT,
        apiKey: config.SUBSTREAMS_API_KEY,
        token: config.SUBSTREAMS_API_TOKEN,
        network: "mainnet",
        outputModule: "map_events",
        startBlock: String(start),
        stopBlock: String(stop),
        signal,
      })) {
        assert.equal(block.type, "block");

        if (block.type !== "block") {
          throw new Error("Unexpected undo");
        }

        const output = z
          .object({
            modifyLiquidityEvents: z.array(ModifyLiquiditySchema).default([]),
          })
          .parse(block.output);

        rows.push(...output.modifyLiquidityEvents);
        cursors.push(block.cursor);
      }
    },
  );

  const reference = [];

  for (let fromBlock = start; fromBlock < stop; fromBlock += 10n) {
    reference.push(
      ...(await rpc.getLogs({
        address: V4_POOL_MANAGER,
        event: v4Abi[1],
        fromBlock,
        toBlock: fromBlock + 9n,
        strict: true,
      })),
    );
  }

  const key = (
    tx: string,
    pool: string,
    delta: string,
    lower: string,
    upper: string,
    salt: string,
  ) => [tx, pool, delta, lower, upper, salt].join(":").toLowerCase();
  const ids = rows
    .map((r) =>
      key(
        r.transactionHash,
        r.poolId,
        r.liquidityDelta,
        r.tickLower,
        r.tickUpper,
        r.salt,
      ),
    )
    .sort();

  assert(rows.length > 0);
  assert.deepEqual(
    ids,
    reference
      .map((r) =>
        key(
          r.transactionHash,
          r.args.id,
          String(r.args.liquidityDelta),
          String(r.args.tickLower),
          String(r.args.tickUpper),
          r.args.salt,
        ),
      )
      .sort(),
  );

  const negative = rows.find((r) => BigInt(r.liquidityDelta) < 0n)!;
  const positive = rows.find(
    (r) => BigInt(r.liquidityDelta) > 0n && r.poolId === negative.poolId,
  )!;

  assert(negative && positive, "Real positive and negative events required");

  const provenance = {
    source: "substreams" as const,
    package: V4_PACKAGE,
    module: "map_events",
    decoder: "uniswap-v4-liquidity-v1",
    pipelineVersion: packageSha,
  };
  const removal = await normalizeV4Liquidity(negative, rpc, provenance);
  const addition = await normalizeV4Liquidity(
    positive,
    rpc,
    provenance,
    removal.pool,
  );

  assert.equal(removal.pool.status, "RESOLVED", JSON.stringify(removal.pool));

  const request = {
    version: "v4" as const,
    chainId: 1 as const,
    change: "decrease" as const,
    poolId: negative.poolId,
    transactionInitiator: null,
    minimumUsd: null,
  };
  const compiled = compileV4LiquidityProgram(request);

  assert.equal(compiled.status, "COMPILED");

  if (compiled.status !== "COMPILED") {
    throw new Error("Expected compiled program");
  }

  const program = compiled.program;
  const accepted = evaluateWatchProgram(program, removal.event);
  const rejected = evaluateWatchProgram(program, addition.event);
  const replay = evaluateWatchProgram(program, removal.event, [
    removal.event,
    removal.event,
  ]);
  const wrong = compileV4LiquidityProgram({
    ...request,
    poolId: `0x${"f".repeat(64)}`,
  });

  assert.equal(accepted.status, "MATCH");
  assert.equal(rejected.status, "NO_MATCH");
  assert.deepEqual(replay, accepted);
  assert.equal(wrong.status, "COMPILED");

  if (wrong.status !== "COMPILED") {
    throw new Error("Expected compiled scope");
  }

  assert.equal(
    evaluateWatchProgram(wrong.program, removal.event).status,
    "NO_MATCH",
  );

  const unresolved = await normalizeV4Liquidity(negative, rpc, provenance, {
    status: "UNKNOWN",
    reason: "Controlled unavailable Initialize history",
  });
  const pending = evaluateWatchProgram(program, unresolved.event);

  assert.equal(pending.status, "INSUFFICIENT_DATA");
  assert.equal(
    compileV4LiquidityProgram({ ...request, minimumUsd: "500000" }).status,
    "UNSUPPORTED",
  );
  await mkdir(".scout/evidence/v4", { recursive: true });
  await writeFile(
    ".scout/evidence/v4/liquidity.json",
    JSON.stringify(
      {
        package: V4_PACKAGE,
        packageSha,
        start: String(start),
        stopExclusive: String(stop),
        events: rows.length,
        referenceEvents: reference.length,
        lastCursor: cursors.at(-1),
        program,
        negative,
        positive,
        removal,
        addition,
        accepted,
        rejected,
        replay,
        controlledCases: {
          wrongPool: "NO_MATCH",
          unresolvedPool: pending.status,
          usdValue: "UNSUPPORTED",
        },
        liveActivation: false,
        deliveryAttempted: false,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      events: rows.length,
      referenceEvents: reference.length,
      negative: accepted.status,
      positive: rejected.status,
      replay: "identical",
      pool: removal.pool.status,
      unknown: pending.status,
      liveActivation: false,
    }),
  );
} finally {
  await sql.end();
}
