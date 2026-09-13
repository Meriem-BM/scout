import { z } from "zod";

import {
  evaluateWatchProgram,
  PipelinePlanSchema,
  ProgramWatchSpecSchema,
  V4_PACKAGE,
  V4_PACKAGE_SHA,
  V4_PACKAGE_URL,
  V4_POOL_MANAGER,
  VerificationReportSchema,
} from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";
import { consumeOutput } from "@scout/integrations/substreams";
import { downloadPackage } from "@scout/integrations/substreams-registry";
import {
  ModifyLiquiditySchema,
  normalizeV4Liquidity,
  v4Abi,
} from "@scout/integrations/uniswap-v4";

import { sha256 } from "./generate";

import type { StageReporter } from "./build";
import type { WorkerConfig } from "../config";
import type { DatabaseConnection } from "@scout/database";
import type { NormalizedOnchainEvent, WatchProgram } from "@scout/domain";
import type { SupabaseClient } from "@supabase/supabase-js";

export function verifyLiquidityAcceptance(
  program: WatchProgram,
  reference: NormalizedOnchainEvent,
) {
  const sample = structuredClone(reference);
  let removal = true;
  const scopedFields = new Set<"subject" | "actor" | "sender">();

  function bind(filter: WatchProgram["filter"]) {
    if (!filter) {
      return;
    }

    if (filter.kind === "all") {
      filter.terms.forEach(bind);
    } else if (filter.kind === "text" && filter.operator === "eq") {
      if (
        filter.values.length !== 1 ||
        !["subject", "actor", "sender"].includes(filter.field)
      ) {
        throw new Error("Unsupported liquidity scope acceptance");
      }

      if (
        filter.field === "subject" ||
        filter.field === "actor" ||
        filter.field === "sender"
      ) {
        scopedFields.add(filter.field);
      }

      if (filter.field === "subject") {
        sample.subject = filter.values[0]!;
      }

      if (filter.field === "sender") {
        sample.attributes.sender = filter.values[0]!;
      }

      if (filter.field === "actor") {
        sample.actor = filter.values[0]!;
      }
    } else if (filter.kind === "number" && filter.field === "metric") {
      removal = filter.operator === "lt";
    } else {
      throw new Error(
        "Acceptance generation does not support this liquidity program shape",
      );
    }
  }

  // The nonempty-subject predicate is the only supported additional predicate.
  function bindSupported(filter: WatchProgram["filter"]) {
    if (
      filter?.kind === "text" &&
      filter.field === "subject" &&
      filter.operator === "ne" &&
      filter.values[0] === ""
    ) {
      return;
    }

    if (filter?.kind === "all") {
      filter.terms.forEach(bindSupported);
    } else {
      bind(filter);
    }
  }

  bindSupported(program.filter);

  const cases = [-1, 0, 1].map((sign) => {
    const event = {
      ...sample,
      attributes: { ...sample.attributes, metric: String(sign) },
    };
    const expected = (removal ? sign < 0 : sign > 0) ? "MATCH" : "NO_MATCH";

    return {
      name: `controlled_liquidity_delta_${sign}`,
      passed: evaluateWatchProgram(program, event).status === expected,
    };
  });
  const matching: NormalizedOnchainEvent = {
    ...sample,
    attributes: { ...sample.attributes, metric: removal ? "-1" : "1" },
  };

  for (const field of scopedFields) {
    const outside = structuredClone(matching);
    const mismatch =
      "0x" +
      (String(
        field === "sender" ? matching.attributes.sender : matching[field],
      ).endsWith("1")
        ? "2"
        : "1"
      ).repeat(field === "subject" ? 64 : 40);

    if (field === "sender") {
      outside.attributes.sender = mismatch;
    } else {
      outside[field] = mismatch;
    }

    cases.push({
      name: `wrong_${field}_rejected`,
      passed: evaluateWatchProgram(program, outside).status === "NO_MATCH",
    });
  }

  cases.push({
    name: "unknown_pool_is_not_a_match",
    passed:
      evaluateWatchProgram(program, { ...matching, subject: null }).status ===
      "INSUFFICIENT_DATA",
  });
  cases.push({
    name: "replay_is_identical",
    passed:
      JSON.stringify(
        evaluateWatchProgram(program, matching, [matching, matching]),
      ) === JSON.stringify(evaluateWatchProgram(program, matching)),
  });

  if (cases.some((c) => !c.passed)) {
    throw new Error("Liquidity Watch acceptance failed");
  }

  return {
    status: "INTENT_ACCEPTANCE_VERIFIED" as const,
    basis:
      "Controlled sign, scope binding, unknown-pool and replay cases using a real verified event. Liquidity units are not USD.",
    cases,
  };
}

