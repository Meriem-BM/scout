import { getAddress } from "viem";
import { z } from "zod";

import { loadIncident } from "@scout/database";
import { ContextSchema, investigationDecision } from "@scout/domain";
import { evidenceExplanation, GroqAdapter } from "@scout/integrations/ai";
import { GraphAdapter } from "@scout/integrations/graph";
import { IntegrationError } from "@scout/integrations/http";
import { TelegramAdapter } from "@scout/integrations/telegram";
import { TransactionSchema } from "@scout/integrations/uniswap";

import { log } from "../log";
import { buildDeployment } from "../pipeline/build";
import { runWatchWorkflow } from "../workflow/watch-workflow";

import { deliverEmail } from "./email";
import { fencedWorkflowDatabase } from "./fence";
import { deliverFindingTelegram, mirrorLegacyDecision } from "./findings";

import type { WorkerConfig } from "../config";
import type { DatabaseConnection, Job } from "@scout/database";
import type { Ethereum } from "@scout/integrations/ethereum";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function handleJob(
  job: Job,
  sql: DatabaseConnection,
  storage: SupabaseClient,
  rpc: Ethereum,
  config: WorkerConfig,
  signal: AbortSignal,
) {
  if (job.kind === "workflow") {
    const { workflowId } = z
      .object({ workflowId: z.string().uuid() })
      .parse(job.payload);

    return runWatchWorkflow(
      fencedWorkflowDatabase(sql, job),
      storage,
      rpc,
      config,
      workflowId,
      signal,
    );
  }

  if (job.kind === "email") {
    return deliverEmail(sql, job, config);
  }

  if (job.kind === "build") {
    const { deploymentId } = z
      .object({ deploymentId: z.string().uuid() })
      .parse(job.payload);

    const buildSql = fencedWorkflowDatabase(sql, job);

    await buildDeployment(buildSql, storage, config, rpc, deploymentId, signal);

    const workflow = (
      await buildSql`select workflow_id from public.pipeline_deployments where id=${deploymentId}`
    )[0]?.workflow_id;

    if (workflow) {
      await buildSql`select app_private.append_workflow_event(${workflow},'DEPLOYMENT_VERIFYING','deployment.reverified','complete','Pipeline and acceptance checks passed','Waiting for a new finalized stream checkpoint before reporting live.', '{}')`;
    }

    return;
  }

  if (job.kind === "enrich") {
    const { incidentId } = z
      .object({ incidentId: z.string().uuid() })
      .parse(job.payload);
    const incident = await loadIncident(sql, incidentId);
    let context;

    try {
      context = await new GraphAdapter(
        config.GRAPH_API_KEY,
        config.GRAPH_SUBGRAPH_ID,
      ).context(incident);
    } catch {
      log("incident.enrichment.unavailable", { incidentId });
      context = ContextSchema.parse({
        status: "unavailable",
        subgraphId:
          config.GRAPH_SUBGRAPH_ID ??
          "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
        deployment: null,
        blockNumber: null,
        blockHash: null,
        refreshedAt: new Date().toISOString(),
        from: incident.detection.timestamp - 86400,
        to: incident.detection.timestamp,
        sampledSwaps: 0,
        volumeUsd: null,
        priorInitiatorTransactions: null,
        note: "Graph history is temporarily unavailable. Deterministic swap evidence is preserved.",
      });
    }

    let explanation = evidenceExplanation(incident);

    if (config.GROQ_API_KEY) {
      try {
        explanation = await new GroqAdapter(
          config.GROQ_API_KEY,
          config.GROQ_MODEL,
        ).explain({ ...incident, context });
      } catch {
        log("incident.explanation.fallback", { incidentId });
      }
    }

    const requiresNoPrior =
      incident.spec.investigation.requireNoPriorUniswapSwaps;

    if (
      requiresNoPrior &&
      context.priorActivity &&
      investigationDecision(true, context.priorActivity) !== "PENDING"
    ) {
      const absent =
        context.priorActivity.status === "NONE_WITH_PROVEN_COVERAGE";

      explanation = {
        ...explanation,
        facts: [
          ...explanation.facts,
          {
            text: absent
              ? "No prior Uniswap V3 activity was found within verified coverage for this transaction initiator."
              : "The indexed Uniswap v3 history contains an earlier swap from this transaction initiator.",
            evidenceIds: incident.detection.evidenceIds,
          },
        ],
        interpretation: absent
          ? explanation.interpretation
          : "The swap crossed the deterministic amount threshold, but the initiator had prior indexed Uniswap v3 activity. Scout suppressed the alert because the complete Watch rule did not match.",
      };
    }

    await sql.begin(async (tx) => {
      const current = (
        await tx`select id, md5(detection::text) revision from public.incidents where id=${incidentId} and detection=${tx.json(incident.detection)} and status<>'retracted' for update`
      )[0];

      if (!current) {
        return;
      } // Evidence changed while Graph/model requests were running.

      const priorDecision = (
        await tx`select status,evidence from public.investigation_decisions where incident_id=${incidentId} and revision=${current.revision}`
      )[0];

      if (priorDecision && priorDecision.status !== "PENDING") {
        await mirrorLegacyDecision(
          tx as unknown as DatabaseConnection,
          incidentId,
          priorDecision.status,
          priorDecision.evidence,
        );

        return;
      }

      const decision = investigationDecision(
        requiresNoPrior,
        context.priorActivity,
      );

      await tx`update public.incidents set context=${tx.json(context)},explanation=${tx.json(explanation)},last_enriched_at=now() where id=${incidentId}`;
      await tx`insert into public.investigation_decisions(incident_id,revision,status,evidence,next_attempt_at) values(${incidentId},${current.revision},${decision},${tx.json(context.priorActivity ?? { reason: "No required historical predicate" })},case when ${decision}='PENDING' then now()+interval '1 minute' else null end) on conflict(incident_id,revision) do update set status=excluded.status,evidence=excluded.evidence,next_attempt_at=excluded.next_attempt_at,attempts=public.investigation_decisions.attempts+1 where public.investigation_decisions.status='PENDING'`;

      // During the compatibility migration the existing revision-fenced investigation
      // owns historical truth. Copy only its actual decision, never infer it from a title.
      await mirrorLegacyDecision(
        tx as unknown as DatabaseConnection,
        incidentId,
        decision,
        context.priorActivity ?? { reason: "No required historical predicate" },
      );

      if (decision === "PENDING") {
        await tx`update public.incidents set delivery='inbox_only' where id=${incidentId}`;

        return; // Durable pending decision is retried by the supervisor, not failed delivery.
      }

      if (decision === "SUPPRESS") {
        await tx`update public.incidents set delivery='muted' where id=${incidentId}`;

        return;
      }

      const delivery = (
        await tx`select w.user_id,w.destination_overrides,w.muted_until,w.desired_state,p.telegram,p.email,t.user_id telegram_user,e.id email_id,e.address email_address
          from public.watches w
          left join public.account_preferences p on p.user_id=w.user_id
          left join app_private.telegram_connections t on t.user_id=w.user_id
          left join app_private.email_connections e on e.user_id=w.user_id and e.enabled and not e.suppressed
          where w.id=${incident.watchId}`
      )[0];

      if (!delivery || delivery.desired_state !== "running") {
        await tx`update public.incidents set delivery='muted' where id=${incidentId}`;

        return;
      }

      const muted =
        delivery.muted_until &&
        new Date(delivery.muted_until).getTime() > Date.now();
      const overrides = delivery.destination_overrides as {
        telegram?: boolean;
        email?: boolean;
      } | null;
      const telegram = overrides?.telegram ?? delivery.telegram ?? true;
      const email = overrides?.email ?? delivery.email ?? false;
      let queued = false;

      if (!muted && telegram && delivery.telegram_user) {
        await tx`insert into public.notification_deliveries(incident_id,user_id,channel) values(${incidentId},${delivery.user_id},'telegram') on conflict(incident_id,channel) do nothing`;
        await tx`select app_private.enqueue('notify',${tx.json({ incidentId })},${"notify:" + incidentId})`;
        queued = true;
      }

      if (!muted && email && delivery.email_id && delivery.email_address) {
        await tx`select app_private.queue_email(${delivery.user_id},'incident',${delivery.email_address},null,${`incident:${incidentId}:email`},${delivery.email_id},${incidentId})`;
        queued = true;
      }

      await tx`update public.incidents set delivery=${queued ? "queued" : muted ? "muted" : "inbox_only"} where id=${incidentId}`;
    });

    return;
  }

  if (job.kind === "test_alert") {
    const { userId } = z
      .object({ userId: z.string().uuid() })
      .parse(job.payload);
    const connection = (
      await sql`select chat_id,test_status from app_private.telegram_connections where user_id=${userId}`
    )[0];

    if (!connection || !config.TELEGRAM_BOT_TOKEN) {
      await sql`update app_private.telegram_connections set test_status='failed',error='Telegram setup is required on the monitoring worker.' where user_id=${userId}`;

      throw new Error("Telegram is not configured.");
    }

    if (["sent", "ambiguous"].includes(connection.test_status)) {
      return;
    }

    if (connection.test_status === "sending") {
      await sql`update app_private.telegram_connections set test_status='ambiguous',error='Test send was interrupted; delivery is unknown. Check Telegram before requesting another.' where user_id=${userId}`;

      return;
    }

    await sql`update app_private.telegram_connections set test_status='sending' where user_id=${userId}`;

    try {
      const messageId = await new TelegramAdapter(
        config.TELEGRAM_BOT_TOKEN,
        config.SCOUT_SITE_URL,
      ).test(z.string().parse(connection.chat_id));

      await sql`update app_private.telegram_connections set error=null,test_status='sent',test_message_id=${messageId},test_sent_at=now() where user_id=${userId}`;
    } catch (error) {
      const ambiguous = error instanceof IntegrationError && error.ambiguous;

      await sql`update app_private.telegram_connections set test_status=${ambiguous ? "ambiguous" : job.attempts >= job.max_attempts ? "failed" : "queued"},error=${ambiguous ? "Delivery result unknown. Check Telegram before retrying." : "Telegram test delivery failed. Check bot configuration and reconnect."} where user_id=${userId}`;

      if (!ambiguous) {
        throw error;
      }
    }

    return;
  }

  if (job.kind === "notify") {
    if (job.payload.findingId) {
      return deliverFindingTelegram(
        sql,
        z.string().uuid().parse(job.payload.findingId),
        config,
      );
    }

    const { incidentId } = z
      .object({ incidentId: z.string().uuid() })
      .parse(job.payload);
    const incident = await loadIncident(sql, incidentId);

    if (
      incident.spec.investigation.requireNoPriorUniswapSwaps &&
      !(
        await sql`select 1 from public.investigation_decisions d join public.incidents i on i.id=d.incident_id where i.id=${incidentId} and d.revision=md5(i.detection::text) and d.status='ALERT'`
      )[0]
    ) {
      return;
    }

    const rows =
      await sql`select d.id,d.status,c.chat_id,c.muted_until connection_mute,w.muted_until watch_mute,w.desired_state,coalesce((w.destination_overrides->>'telegram')::boolean,p.telegram,true) enabled from public.notification_deliveries d join public.watches w on w.id=${incident.watchId} left join app_private.telegram_connections c on c.user_id=d.user_id left join public.account_preferences p on p.user_id=d.user_id where d.incident_id=${incidentId} and d.channel='telegram'`;
    const row = rows[0];

    if (!row) {
      throw new Error("Outbox record is missing.");
    }

    if (["sent", "ambiguous", "muted"].includes(row.status)) {
      return;
    }

    const setStatus = async (status: string, code: string | null) => {
      await sql.begin(async (tx) => {
        await tx`update public.notification_deliveries set status=${status},error_code=${code} where id=${row.id}`;
        await tx`update public.incidents set delivery=${status} where id=${incidentId}`;
      });
    };

    if (row.status === "sending") {
      await setStatus("ambiguous", "WORKER_INTERRUPTED_DURING_DELIVERY");

      return;
    }

    if (
      !row.chat_id ||
      !row.enabled ||
      incident.status === "retracted" ||
      row.desired_state !== "running" ||
      [row.connection_mute, row.watch_mute].some(
        (value) => value && new Date(value).getTime() > Date.now(),
      )
    ) {
      await setStatus("muted", null);

      return;
    }

    if (!config.TELEGRAM_BOT_TOKEN) {
      await setStatus("failed", "TELEGRAM_SETUP_REQUIRED");

      throw new Error("Telegram token is missing.");
    }

    await sql`update public.notification_deliveries set status='sending',attempts=attempts+1 where id=${row.id}`;

    try {
      const messageId = await new TelegramAdapter(
        config.TELEGRAM_BOT_TOKEN,
        config.SCOUT_SITE_URL,
      ).send(z.string().parse(row.chat_id), incident);

      await sql.begin(async (tx) => {
        await tx`update public.notification_deliveries set status='sent',message_id=${messageId},sent_at=now(),error_code=null where id=${row.id}`;
        await tx`update public.incidents set delivery='sent' where id=${incidentId}`;
      });
    } catch (error) {
      if (error instanceof IntegrationError && error.ambiguous) {
        await setStatus("ambiguous", "NETWORK_RESULT_UNKNOWN");

        return;
      }

      await setStatus(
        job.attempts >= job.max_attempts ? "failed" : "queued",
        error instanceof IntegrationError ? error.code : "DELIVERY_ERROR",
      );

      throw error;
    }

    return;
  }

  if (job.kind === "reconcile") {
    const { intentId } = z
      .object({ intentId: z.string().uuid() })
      .parse(job.payload);
    const row = (
      await sql`select * from public.transaction_intents where id=${intentId} and state in ('pending','unknown')`
    )[0];

    if (!row || !row.transaction_hash) {
      return;
    }

    const hash = z
      .custom<`0x${string}`>(
        (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value),
      )
      .parse(row.transaction_hash);
    const tx = await rpc.getTransaction({ hash });
    const prepared = TransactionSchema.parse(row.prepared_transaction);

    if (
      tx.from.toLowerCase() !== row.wallet ||
      tx.to?.toLowerCase() !== prepared.to ||
      tx.input.toLowerCase() !== prepared.data.toLowerCase() ||
      tx.value !== BigInt(prepared.value) ||
      tx.chainId !== 1
    ) {
      await sql`update public.transaction_intents set state='unknown',updated_at=now() where id=${intentId}`;

      return;
    }

    const receipt = await rpc.getTransactionReceipt({ hash });
    const head = await rpc.getBlockNumber();

    if (head - receipt.blockNumber + 1n < 2n) {
      throw new IntegrationError("PENDING", "Waiting for confirmations.", 30);
    }

    await sql`update public.transaction_intents set state=${receipt.status === "success" ? "confirmed" : "reverted"},updated_at=now() where id=${intentId}`;
    log("transaction.reconciled", {
      intentId,
      status: receipt.status,
      wallet: getAddress(row.wallet),
    });
  }
}
