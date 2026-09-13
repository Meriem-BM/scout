import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseUnits } from "viem";
import { z } from "zod";

import { loadDeployment } from "@scout/database";
import {
  maxWindow,
  poolByAddress,
  type SwapEvent,
  VerificationReportSchema,
  verifyUniswapAcceptance,
  type WorkflowStage,
} from "@scout/domain";
import { oracleValue, validatePools } from "@scout/integrations/ethereum";
import { GraphAdapter } from "@scout/integrations/graph";
import { normalizeBlock } from "@scout/integrations/substreams";
import { consumeHistorical } from "@scout/integrations/substreams-cli";

import { log } from "../log";

import { buildBaseDeployment } from "./base";
import {
  packPipeline,
  pipelineIdentity,
  sha256,
  TEMPLATE_VERSION,
  trustedSourceHash,
} from "./generate";
import { ensureDeploymentProgram } from "./program-gate";
import { withSubstreamsSession } from "./sessions";
import { buildV4Deployment } from "./v4";

import type { WorkerConfig } from "../config";
import type { DatabaseConnection } from "@scout/database";
import type { Ethereum } from "@scout/integrations/ethereum";
import type { SupabaseClient } from "@supabase/supabase-js";

export type StageReporter = (
  stage: WorkflowStage,
  title: string,
  summary: string,
  metadata?: Record<string, unknown>,
) => Promise<void>;