export async function buildV4Deployment(
  sql: DatabaseConnection,
  storage: SupabaseClient,
  config: WorkerConfig,
  id: string,
  signal: AbortSignal,
  report?: StageReporter,
) {
  const row = (
    await sql`select d.*,v.spec from public.pipeline_deployments d join public.watch_versions v on v.id=d.version_id where d.id=${id}`
  )[0]!;
  const spec = ProgramWatchSpecSchema.parse(row.spec);

  if (
    spec.program.source.protocol !== "uniswap_v4" ||
    spec.program.source.eventType !== "liquidity_change"
  ) {
    throw new Error("No verified data adapter for program");
  }

  const plan = PipelinePlanSchema.parse(
    (
      await sql`select payload from public.watch_workflow_outputs where workflow_id=${row.workflow_id} and kind='pipeline_plan'`
    )[0]?.payload,
  );

  if (
    plan.strategy !== "REUSE" ||
    plan.chain !== "ethereum" ||
    plan.dependencies.length !== 1 ||
    plan.dependencies[0]?.packageRef !== V4_PACKAGE ||
    plan.dependencies[0]?.module !== "map_events" ||
    plan.parameters.length ||
    plan.generatedModules.length
  ) {
    throw new Error(
      "V4 deployment requires the inspected published map_events REUSE binding",
    );
  }

  const bytes = await downloadPackage(V4_PACKAGE_URL, signal);

  if (sha256(bytes) !== V4_PACKAGE_SHA) {
    throw new Error("V4 package checksum mismatch");
  }

  const rpc = ethereum(config.ETHEREUM_RPC_URL);

  if ((await rpc.getChainId()) !== 1) {
    throw new Error("Ethereum RPC required");
  }

  await report?.(
    "TESTING",
    "Testing published V4 data",
    "Comparing ModifyLiquidity output with canonical Ethereum receipts.",
  );

  const events: NormalizedOnchainEvent[] = [];

  for await (const b of consumeOutput({
    packageBytes: bytes,
    endpoint: config.SUBSTREAMS_ENDPOINT,
    apiKey: config.SUBSTREAMS_API_KEY,
    token: config.SUBSTREAMS_API_TOKEN,
    network: "mainnet",
    outputModule: "map_events",
    startBlock: "25956043",
    stopBlock: "25956044",
    signal,
  })) {
    if (b.type !== "block") {
      throw new Error("Unexpected finalized undo");
    }

    const output = z
      .object({
        modifyLiquidityEvents: z.array(ModifyLiquiditySchema).default([]),
      })
      .parse(b.output);

    for (const raw of output.modifyLiquidityEvents) {
      if (
        raw.blockNumber !== b.number ||
        raw.blockTimestamp !== String(b.timestamp)
      ) {
        throw new Error("V4 output event is outside its source block");
      }

      const result = await normalizeV4Liquidity(raw, rpc, {
        source: "substreams",
        package: V4_PACKAGE_SHA,
        module: "map_events",
        decoder: "uniswap-v4-liquidity-v1",
        pipelineVersion: id,
      });

      if (result.pool.status !== "RESOLVED") {
        throw new Error(result.pool.reason);
      }

      events.push(result.event);
    }
  }

  const refs = await rpc.getLogs({
    address: V4_POOL_MANAGER,
    event: v4Abi[1],
    fromBlock: 25956043n,
    toBlock: 25956043n,
    strict: true,
  });
  const keys = events.map((e) => `${e.transactionHash}:${e.eventIndex}`).sort();

  if (
    !events.length ||
    new Set(keys).size !== keys.length ||
    JSON.stringify(keys) !==
      JSON.stringify(
        refs.map((r) => `${r.transactionHash}:${r.logIndex}`).sort(),
      )
  ) {
    throw new Error("Missing, duplicate, or extra V4 package events");
  }

  const acceptance = verifyLiquidityAcceptance(spec.program, events[0]!);
  const verification = VerificationReportSchema.parse({
    status: "verified",
    pipelineStatus: "PIPELINE_VERIFIED",
    intentAcceptance: acceptance,
    confidence: "high",
    buildPassed: true,
    execution: {
      fromBlock: "25956043",
      toBlock: "25956043",
      blocksTested: 1,
      eventsObserved: events.length,
      errors: [],
    },
    comparisons: keys.map((key) => ({
      field: key,
      expected: "present",
      actual: "present",
      matched: true,
    })),
    duplicateCheck: { passed: true, count: 0 },
    missingEventCheck: { passed: true, count: 0 },
    referenceSource:
      "Canonical Ethereum ModifyLiquidity receipts and Initialize PoolKey evidence",
    findings: ["Published WASM checksum verified", acceptance.basis],
    checkedAt: new Date().toISOString(),
  });

  await report?.(
    "SEMANTIC_VERIFYING",
    "Liquidity data and acceptance verified",
    acceptance.basis,
    { eventsObserved: events.length },
  );

  const head = await rpc.getBlock({ blockTag: "finalized" });
  const hash = sha256(
    new TextEncoder().encode(V4_PACKAGE_SHA + JSON.stringify(spec.program)),
  );
  const manifest = JSON.stringify({
    network: "mainnet",
    module: "map_events",
    packageSha: V4_PACKAGE_SHA,
  });

  for (const [name, data] of [
    ["package.spkg", bytes],
    ["manifest.yaml", manifest],
    ["build.log", "Reused checksum-pinned published WASM; no generated code."],
  ] as const) {
    const result = await storage.storage
      .from("pipeline-artifacts")
      .upload(`${hash}/${name}`, data, { upsert: true });

    if (result.error) {
      throw result.error;
    }
  }

  await sql`insert into app_private.artifacts(hash,template_version,manifest,source_hash,storage_path,build_log_path,module_name,package_sha256) values(${hash},'v4-liquidity-v1',${manifest},${V4_PACKAGE_SHA},${hash + "/package.spkg"},${hash + "/build.log"},'map_events',${V4_PACKAGE_SHA}) on conflict do nothing`;

  const proof = {
    startBlock: (head.number - 10n).toString(),
    packageSha256: V4_PACKAGE_SHA,
    strategy: "REUSE",
    network: "mainnet",
    outputModule: "map_events",
    parameters: [],
    verification,
    pipelineStatus: "PIPELINE_VERIFIED",
    intentAcceptanceStatus: acceptance.status,
  };

  await sql.begin(async (tx) => {
    await tx`select app_private.put_workflow_output(${row.workflow_id},'verification',${tx.json(verification)})`;
    await tx`update public.pipeline_deployments set artifact_hash=${hash},proof=${tx.json(proof)},state='starting',error=null where id=${id}`;
  });

  return { proof, verification };
}
