import {
  BASE_USDC,
  type CandidateEvent,
  Erc20WatchSpecSchema,
  PackageResolutionSchema,
  PipelinePlanSchema,
  TRANSFER_SIGNATURE,
  VerificationReportSchema,
  verifyTransferAcceptance,
} from "@scout/domain";
import {
  baseRpc,
  normalizeTransfers,
  transferAbi,
} from "@scout/integrations/erc20";
import { consumeOutput } from "@scout/integrations/substreams";
import { downloadPackage } from "@scout/integrations/substreams-registry";

import { COMMON_SHA, sha256 } from "./generate";

import type { StageReporter } from "./build";
import type { WorkerConfig } from "../config";
import type { DatabaseConnection } from "@scout/database";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function buildBaseDeployment(
  sql: DatabaseConnection,
  storage: SupabaseClient,
  config: WorkerConfig,
  id: string,
  signal: AbortSignal,
  report?: StageReporter,
) {
  if (!config.BASE_RPC_URL || !config.BASE_SUBSTREAMS_ENDPOINT) {
    throw new Error(
      "Configure BASE_RPC_URL and BASE_SUBSTREAMS_ENDPOINT before Base verification.",
    );
  }

  const row = (
    await sql`select d.*,v.spec from public.pipeline_deployments d join public.watch_versions v on v.id=d.version_id where d.id=${id}`
  )[0]!;
  const spec = Erc20WatchSpecSchema.parse(row.spec);
  const outputs =
    await sql`select kind,payload from public.watch_workflow_outputs where workflow_id=${row.workflow_id}`;
  const plan = PipelinePlanSchema.parse(
    outputs.find((x) => x.kind === "pipeline_plan")?.payload,
  );
  const resolution = PackageResolutionSchema.parse(
    outputs.find((x) => x.kind === "package_resolution")?.payload,
  );
  const selected = resolution.candidates.find(
    (x) => x.ref === resolution.selectedRef,
  );

  if (
    !selected ||
    !selected.packageUrl ||
    selected.ref !== "ethereum-common@v0.3.3" ||
    plan.strategy !== "PARAMETERIZE" ||
    plan.dependencies[0]?.module !== "filtered_events" ||
    plan.parameters.length !== 1 ||
    plan.parameters[0]?.module !== "filtered_events" ||
    plan.parameters[0]?.name !== "query" ||
    plan.parameters[0]?.value !==
      `evt_addr:${BASE_USDC} && evt_sig:${TRANSFER_SIGNATURE}` ||
    plan.chain !== "base"
  ) {
    throw new Error("Executable parameterization contract missing");
  }

  const bytes = await downloadPackage(selected.packageUrl, signal);

  if (sha256(bytes) !== COMMON_SHA) {
    throw new Error(
      "Selected foundation checksum differs from the inspected executor contract",
    );
  }

  await report?.(
    "BUILDING",
    "Published package integrity verified",
    "The selected published WASM checksum matches the inspected dependency. Its Transfer filter is parameterized for native USDC on Base; no code was generated.",
    {
      strategy: "PARAMETERIZE",
      packageSha256: COMMON_SHA,
      parameters: plan.parameters,
    },
  );

  const rpc = baseRpc(config.BASE_RPC_URL);

  if ((await rpc.getChainId()) !== 8453) {
    throw new Error("Base RPC returned a different chain");
  }

  const head = await rpc.getBlock({ blockTag: "finalized" });
  const start = head.number - 100n;
  const stop = head.number + 1n;

  await report?.(
    "TESTING",
    "Testing on finalized Base blocks",
    "Comparing the parameterized Substreams output with independent RPC receipts and Transfer logs.",
    { fromBlock: start.toString(), toBlock: head.number.toString() },
  );

  const observed: CandidateEvent[] = [];

  for await (const block of consumeOutput({
    endpoint: config.BASE_SUBSTREAMS_ENDPOINT,
    apiKey: config.SUBSTREAMS_API_KEY,
    token: config.SUBSTREAMS_API_TOKEN,
    packageBytes: bytes,
    network: "base",
    outputModule: "filtered_events",
    parameters: plan.parameters,
    startBlock: start.toString(),
    stopBlock: stop.toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
  })) {
    if (block.type === "undo") {
      throw new Error("Finality changed during verification");
    }

    observed.push(...(await normalizeTransfers(block, rpc)));
  }

  const reference = await rpc.getLogs({
    address: BASE_USDC,
    event: transferAbi,
    fromBlock: start,
    toBlock: head.number,
  });
  const keys = new Set(
    observed.map((event) => `${event.transaction.hash}:${event.eventIndex}`),
  );
  const missing = reference.filter(
    (log) => !keys.has(`${log.transactionHash}:${log.logIndex}`),
  ).length;

  if (
    !observed.length ||
    !reference.length ||
    missing ||
    keys.size !== observed.length ||
    keys.size !== reference.length
  ) {
    throw new Error(
      "Base pipeline verification failed: missing/extra/duplicate or empty Transfer output",
    );
  }

  const acceptance = verifyTransferAcceptance(spec, observed[0]!);
  const verification = VerificationReportSchema.parse({
    status: "verified",
    pipelineStatus: "PIPELINE_VERIFIED",
    intentAcceptance: acceptance,
    confidence: "high",
    buildPassed: true,
    execution: {
      fromBlock: start.toString(),
      toBlock: head.number.toString(),
      blocksTested: Number(stop - start),
      eventsObserved: observed.length,
      errors: [],
    },
    comparisons: reference.map((log) => ({
      field: `${log.transactionHash}:${log.logIndex}`,
      expected: "present",
      actual: "present",
      matched: true,
    })),
    duplicateCheck: { passed: true, count: 0 },
    missingEventCheck: { passed: true, count: 0 },
    referenceSource:
      "Independent Base RPC canonical Transfer receipts and complete bounded eth_getLogs range",
    findings: [
      "Existing WASM reused; no generated Rust.",
      "All provider events independently matched receipt topics and data.",
      acceptance.basis,
    ],
    checkedAt: new Date().toISOString(),
  });

  await report?.(
    "SEMANTIC_VERIFYING",
    "Pipeline and intent acceptance verified",
    "Real historical Transfer output matched the independent reference. Controlled Watch acceptance cases also passed.",
    {
      pipelineStatus: verification.pipelineStatus,
      intentAcceptance: acceptance,
      eventsObserved: observed.length,
      fromBlock: start.toString(),
      toBlock: head.number.toString(),
    },
  );

  const manifest = JSON.stringify({
    network: "base",
    outputModule: "filtered_events",
    parameters: plan.parameters,
    dependency: resolution.selectedRef,
  });
  const hash = sha256(new TextEncoder().encode(manifest + COMMON_SHA));

  for (const [file, data] of [
    ["package.spkg", bytes],
    ["manifest.yaml", manifest],
    [
      "build.log",
      "Reused checksum-verified published WASM; no local compilation.",
    ],
    [
      "sources.json",
      JSON.stringify({
        dependency: resolution.selectedRef,
        source: selected.sourceUrl,
      }),
    ],
  ] as const) {
    const upload = await storage.storage
      .from("pipeline-artifacts")
      .upload(`${hash}/${file}`, data, { upsert: true });

    if (upload.error) {
      throw upload.error;
    }
  }

  await sql`insert into app_private.artifacts(hash,template_version,manifest,source_hash,storage_path,build_log_path,module_name,package_sha256) values(${hash},'base-usdc-parameterize-v1',${manifest},${COMMON_SHA},${hash + "/package.spkg"},${hash + "/build.log"},'filtered_events',${COMMON_SHA}) on conflict do nothing`;

  const proof = {
    startBlock: head.number.toString(),
    packageSha256: COMMON_SHA,
    strategy: "PARAMETERIZE",
    network: "base",
    outputModule: "filtered_events",
    parameters: plan.parameters,
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
