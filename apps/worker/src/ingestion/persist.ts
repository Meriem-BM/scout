import { randomUUID } from "node:crypto";

import {
  evaluate,
  LIMITS,
  maxWindow,
  normalizeLegacySwap,
  SwapEventSchema,
} from "@scout/domain";
import { swapCandidate } from "@scout/integrations/uniswap-candidate";

import { persistCandidate } from "./candidates";
import { commitProgramProgress } from "./program";

import type { DatabaseConnection, Deployment } from "@scout/database";
import type { SwapEvent } from "@scout/domain";
import type { StreamBlock, StreamUndo } from "@scout/integrations/substreams";

export async function persistBlock(
  sql: DatabaseConnection,
  deployment: Deployment,
  owner: string,
  block: StreamBlock,
  events: SwapEvent[],
  caughtUp: boolean,
  networkHead: string = block.number,
  expectedGeneration?: number,
) {
  await sql.begin(async (tx) => {
    const lease =
      await tx`select deployment_id from app_private.pipeline_leases where deployment_id=${deployment.id} and owner=${owner} and (${expectedGeneration ?? null}::bigint is null or generation=${expectedGeneration ?? null}) and expires_at>now() for update`;

    if (!lease[0]) {
      throw new Error("Pipeline lease lost.");
    }

    const watches =
      await tx`select * from public.watches where id=${deployment.watch_id} for update`;
    const watch = watches[0];

    if (!watch || watch.desired_state !== "running") {
      throw new Error("Watch is no longer running.");
    }

    if (
      watch.active_version_id !== deployment.version_id &&
      watch.pending_version_id !== deployment.version_id
    ) {
      throw new Error("Deployment was replaced.");
    }

    const checkpoints =
      await tx`select block_number::text,cursor from app_private.checkpoints where deployment_id=${deployment.id}`;
    const previous = checkpoints[0];

    if (previous && BigInt(previous.block_number) >= BigInt(block.number)) {
      return;
    }

    const newEvents: SwapEvent[] = [];

    for (const event of events) {
      const inserted =
        await tx`insert into app_private.events(deployment_id,id,block_number,block_time,pool,payload) values(${deployment.id},${event.id},${event.blockNumber},to_timestamp(${event.timestamp}),${event.pool},${tx.json(event)}) on conflict do nothing returning id`;

      if (inserted[0]) {
        newEvents.push(event);
      }
    }

    let active = watch.active_version_id === deployment.version_id;
    const preparingInitial =
      !watch.active_version_id &&
      watch.pending_version_id === deployment.version_id;
    let unvaluedWindow = false;
    const requiresBaseline = deployment.spec.conditions.some(
      (condition) => condition.kind === "aggregate",
    );
    const observationFrom =
      typeof deployment.proof.observationFromTime === "number"
        ? deployment.proof.observationFromTime
        : block.timestamp;
    const historyReady =
      !requiresBaseline ||
      observationFrom <= block.timestamp - maxWindow(deployment.spec);
    let history: SwapEvent[] = [];

    if (caughtUp || active) {
      const rows =
        await tx`select payload from app_private.events where deployment_id=${deployment.id} and block_time>to_timestamp(${block.timestamp - maxWindow(deployment.spec)}) order by block_time limit ${LIMITS.eventsPerWindow + 1}`;

      history = rows.map((row) => SwapEventSchema.parse(row.payload));

      if (history.length > LIMITS.eventsPerWindow) {
        throw new Error("Window capacity exceeded.");
      }

      unvaluedWindow = history.some((event) => event.valuation === null);
    }

    const ready = caughtUp && historyReady && !unvaluedWindow;

    if (deployment.workflow_id && !ready) {
      const workflow = (
        await tx`select state from public.watch_workflows where id=${deployment.workflow_id}`
      )[0];

      const lastProgress =
        workflow?.state === "CATCHING_UP"
          ? (
              await tx`select metadata->>'pipelineHead' as head from public.watch_workflow_events where workflow_id=${deployment.workflow_id} and type in ('deployment.catchup','deployment.catchup.progress') order by sequence desc limit 1`
            )[0]?.head
          : null;
      const progressDue =
        workflow?.state === "CATCHING_UP" &&
        typeof lastProgress === "string" &&
        /^\d+$/.test(lastProgress) &&
        BigInt(block.number) - BigInt(lastProgress) >= 100n;

      if (progressDue) {
        await tx`select app_private.append_workflow_event(${deployment.workflow_id},'CATCHING_UP','deployment.catchup.progress','active','Processing history toward chain head','Substreams delivered another finalized range. These recorded heads describe the stream at this checkpoint.',${tx.json({ pipelineHead: block.number, networkHead, lag: (BigInt(networkHead) - BigInt(block.number)).toString() })})`;
      }

      if (workflow?.state === "DEPLOYMENT_VERIFYING") {
        await tx`select app_private.append_workflow_event(${deployment.workflow_id},'CATCHING_UP','deployment.catchup','active','Catching up with Ethereum',${`Pipeline head ${block.number}; finalized network head ${networkHead}. Historical finalized data is being processed.`},${tx.json({ pipelineHead: block.number, networkHead, lag: (BigInt(networkHead) - BigInt(block.number)).toString() })})`;
      }
    }

    if (ready && watch.pending_version_id === deployment.version_id) {
      await tx`update public.pipeline_deployments set state='retired' where watch_id=${deployment.watch_id} and version_id<>${deployment.version_id} and state<>'failed'`;
      await tx`update public.watches set active_version_id=${deployment.version_id},pending_version_id=null,name=${deployment.spec.name},status='watching',error=null where id=${deployment.watch_id}`;

      if (deployment.workflow_id) {
        await tx`select app_private.append_workflow_event(${deployment.workflow_id},'LIVE','deployment.live','complete','Watch is live',${`The verified stream processed finalized block ${block.number} with network head ${networkHead}.`},${tx.json({ pipelineHead: block.number, networkHead, lag: (BigInt(networkHead) - BigInt(block.number)).toString(), deploymentId: deployment.id })})`;
      }

      active = true;
    }

    if (ready && active && deployment.workflow_id) {
      const workflow = (
        await tx`select state from public.watch_workflows where id=${deployment.workflow_id}`
      )[0];

      if (workflow?.state === "DEPLOYMENT_VERIFYING") {
        await tx`select app_private.append_workflow_event(${deployment.workflow_id},'LIVE','deployment.live','complete','Watch is live','The reverified pipeline resumed its saved cursor and reached finalized chain head.',${tx.json({ pipelineHead: block.number, networkHead })})`;
      }
    }

    if (active) {
      for (const event of newEvents) {
        const detection = evaluate(deployment.spec, event, history, {
          from:
            typeof deployment.proof.observationFromTime === "number"
              ? deployment.proof.observationFromTime
              : block.timestamp,
          through: block.timestamp,
        });

        await persistCandidate(
          tx as unknown as DatabaseConnection,
          deployment,
          swapCandidate(event),
          detection,
          "legacy",
          normalizeLegacySwap(event),
        );

        if (!detection) {
          continue;
        }

        const groupKey = deployment.spec.investigation
          .requireNoPriorUniswapSwaps
          ? `${deployment.version_id}:${event.id}:${event.initiator}`
          : `${deployment.version_id}:${event.pool}:${detection.initiator ?? "pool"}:${Math.floor(event.timestamp / (deployment.spec.cooldownSeconds ?? LIMITS.incidentCooldownSeconds))}`;
        const id = randomUUID();
        const title = detection.matches.some(
          (match) => match.condition === "aggregate",
        )
          ? "An activity pattern matched this Watch"
          : detection.initiator
            ? "Repeated selling from one initiator"
            : detection.matches.some(
                  (match) =>
                    match.condition === "pool_selling" && match.matched,
                )
              ? "Pool selling crossed your threshold"
              : "A sale crossed your threshold";
        const inserted =
          await tx`insert into public.incidents(id,watch_id,user_id,version_id,group_key,title,detection,delivery,created_at,updated_at) values(${id},${deployment.watch_id},${deployment.user_id},${deployment.version_id},${groupKey},${title},${tx.json(detection)},'inbox_only',to_timestamp(${event.timestamp}),to_timestamp(${event.timestamp})) on conflict(watch_id,group_key) do nothing returning id`;
        const incidentId =
          inserted[0]?.id ??
          (
            await tx`select id from public.incidents where watch_id=${deployment.watch_id} and group_key=${groupKey}`
          )[0]?.id;

        if (typeof incidentId !== "string") {
          throw new Error("Incident persistence failed.");
        }

        if (!inserted[0]) {
          await tx`update public.incidents set detection=${tx.json(detection)},explanation=null,updated_at=to_timestamp(${event.timestamp}) where id=${incidentId}`;
        }

        // Keep the latest matching window, bounded to 200 traceable records. Count/value remain exact in detection.
        await tx`delete from public.incident_evidence where incident_id=${incidentId}`;

        for (const evidence of history
          .filter((item) => detection.evidenceIds.includes(item.id))
          .slice(-LIMITS.evidencePerIncident)) {
          await tx`insert into public.incident_evidence(incident_id,user_id,event_id,payload) values(${incidentId},${deployment.user_id},${evidence.id},${tx.json(evidence)})`;
        }

        await tx`update public.watches set last_event_at=to_timestamp(${event.timestamp}) where id=${deployment.watch_id}`;

        if (!inserted[0]) {
          await tx`select app_private.enqueue('enrich',${tx.json({ incidentId })},${`enrich:${incidentId}:${Math.floor(event.timestamp / 300)}`})`;
        }

        if (inserted[0]) {
          await tx`select app_private.enqueue('enrich',${tx.json({ incidentId })},${"enrich:" + incidentId})`;
        }
      }
    }

    await commitProgramProgress(
      tx as unknown as DatabaseConnection,
      deployment.version_id,
      deployment.id,
      block,
    );
    await tx`insert into app_private.checkpoints(deployment_id,cursor,block_number,block_hash,block_time) values(${deployment.id},${block.cursor},${block.number},${block.hash},to_timestamp(${block.timestamp})) on conflict(deployment_id) do update set cursor=excluded.cursor,block_number=excluded.block_number,block_hash=excluded.block_hash,block_time=excluded.block_time,updated_at=now()`;

    const status =
      !caughtUp || !historyReady
        ? "backfilling"
        : unvaluedWindow
          ? "delayed"
          : "watching";
    const dataError = unvaluedWindow
      ? "USD valuation is unavailable for some events in the observation window. Baseline comparisons require complete values. Check archive RPC and oracle availability."
      : !historyReady
        ? "Processing the complete observation window before activation."
        : null;

    await tx`update public.pipeline_deployments set last_block=${block.number},last_block_time=to_timestamp(${block.timestamp}),last_message_at=now(),state=${status},error=${dataError} where id=${deployment.id}`;

    if (active || preparingInitial) {
      await tx`update public.watches set last_block=${block.number},last_block_time=to_timestamp(${block.timestamp}),status=${
        deployment.workflow_id && ready
          ? "live"
          : deployment.workflow_id && !active && !ready
            ? "catching_up"
            : status
      },error=${dataError} where id=${deployment.watch_id}`;
    }

    await tx`delete from app_private.events where deployment_id=${deployment.id} and block_time<to_timestamp(${block.timestamp - 7200})`;
  });
}

