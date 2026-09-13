import { isDeepStrictEqual } from "node:util";

import {
  type CandidateEvent,
  CandidateEventSchema,
  evaluateWatchProgram,
  ExecutableWatchSpecSchema,
  migrateExecutableProgram,
  normalizeCandidate,
  type NormalizedOnchainEvent,
  NormalizedOnchainEventSchema,
  requireValidatedProgram,
  WatchProgramSchema,
} from "@scout/domain";

import { queueFindingDelivery } from "../jobs/findings";
import { log } from "../log";

import type { DatabaseConnection } from "@scout/database";

/** Runs under the caller's fenced block transaction and Watch lock. No cursor is
 * advanced if evidence, program identity or persistence fails. Legacy incidents
 * remain the delivery owner until the finding outbox migration is complete. */
export async function persistProgramEvent(
  tx: DatabaseConnection,
  deployment: {
    id: string;
    watch_id: string;
    user_id: string;
    version_id: string;
  },
  candidate: CandidateEvent | NormalizedOnchainEvent,
  deliveryOwner: "legacy" | "finding" = "finding",
  normalized?: NormalizedOnchainEvent,
) {
  const row = (
    await tx`select v.spec,d.artifact_hash,d.proof,a.module_name,a.package_sha256 from public.watch_versions v join public.pipeline_deployments d on d.version_id=v.id left join app_private.artifacts a on a.hash=d.artifact_hash where v.id=${deployment.version_id} and d.id=${deployment.id}`
  )[0];

  if (!row) {
    throw new Error("Program deployment is missing");
  }

  const program = migrateExecutableProgram(
    ExecutableWatchSpecSchema.parse(row.spec),
  );

  if (!program) {
    return;
  }

  requireValidatedProgram(program);

  await tx`insert into public.watch_programs(version_id,watch_id,user_id,language_version,chain_id,event_type,program) values(${deployment.version_id},${deployment.watch_id},${deployment.user_id},1,${program.source.chainId},${program.source.eventType},${tx.json(program)}) on conflict do nothing`;

  const stored = (
    await tx`select program from public.watch_programs where version_id=${deployment.version_id}`
  )[0];

  if (
    JSON.stringify(WatchProgramSchema.parse(stored?.program)) !==
    JSON.stringify(program)
  ) {
    throw new Error("Persisted program differs from immutable Watch version");
  }

  const normalizedInput =
    normalized ?? ("provenance" in candidate ? candidate : null);
  const provenance = {
    source: "substreams" as const,
    package: row.package_sha256 ?? "unavailable",
    module: row.module_name ?? "unavailable",
    decoder: normalizedInput?.provenance.decoder ?? "candidate-envelope-v1",
    pipelineVersion: deployment.id,
  };
  const event = normalizedInput
    ? NormalizedOnchainEventSchema.parse({ ...normalizedInput, provenance })
    : normalizeCandidate(CandidateEventSchema.parse(candidate), provenance);

  // These fields are deliberately not fabricated when older rows lack artifact metadata.
  const inserted =
    await tx`insert into app_private.normalized_events(id,chain_id,block_number,block_hash,block_time,transaction_hash,transaction_index,event_index,actor,subject,contract,protocol,event_type,attributes) values(${event.id},${event.chainId},${event.blockNumber},${event.blockHash},to_timestamp(${event.timestamp}),${event.transactionHash},${event.transactionIndex},${event.eventIndex},${event.actor},${event.subject},${event.contract},${event.protocol},${event.eventType},${tx.json(event.attributes)}) on conflict do nothing returning id`;

  if (inserted[0]) {
    for (const asset of event.assets) {
      await tx`insert into app_private.normalized_assets(event_id,asset,direction,raw_amount,decimals,valuation) values(${event.id},${asset.address},${asset.direction},${asset.rawAmount},${asset.decimals},${asset.valuation ? tx.json(asset.valuation) : null})`;
    }
  } else {
    const existing = (
      await tx`select actor,subject,contract,protocol,event_type,attributes from app_private.normalized_events where id=${event.id}`
    )[0]!;

    if (
      existing.actor !== event.actor ||
      existing.subject !== event.subject ||
      existing.contract !== event.contract ||
      existing.protocol !== event.protocol ||
      existing.event_type !== event.eventType ||
      JSON.stringify(existing.attributes) !== JSON.stringify(event.attributes)
    ) {
      // JSONB key order is not semantically relevant.
      if (
        existing.actor !== event.actor ||
        existing.subject !== event.subject ||
        existing.contract !== event.contract ||
        existing.protocol !== event.protocol ||
        existing.event_type !== event.eventType ||
        !isDeepStrictEqual(existing.attributes, event.attributes)
      ) {
        throw new Error("Conflicting normalized chain evidence");
      }
    }
  }

  const persistedAssets =
    await tx`select asset address,direction,raw_amount::text as "rawAmount",decimals,valuation from app_private.normalized_assets where event_id=${event.id} order by asset`;

  if (
    !isDeepStrictEqual(
      persistedAssets.map((a) => ({
        address: a.address,
        direction: a.direction,
        rawAmount: a.rawAmount,
        decimals: a.decimals,
        valuation: a.valuation,
      })),
      [...event.assets].sort((a, b) => a.address.localeCompare(b.address)),
    )
  ) {
    throw new Error("Conflicting normalized asset evidence");
  }

  await tx`insert into app_private.program_events(version_id,event_id,deployment_id,package,module,decoder,pipeline_version) values(${deployment.version_id},${event.id},${deployment.id},${event.provenance.package},${event.provenance.module},${event.provenance.decoder},${event.provenance.pipelineVersion}) on conflict do nothing`;

  const from =
    program.window.kind === "rolling"
      ? event.timestamp - program.window.seconds
      : event.timestamp;
  const history: NormalizedOnchainEvent[] = [];

  if (program.window.kind === "rolling") {
    const rows =
      await tx`select e.*,extract(epoch from e.block_time)::bigint as timestamp,p.package,p.module,p.decoder,p.pipeline_version,(select jsonb_agg(jsonb_build_object('address',a.asset,'direction',a.direction,'rawAmount',a.raw_amount::text,'decimals',a.decimals,'valuation',a.valuation)) from app_private.normalized_assets a where a.event_id=e.id) assets from app_private.program_events p join app_private.normalized_events e on e.id=p.event_id where p.version_id=${deployment.version_id} and e.block_time>to_timestamp(${from}) and e.block_time<=to_timestamp(${event.timestamp}) limit 50001`;

    if (rows.length > 50000) {
      throw new Error("Program window capacity exceeded");
    }

    for (const e of rows) {
      history.push(
        NormalizedOnchainEventSchema.parse({
          id: e.id,
          chainId: Number(e.chain_id),
          blockNumber: e.block_number,
          blockHash: e.block_hash,
          timestamp: Number(e.timestamp),
          transactionHash: e.transaction_hash,
          transactionIndex: e.transaction_index,
          eventIndex: e.event_index,
          actor: e.actor,
          subject: e.subject,
          contract: e.contract,
          protocol: e.protocol,
          eventType: e.event_type,
          assets: e.assets ?? [],
          attributes: e.attributes,
          provenance: {
            source: "substreams",
            package: e.package,
            module: e.module,
            decoder: e.decoder,
            pipelineVersion: e.pipeline_version,
          },
          finalized: true,
        }),
      );
    }
  }

  const progress = (
    await tx`select extract(epoch from processed_from)::bigint as started from app_private.program_checkpoints where version_id=${deployment.version_id}`
  )[0];
  const evaluationStarted = performance.now();
  const result = evaluateWatchProgram(program, event, history, {
    from: progress ? Number(progress.started) : event.timestamp,
    through: event.timestamp,
  });

  if (result.status !== "MATCH" && result.status !== "PENDING_CONTEXT") {
    return;
  }

  const finding = (
    await tx`insert into public.watch_findings(version_id,watch_id,user_id,deployment_id,anchor_event_id,primary_subject,actor_set,window_from,window_through,evaluation,status) values(${deployment.version_id},${deployment.watch_id},${deployment.user_id},${deployment.id},${event.id},${event.subject},${result.actorSet.length ? result.actorSet : event.actor ? [event.actor] : []},to_timestamp(${from}),to_timestamp(${event.timestamp}),${tx.json(result)},${result.status}) on conflict do nothing returning id`
  )[0];

  if (finding) {
    for (const id of result.evidenceIds.length
      ? result.evidenceIds
      : [event.id]) {
      await tx`insert into public.finding_events(finding_id,event_id) values(${finding.id},${id}) on conflict do nothing`;
    }
  }

  if (finding) {
    log("watch.program.finding", {
      versionId: deployment.version_id,
      status: result.status,
      evaluationMs: performance.now() - evaluationStarted,
      windowEvents: history.length + 1,
    });
    await tx`insert into public.finding_decisions(finding_id,status,evidence) values(${finding.id},${result.status === "MATCH" ? "ALERT" : "PENDING"},${tx.json(result)}) on conflict do nothing`;

    if (deliveryOwner === "finding" && result.status === "MATCH") {
      await queueFindingDelivery(tx, finding.id, program);
    }
  }
}

/** Called once per complete block inside the same fenced transaction as the source cursor. */
export async function commitProgramProgress(
  tx: DatabaseConnection,
  versionId: string,
  deploymentId: string,
  block: { timestamp: number; number: string; hash: string; cursor: string },
) {
  await tx`insert into app_private.program_checkpoints(version_id,deployment_id,processed_from,processed_through,block_number,block_hash,cursor) select version_id,${deploymentId},to_timestamp(${block.timestamp}),to_timestamp(${block.timestamp}),${block.number},${block.hash},${block.cursor} from public.watch_programs where version_id=${versionId} on conflict(version_id) do update set processed_through=excluded.processed_through,block_number=excluded.block_number,block_hash=excluded.block_hash,cursor=excluded.cursor,updated_at=now() where app_private.program_checkpoints.deployment_id=excluded.deployment_id and app_private.program_checkpoints.block_number<=excluded.block_number`;
}
