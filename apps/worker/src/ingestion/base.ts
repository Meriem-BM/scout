import {
  Erc20WatchSpecSchema,
  evaluateTransfer,
  PipelinePlanSchema,
} from "@scout/domain";
import { baseRpc, normalizeTransfers } from "@scout/integrations/erc20";
import { consumeOutput } from "@scout/integrations/substreams";

import { sha256 } from "../pipeline/generate";

import { persistCandidate } from "./candidates";
import { commitProgramProgress } from "./program";

import type { WorkerConfig } from "../config";
import type { DatabaseConnection } from "@scout/database";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function runBasePipeline(
  sql: DatabaseConnection,
  storage: SupabaseClient,
  config: WorkerConfig,
  id: string,
  owner: string,
  signal: AbortSignal,
  expectedGeneration?: number,
) {
  if (!config.BASE_RPC_URL || !config.BASE_SUBSTREAMS_ENDPOINT) {
    throw new Error("Base providers not configured");
  }

  const deployment = (
    await sql`select d.*,v.spec from public.pipeline_deployments d join public.watch_versions v on v.id=d.version_id where d.id=${id}`
  )[0]!;
  const spec = Erc20WatchSpecSchema.parse(deployment.spec);

  if (
    deployment.proof.pipelineStatus !== "PIPELINE_VERIFIED" ||
    deployment.proof.intentAcceptanceStatus !== "INTENT_ACCEPTANCE_VERIFIED"
  ) {
    throw new Error("Both verification gates are required");
  }

  const plan = PipelinePlanSchema.parse(
    (
      await sql`select payload from public.watch_workflow_outputs where workflow_id=${deployment.workflow_id} and kind='pipeline_plan'`
    )[0]?.payload,
  );
  const artifact = (
    await sql`select * from app_private.artifacts where hash=${deployment.artifact_hash}`
  )[0]!;
  const downloaded = await storage.storage
    .from("pipeline-artifacts")
    .download(artifact.storage_path);

  if (downloaded.error) {
    throw downloaded.error;
  }

  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());

  if (sha256(bytes) !== artifact.package_sha256) {
    throw new Error("Artifact checksum mismatch");
  }

  const checkpoint = (
    await sql`select cursor,block_number::text from app_private.checkpoints where deployment_id=${id}`
  )[0];
  const rpc = baseRpc(config.BASE_RPC_URL);

  if ((await rpc.getChainId()) !== spec.chainId) {
    throw new Error("Wrong chain RPC");
  }

  for await (const block of consumeOutput({
    endpoint: config.BASE_SUBSTREAMS_ENDPOINT,
    apiKey: config.SUBSTREAMS_API_KEY,
    token: config.SUBSTREAMS_API_TOKEN,
    packageBytes: bytes,
    network: "base",
    parameters: plan.parameters,
    outputModule: plan.dependencies[0]!.module,
    startBlock: deployment.proof.startBlock,
    cursor: checkpoint?.cursor,
    signal,
  })) {
    if (block.type === "undo") {
      throw new Error(
        "Unexpected finalized chain rollback; monitoring stopped",
      );
    }

    const head = await rpc.getBlock({ blockTag: "finalized" });
    const caughtUp =
      BigInt(block.number) >= head.number - 5n &&
      Date.now() / 1000 - Number(head.timestamp) < 1200;
    const events = await normalizeTransfers(block, rpc);

    await sql.begin(async (tx) => {
      if (
        !(
          await tx`select 1 from app_private.pipeline_leases where deployment_id=${id} and owner=${owner} and (${expectedGeneration ?? null}::bigint is null or generation=${expectedGeneration ?? null}) and expires_at>now() for update`
        )[0]
      ) {
        throw new Error("Pipeline lease lost");
      }

      const watch = (
        await tx`select * from public.watches where id=${deployment.watch_id} for update`
      )[0];

      if (
        !watch ||
        watch.desired_state !== "running" ||
        ![watch.active_version_id, watch.pending_version_id].includes(
          deployment.version_id,
        )
      ) {
        throw new Error("Watch stopped or replaced");
      }

      const previous = (
        await tx`select block_number::text from app_private.checkpoints where deployment_id=${id}`
      )[0];

      if (previous && BigInt(previous.block_number) >= BigInt(block.number)) {
        return;
      }

      for (const event of events) {
        await persistCandidate(
          tx as unknown as DatabaseConnection,
          {
            id,
            watch_id: deployment.watch_id,
            user_id: deployment.user_id,
            version_id: deployment.version_id,
          },
          event,
          evaluateTransfer(spec, event),
        );
      }

      await commitProgramProgress(
        tx as unknown as DatabaseConnection,
        deployment.version_id,
        id,
        block,
      );
      await tx`insert into app_private.checkpoints(deployment_id,cursor,block_number,block_hash,block_time) values(${id},${block.cursor},${block.number},${block.hash},to_timestamp(${block.timestamp})) on conflict(deployment_id) do update set cursor=excluded.cursor,block_number=excluded.block_number,block_hash=excluded.block_hash,block_time=excluded.block_time,updated_at=now()`;
      await tx`update public.pipeline_deployments set state=${caughtUp ? "watching" : "backfilling"},last_block=${block.number},last_block_time=to_timestamp(${block.timestamp}),last_message_at=now(),error=null where id=${id}`;
      await tx`update public.watches set last_block=${block.number},last_block_time=to_timestamp(${block.timestamp}) where id=${deployment.watch_id}`;

      if (caughtUp && watch.pending_version_id === deployment.version_id) {
        await tx`update public.pipeline_deployments set state='retired' where watch_id=${deployment.watch_id} and id<>${id}`;
        await tx`update public.watches set active_version_id=${deployment.version_id},pending_version_id=null,status='watching',error=null where id=${deployment.watch_id}`;
        await tx`select app_private.append_workflow_event(${deployment.workflow_id},'LIVE','deployment.live','complete','Watch is live','The parameterized Base stream passed both verification gates and reached finalized chain head.',${tx.json({ pipelineHead: block.number, networkHead: head.number.toString(), strategy: "PARAMETERIZE" })})`;
      } else if (!caughtUp) {
        await tx`update public.watches set status='backfilling' where id=${deployment.watch_id}`;

        if (!previous) {
          await tx`select app_private.append_workflow_event(${deployment.workflow_id},'CATCHING_UP','deployment.catchup','active','Catching up with Base','Processing actual finalized historical blocks.',${tx.json({ pipelineHead: block.number, networkHead: head.number.toString() })})`;
        }
      } else {
        await tx`update public.watches set status='watching',error=null where id=${deployment.watch_id}`;
      }
    });
  }
}