export async function persistUndo(
  sql: DatabaseConnection,
  deployment: Deployment,
  owner: string,
  undo: StreamUndo,
  expectedGeneration?: number,
) {
  await sql.begin(async (tx) => {
    const lease =
      await tx`select deployment_id from app_private.pipeline_leases where deployment_id=${deployment.id} and owner=${owner} and (${expectedGeneration ?? null}::bigint is null or generation=${expectedGeneration ?? null}) and expires_at>now() for update`;

    if (!lease[0]) {
      throw new Error("Pipeline lease lost.");
    }

    await tx`delete from app_private.events where deployment_id=${deployment.id} and block_number>${undo.number}`;

    const affected =
      await tx`update public.incidents i set status='retracted',delivery='muted' where version_id=${deployment.version_id} and exists(select 1 from public.incident_evidence e where e.incident_id=i.id and (e.payload->>'blockNumber')::numeric>${undo.number}) returning id`;

    for (const incident of affected) {
      await tx`update public.incident_evidence set payload=jsonb_set(payload,'{finality}','"retracted"') where incident_id=${incident.id} and (payload->>'blockNumber')::numeric>${undo.number}`;
      await tx`update public.notification_deliveries set status='muted',error_code='FINALITY_VIOLATION' where incident_id=${incident.id} and status in ('queued','sending')`;
    }

    await tx`update app_private.checkpoints set cursor=${undo.cursor},block_number=${undo.number},block_hash=${undo.hash},updated_at=now() where deployment_id=${deployment.id}`;
    await tx`update public.pipeline_deployments set state='failed',error='Finalized chain data was retracted. Review before resuming.' where id=${deployment.id}`;

    if (deployment.workflow_id) {
      await tx`update public.watch_workflows set error_category='STREAM',error_code='FINALITY_VIOLATION',error_message='Finalized chain data was retracted. Scout stopped this Watch before accepting more evidence.',recoverable=false where id=${deployment.workflow_id}`;
      await tx`select app_private.append_workflow_event(${deployment.workflow_id},'FAILED','stream.finality.failed','failed','Finality guarantee was violated','Finalized chain data was retracted. Scout stopped this Watch and muted affected queued deliveries.',${tx.json({ blockNumber: undo.number, affectedIncidents: affected.length })})`;
    }

    await tx`update public.watches set status='failed',desired_state='paused',error='Finality violation: affected evidence was retracted. Operator review required.' where id=${deployment.watch_id}`;
  });
}
