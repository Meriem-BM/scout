import { z } from "zod";

import { loadDeployment } from "@scout/database";
import { IntegrationError } from "@scout/integrations/http";
import { consume, normalizeBlock } from "@scout/integrations/substreams";

import { log } from "../log";
import { sha256 } from "../pipeline/generate";

import { persistBlock, persistUndo } from "./persist";

import type { WorkerConfig } from "../config";
import type { DatabaseConnection } from "@scout/database";
import type { Ethereum } from "@scout/integrations/ethereum";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function runUniswapPipeline(
  sql: DatabaseConnection,
  storage: SupabaseClient,
  rpc: Ethereum,
  config: WorkerConfig,
  id: string,
  owner: string,
  signal: AbortSignal,
  expectedGeneration?: number,
) {
  const deployment = await loadDeployment(sql, id);
  const verification = z
    .object({
      pipelineStatus: z.literal("PIPELINE_VERIFIED"),
      intentAcceptanceStatus: z.enum([
        "INTENT_ACCEPTANCE_VERIFIED",
        "NOT_APPLICABLE",
      ]),
    })
    .parse(deployment.proof);

  if (
    deployment.spec.investigation.requireNoPriorUniswapSwaps &&
    verification.intentAcceptanceStatus !== "INTENT_ACCEPTANCE_VERIFIED"
  ) {
    throw new Error(
      "This Watch requires intent acceptance verification before activation.",
    );
  }

  const artifact = z
    .object({ storage_path: z.string(), package_sha256: z.string() })
    .parse(
      (
        await sql`select storage_path,package_sha256 from app_private.artifacts where hash=${deployment.artifact_hash}`
      )[0],
    );
  const downloaded = await storage.storage
    .from("pipeline-artifacts")
    .download(artifact.storage_path);

  if (downloaded.error) {
    throw new Error("Cannot download pipeline package.");
  }

  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());

  if (sha256(bytes) !== artifact.package_sha256) {
    throw new Error("Pipeline artifact hash mismatch.");
  }

  const checkpoints =
    await sql`select cursor,block_number::text from app_private.checkpoints where deployment_id=${id}`;
  const checkpoint = checkpoints[0]
    ? z
        .object({ cursor: z.string(), block_number: z.string() })
        .parse(checkpoints[0])
    : null;
  const proof = z.object({ startBlock: z.string() }).parse(deployment.proof);
  let finalized = await rpc.getBlock({ blockTag: "finalized" });
  let checkedAt = Date.now();

  if (
    checkpoint &&
    finalized.number - BigInt(checkpoint.block_number) > 5000n
  ) {
    throw new IntegrationError(
      "RECOVERY_BUDGET",
      "Recovery exceeds the 5,000-block budget. Create a replacement version to start from a recent window.",
    );
  }

  for await (const block of consume({
    endpoint: config.SUBSTREAMS_ENDPOINT,
    apiKey: config.SUBSTREAMS_API_KEY,
    token: config.SUBSTREAMS_API_TOKEN,
    packageBytes: bytes,
    startBlock: proof.startBlock,
    cursor: checkpoint?.cursor,
    signal,
  })) {
    if (block.type === "undo") {
      await persistUndo(sql, deployment, owner, block, expectedGeneration);

      throw new Error("Finality violation.");
    }

    if (Date.now() - checkedAt > 30_000) {
      finalized = await rpc.getBlock({ blockTag: "finalized" });
      checkedAt = Date.now();
    }

    const current =
      BigInt(block.number) >= finalized.number - 5n &&
      Date.now() / 1000 - Number(finalized.timestamp) < 1200;
    const events = await normalizeBlock(block, rpc, (code) =>
      log("pipeline.data.degraded", { deploymentId: id, code }),
    );

    await persistBlock(
      sql,
      deployment,
      owner,
      block,
      events,
      current,
      finalized.number.toString(),
      expectedGeneration,
    );
  }
}