async function buildDeploymentWithinSession(
  sql: DatabaseConnection,
  storage: SupabaseClient,
  config: WorkerConfig,
  rpc: Ethereum,
  id: string,
  signal: AbortSignal,
  report?: StageReporter,
) {
  const protocol = (
    await sql`select v.spec->>'protocol' protocol from public.pipeline_deployments d join public.watch_versions v on v.id=d.version_id where d.id=${id}`
  )[0]?.protocol;

  if (protocol === "program") {
    return buildV4Deployment(sql, storage, config, id, signal, report);
  }

  if (protocol === "erc20") {
    return buildBaseDeployment(sql, storage, config, id, signal, report);
  }

  const deployment = await loadDeployment(sql, id);
  const selectedPackageRef = deployment.workflow_id
    ? z
        .string()
        .parse(
          (
            await sql`select payload->>'selectedRef' selected_ref from public.watch_workflow_outputs where workflow_id=${deployment.workflow_id} and kind='package_resolution'`
          )[0]?.selected_ref,
        )
    : "ethereum-common@v0.3.3";

  if (selectedPackageRef !== "ethereum-common@v0.3.3") {
    throw new Error(
      `The inspected package ${selectedPackageRef} does not match Scout's pinned, checksum-verified ethereum-common@v0.3.3 build dependency. Replan before building.`,
    );
  }

  const state = async (value: string) => {
    await sql`update public.pipeline_deployments set state=${value},error=null where id=${id}`;
    await sql`update public.watches set status=${value},error=null where id=${deployment.watch_id} and active_version_id is null and desired_state='running'`;
    log("pipeline.stage", { deploymentId: id, stage: value });
  };

  await state("preparing");
  await report?.(
    "BUILDING",
    "Building the pipeline",
    "Validating source inputs and compiling the trusted Scout normalization module in an ephemeral workspace.",
  );

  const verified = await validatePools(rpc, deployment.spec.pools);
  const graph = new GraphAdapter(
    config.GRAPH_API_KEY,
    config.GRAPH_SUBGRAPH_ID,
  );
  const coverage = await graph.history(
    deployment.spec.pools,
    verified.timestamp - 3600,
    verified.timestamp,
    100,
  );
  const graphBlock = await rpc.getBlock({
    blockNumber: BigInt(coverage._meta.block.number),
  });

  if (
    coverage._meta.block.hash &&
    graphBlock.hash.toLowerCase() !== coverage._meta.block.hash.toLowerCase()
  ) {
    throw new Error("Subgraph block hash does not match Ethereum mainnet.");
  }

  if (Number(graphBlock.timestamp) < verified.timestamp - 1800) {
    throw new Error(
      "Subgraph is too far behind for activation coverage validation.",
    );
  }

  const templateDir = resolve(config.SUBSTREAMS_TEMPLATE_DIR);
  const sourceHash = await trustedSourceHash(templateDir);
  const hash = pipelineIdentity(deployment.spec, sourceHash);
  const existing =
    await sql`select * from app_private.artifacts where hash=${hash}`;
  let bytes: Uint8Array;
  let packageHash: string;

  if (existing[0]) {
    const artifact = z
      .object({ storage_path: z.string(), package_sha256: z.string() })
      .parse(existing[0]);
    const download = await storage.storage
      .from("pipeline-artifacts")
      .download(artifact.storage_path);

    if (download.error) {
      throw new Error("Stored pipeline artifact could not be retrieved.");
    }

    bytes = new Uint8Array(await download.data.arrayBuffer());
    packageHash = artifact.package_sha256;

    if (sha256(bytes) !== packageHash) {
      throw new Error("Stored pipeline package integrity check failed.");
    }
  } else {
    const directory = await mkdtemp(join(tmpdir(), "scout-build-"));

    try {
      const artifact = await packPipeline(
        deployment.spec,
        templateDir,
        directory,
        config.SUBSTREAMS_BIN,
      );

      bytes = artifact.bytes;
      packageHash = artifact.packageSha256;
      await report?.(
        "BUILDING",
        "Build passed",
        "The Rust module compiled to WASM with the pinned toolchain and locked dependencies.",
        {
          templateVersion: TEMPLATE_VERSION,
          sourceHash,
        },
      );

      const sourceFiles = await Promise.all(
        [
          "src/lib.rs",
          "proto/scout.proto",
          "abi/pool.json",
          "Cargo.toml",
          "Cargo.lock",
          "build.rs",
          "rust-toolchain.toml",
        ].map(async (path) => [
          path,
          await readFile(join(templateDir, path), "utf8"),
        ]),
      );
      const files: [string, Uint8Array | string, string][] = [
        ["package.spkg", bytes, "application/octet-stream"],
        ["manifest.yaml", artifact.manifest, "text/yaml"],
        ["build.log", artifact.buildLog, "text/plain"],
        [
          "sources.json",
          JSON.stringify(Object.fromEntries(sourceFiles)),
          "application/json",
        ],
      ];

      for (const [name, body, contentType] of files) {
        const upload = await storage.storage
          .from("pipeline-artifacts")
          .upload(`${hash}/${name}`, body, { contentType, upsert: true });

        if (upload.error) {
          throw new Error(`Artifact persistence failed: ${name}`);
        }
      }

      await sql`insert into app_private.artifacts(hash,template_version,manifest,source_hash,storage_path,build_log_path,module_name,package_sha256) values(${hash},${TEMPLATE_VERSION},${artifact.manifest},${sourceHash},${hash + "/package.spkg"},${hash + "/build.log"},'map_watch',${packageHash}) on conflict(hash) do nothing`;
      await report?.(
        "PACKAGING",
        "Package created",
        "The compiled WASM and manifest were packed into a content-addressed .spkg artifact.",
        {
          packageSha256: packageHash,
          artifactHash: hash,
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  if (existing[0]) {
    await report?.(
      "BUILDING",
      "Verified build reused",
      "A previously compiled artifact with the same source, dependency, and Watch parameters passed its integrity check.",
      {
        artifactHash: hash,
        packageSha256: packageHash,
      },
    );
    await report?.(
      "PACKAGING",
      "Package integrity passed",
      "The stored .spkg checksum matches its persisted package metadata.",
      {
        artifactReused: true,
      },
    );
  }

  await state("checking");

  const graphReferences = coverage.swaps
    .map((swap) => {
      const pool = poolByAddress(swap.pool.id);
      const amount0 = signedUnits(swap.amount0, pool.token0.decimals);
      const amount1 = signedUnits(swap.amount1, pool.token1.decimals);
      const soldAddress =
        amount0 > 0n ? pool.token0.address : pool.token1.address;

      return {
        key: `${swap.transaction.id.toLowerCase()}:${swap.logIndex}`,
        block: BigInt(swap.transaction.blockNumber),
        pool: swap.pool.id,
        transactionHash: swap.transaction.id.toLowerCase(),
        logIndex: Number(swap.logIndex),
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        matchesDirection:
          deployment.spec.streamDirection === "either" ||
          soldAddress === deployment.spec.sellToken,
      };
    })
    .filter((swap) => swap.matchesDirection);

  if (!graphReferences.length) {
    throw new Error(
      "The independent Subgraph reference returned no recent swaps in the requested direction. Scout stopped before claiming verification.",
    );
  }

  const referenceBlocks = graphReferences.map((swap) => swap.block);
  const firstBlock = referenceBlocks.reduce((a, b) => (a < b ? a : b));
  const lastBlock = referenceBlocks.reduce((a, b) => (a > b ? a : b));
  const start = firstBlock > 0n ? firstBlock - 1n : firstBlock;
  const stop = lastBlock + 2n;

  if (stop - start > 5000n) {
    throw new Error(
      "The independent verification range exceeds Scout's 5,000-block execution budget.",
    );
  }

  await report?.(
    "TESTING",
    "Testing on Ethereum history",
    "Running the compiled package over a bounded range containing independently observed Uniswap swaps.",
    {
      startBlock: start.toString(),
      stopBlock: stop.toString(),
      referenceEvents: graphReferences.length,
    },
  );

  const blockCount = Number(stop - start);
  let outputBlockCount = 0;
  let eventCount = 0;
  let valuedCount = 0;
  const observed = new Map<
    string,
    {
      pool: string;
      transactionHash: string;
      logIndex: number;
      amount0: string;
      amount1: string;
    }
  >();
  let acceptanceSeed: SwapEvent | undefined;
  let duplicates = 0;
  let valuationCandidate: {
    sellToken: string;
    sellAmount: string;
    blockNumber: string;
  } | null = null;
  const timeout = AbortSignal.timeout(90_000);

  for await (const item of consumeHistorical({
    endpoint: config.SUBSTREAMS_ENDPOINT,
    apiKey: config.SUBSTREAMS_API_KEY,
    token: config.SUBSTREAMS_API_TOKEN,
    substreamsBin: config.SUBSTREAMS_BIN,
    packageBytes: bytes,
    startBlock: start.toString(),
    stopBlock: stop.toString(),
    signal: AbortSignal.any([signal, timeout]),
  })) {
    if (!acceptanceSeed && item.swaps.length) {
      const referenceBlock = await rpc.getBlock({
        blockNumber: BigInt(item.number),
      });
      const normalized = await normalizeBlock(
        {
          ...item,
          hash: referenceBlock.hash,
          timestamp: Number(referenceBlock.timestamp),
          type: "block",
          cursor: "historical-acceptance",
        },
        rpc,
        () => {},
      );

      acceptanceSeed = normalized.find(
        (event) =>
          !!event.valuation && event.sellToken === deployment.spec.sellToken,
      );
    }

    outputBlockCount++;
    eventCount += item.swaps.length;

    for (const swap of item.swaps) {
      const pool = poolByAddress(swap.pool);
      const amount0 = BigInt(swap.amount0);
      const amount1 = BigInt(swap.amount1);

      if (!((amount0 > 0n && amount1 < 0n) || (amount1 > 0n && amount0 < 0n))) {
        throw new Error("Substreams emitted invalid swap direction semantics.");
      }

      const sold = amount0 > 0n ? pool.token0 : pool.token1;
      const sellAmount = (amount0 > 0n ? amount0 : amount1).toString();

      if (!valuationCandidate && sold.address === deployment.spec.sellToken) {
        valuationCandidate = {
          sellToken: sold.address,
          sellAmount,
          blockNumber: item.number,
        };
      }

      const key = `${swap.transactionHash.toLowerCase()}:${swap.logIndex}`;

      if (observed.has(key)) {
        duplicates++;
      }

      observed.set(key, {
        pool: swap.pool,
        transactionHash: swap.transactionHash,
        logIndex: swap.logIndex,
        amount0: swap.amount0,
        amount1: swap.amount1,
      });
    }
  }

  if (valuationCandidate) {
    const valuationBlock = await rpc.getBlock({
      blockNumber: BigInt(valuationCandidate.blockNumber),
    });

    valuedCount = (await oracleValue(rpc, {
      ...valuationCandidate,
      timestamp: Number(valuationBlock.timestamp),
    }))
      ? 1
      : 0;
  }

  if (outputBlockCount === 0 || eventCount === 0 || valuedCount === 0) {
    throw new Error(
      "Bounded provider validation produced no reliably valued matching output. Check provider/oracle access or try another recent range.",
    );
  }

  await report?.(
    "TESTING",
    "Historical execution passed",
    `${blockCount} finalized blocks executed and ${eventCount} canonical events were decoded.`,
    {
      blocksTested: blockCount,
      outputBlocks: outputBlockCount,
      eventsObserved: eventCount,
      valuedEvents: valuedCount,
    },
  );
  await report?.(
    "SEMANTIC_VERIFYING",
    "Verifying event semantics",
    "Comparing canonical identities, pool addresses, log indexes, and signed token amounts with The Graph.",
    {
      referenceSource: `The Graph subgraph ${coverage.subgraphId}`,
    },
  );

  const comparisons = graphReferences.flatMap((expected) => {
    const actual = observed.get(expected.key);

    return [
      {
        field: `${expected.key}:event`,
        expected: "present",
        actual: actual ? "present" : "missing",
        matched: !!actual,
      },
      ...(actual
        ? ([
            {
              field: `${expected.key}:pool`,
              expected: expected.pool,
              actual: actual.pool,
              matched: expected.pool === actual.pool,
            },
            {
              field: `${expected.key}:amount0`,
              expected: expected.amount0,
              actual: actual.amount0,
              matched: expected.amount0 === actual.amount0,
            },
            {
              field: `${expected.key}:amount1`,
              expected: expected.amount1,
              actual: actual.amount1,
              matched: expected.amount1 === actual.amount1,
            },
          ] as const)
        : []),
    ];
  });
  const missing = graphReferences.filter(
    (expected) => !observed.has(expected.key),
  ).length;
  const mismatches = comparisons.filter(
    (comparison) => !comparison.matched,
  ).length;

  if (!acceptanceSeed) {
    throw new Error(
      "No independently normalized historical seed for intent acceptance",
    );
  }

  const intentAcceptance = verifyUniswapAcceptance(
    deployment.spec,
    acceptanceSeed,
  );
  const verification = VerificationReportSchema.parse({
    pipelineStatus:
      missing === 0 && mismatches === 0 && duplicates === 0
        ? "PIPELINE_VERIFIED"
        : "FAILED",
    intentAcceptance,
    status:
      missing === 0 && mismatches === 0 && duplicates === 0
        ? "verified"
        : "failed",
    confidence:
      missing === 0 && mismatches === 0 && duplicates === 0 ? "high" : "low",
    buildPassed: true,
    execution: {
      fromBlock: start.toString(),
      toBlock: (stop - 1n).toString(),
      blocksTested: blockCount,
      eventsObserved: eventCount,
      errors: [],
    },
    comparisons,
    duplicateCheck: { passed: duplicates === 0, count: duplicates },
    missingEventCheck: { passed: missing === 0, count: missing },
    referenceSource: `The Graph Uniswap v3 subgraph ${coverage.subgraphId} at deployment ${coverage._meta.deployment}`,
    findings: [
      `${graphReferences.length - missing}/${graphReferences.length} independently observed events were present.`,
      mismatches
        ? `${mismatches} field comparisons did not match.`
        : "All compared pool and signed amount fields matched.",
      duplicates
        ? `${duplicates} duplicate canonical event keys were emitted.`
        : "No duplicate canonical event keys were emitted.",
    ],
    checkedAt: new Date().toISOString(),
  });

  if (deployment.workflow_id) {
    await sql`select app_private.put_workflow_output(${deployment.workflow_id},'verification',${sql.json(verification)})`;
  }

  if (verification.status !== "verified") {
    throw new Error(
      `Semantic verification failed: ${missing} missing reference events, ${mismatches} mismatched fields, and ${duplicates} duplicates. Deployment was blocked.`,
    );
  }

  await report?.(
    "SEMANTIC_VERIFYING",
    "Pipeline output verified; intent acceptance checked",
    `${graphReferences.length}/${graphReferences.length} reference events matched with no duplicate canonical IDs.`,
    {
      status: verification.status,
      comparisons: comparisons.length,
      duplicateCount: duplicates,
    },
  );

  // A continuous stream must cover the entire rule baseline, including blocks with no matching events.
  const requiredSeconds = maxWindow(deployment.spec);
  let warmupNumber =
    BigInt(verified.blockNumber) -
    BigInt(Math.ceil(requiredSeconds / 12) + 100);
  let warmup = await rpc.getBlock({ blockNumber: warmupNumber });

  while (Number(warmup.timestamp) > verified.timestamp - requiredSeconds) {
    warmupNumber -= 100n;

    if (
      BigInt(verified.blockNumber) - warmupNumber > 5000n ||
      warmupNumber < 23000000n
    ) {
      throw new Error(
        "Historical rule baseline exceeds the bounded stream budget.",
      );
    }

    warmup = await rpc.getBlock({ blockNumber: warmupNumber });
  }

  const proof = {
    pipelineStatus: verification.pipelineStatus,
    intentAcceptanceStatus: intentAcceptance.status,
    intentAcceptance,
    templateVersion: TEMPLATE_VERSION,
    sourceHash,
    packageSha256: packageHash,
    artifactHash: hash,
    skillRevision: "79d8bb611e3dff60768ba170dad23f795b346a2f",
    factory: verified,
    subgraph: {
      id: coverage.subgraphId,
      deployment: coverage._meta.deployment,
      block: coverage._meta.block,
      checkedAt: coverage.refreshedAt,
    },
    validation: {
      start: start.toString(),
      stop: stop.toString(),
      blocks: blockCount,
      events: eventCount,
      valuedEvents: valuedCount,
      provider: config.SUBSTREAMS_ENDPOINT,
      checkedAt: new Date().toISOString(),
    },
    startBlock: warmup.number.toString(),
    observationFromTime: Number(warmup.timestamp),
    requiredHistorySeconds: requiredSeconds,
    composition: [
      `${selectedPackageRef}:index_events`,
      "map_swaps",
      "map_watch",
    ],
    artifactReused: !!existing[0],
  };

  await sql`update public.pipeline_deployments set artifact_hash=${hash},proof=${sql.json(proof)},state='starting' where id=${id}`;
  await state("starting");

  return { verification, proof };
}

function signedUnits(value: string, decimals: number) {
  const negative = value.startsWith("-");
  const normalized = negative ? value.slice(1) : value;
  const amount = parseUnits(normalized, decimals);

  return negative ? -amount : amount;
}

export async function buildDeployment(
  ...args: Parameters<typeof buildDeploymentWithinSession>
) {
  await ensureDeploymentProgram(args[0], args[4]);

  return withSubstreamsSession(
    args[0],
    args[2].SUBSTREAMS_SESSION_CAPACITY,
    "verification",
    args[5],
    (signal) =>
      buildDeploymentWithinSession(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        signal,
        args[6],
      ),
  );
}
