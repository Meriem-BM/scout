import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { claimJob, connectDatabase, finishJob } from "@scout/database";
import { ethereum } from "@scout/integrations/ethereum";
import { IntegrationError } from "@scout/integrations/http";

import { WorkerEnv } from "./config";
import { runPipeline } from "./ingestion/run";
import { fencedWorkflowDatabase } from "./jobs/fence";
import { handleJob } from "./jobs/handlers";
import { errorCode, log } from "./log";
import { failWorkflow, workflowCategory } from "./workflow/watch-workflow";

const parsed = WorkerEnv.safeParse(process.env);

if (!parsed.success) {
  console.error(
    JSON.stringify({
      event: "worker.configuration.invalid",
      fields: parsed.error.issues.map((issue) => issue.path.join(".")),
    }),
  );
  process.exit(1);
}

const config = parsed.data;
const id = randomUUID();
const shutdown = new AbortController();
const sql = connectDatabase(config.DATABASE_URL);
const rpc = ethereum(config.ETHEREUM_RPC_URL);
const storage = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
let lastDatabaseSuccess = 0;
const running = new Map<
  string,
  { controller: AbortController; promise: Promise<void> }
>();
const server = createServer((request, response) => {
  const ready =
    Date.now() - lastDatabaseSuccess < 45_000 && !shutdown.signal.aborted;

  if (request.url !== "/health/live" && request.url !== "/health/ready") {
    response.writeHead(404).end();

    return;
  }

  response.writeHead(request.url === "/health/ready" && !ready ? 503 : 200, {
    "content-type": "application/json",
  });
  response.end(
    JSON.stringify({
      status:
        request.url === "/health/live" ? "alive" : ready ? "ready" : "degraded",
    }),
  );
});

server.listen(config.PORT, "0.0.0.0");
process.on("SIGTERM", () => shutdown.abort());
process.on("SIGINT", () => shutdown.abort());

async function pause(milliseconds: number) {
  try {
    await delay(milliseconds, undefined, { signal: shutdown.signal });
  } catch (error) {
    if (!shutdown.signal.aborted) {
      throw error;
    }
  }
}

async function jobs(build: boolean) {
  while (!shutdown.signal.aborted) {
    try {
      const job = await claimJob(
        sql,
        id,
        build
          ? ["workflow", "build"]
          : ["notify", "enrich", "reconcile", "test_alert", "email"],
      );

      if (!job) {
        await pause(1000);
        continue;
      }

      log("job.started", {
        jobId: job.id,
        kind: job.kind,
        attempt: job.attempts,
      });

      const jobLease = new AbortController();
      const renew = setInterval(() => {
        void sql`update app_private.jobs set leased_until=now()+interval '4 minutes' where id=${job.id} and leased_by=${id} and leased_until>now() returning id`
          .then((rows) => {
            if (!rows[0]) {
              jobLease.abort();
            }
          })
          .catch((error: unknown) => {
            log("job.lease.error", { jobId: job.id, code: errorCode(error) });
            jobLease.abort();
          });
      }, 30_000);

      try {
        await handleJob(
          job,
          sql,
          storage,
          rpc,
          config,
          AbortSignal.any([shutdown.signal, jobLease.signal]),
        );

        if (jobLease.signal.aborted) {
          throw new Error("Job lease lost.");
        }

        await finishJob(sql, job, id);
        log("job.complete", { jobId: job.id });
      } catch (error) {
        const code =
          error instanceof IntegrationError ? error.code : errorCode(error);

        log("job.failed", { jobId: job.id, kind: job.kind, code });

        const failureSql = fencedWorkflowDatabase(sql, job);

        if (job.kind === "workflow") {
          const workflowId = z.string().uuid().parse(job.payload.workflowId);
          const flow = (
            await failureSql`select state from public.watch_workflows where id=${workflowId}`
          )[0];

          if (flow) {
            const message =
              error instanceof Error
                ? error.message
                : "A provider interrupted the workflow.";

            if (job.attempts >= job.max_attempts) {
              await failWorkflow(
                failureSql,
                workflowId,
                workflowCategory(z.string().parse(flow.state)),
                code,
                `${message} Automatic retries were exhausted; retrying later will reuse completed stages.`,
                true,
              );
            } else {
              await failureSql`select app_private.append_workflow_event(${workflowId},${flow.state},'workflow.retry.scheduled','warning','Provider retry scheduled',${message},${sql.json({ code, attempt: job.attempts, maxAttempts: job.max_attempts })})`;
            }
          }
        }

        if (job.kind === "build") {
          const deploymentId = z
            .string()
            .uuid()
            .parse(job.payload.deploymentId);

          await failureSql`update public.pipeline_deployments set state='failed',error='Package preparation failed. Check the technical proof and worker configuration, then resume to retry.' where id=${deploymentId}`;
          await failureSql`update public.watches w set status=case when active_version_id is null then 'failed' else status end,error='Package preparation failed. Existing monitoring, if any, remains active. Resume retries the pending version.' from public.pipeline_deployments d where d.id=${deploymentId} and w.id=d.watch_id`;
        }

        await finishJob(
          sql,
          job,
          id,
          code,
          error instanceof IntegrationError
            ? (error.retryAfterSeconds ?? 0)
            : 0,
        );
      } finally {
        clearInterval(renew);
      }
    } catch (error) {
      log("worker.queue.error", { code: errorCode(error) });
      await pause(5000);
    }
  }
}

async function supervise() {
  let maintenanceAt = 0;

  while (!shutdown.signal.aborted) {
    try {
      await sql`insert into app_private.worker_heartbeats(id,last_seen,details) values(${id},now(),${sql.json({ pipelines: running.size })}) on conflict(id) do update set last_seen=now(),details=excluded.details`;
      lastDatabaseSuccess = Date.now();

      const desired =
        await sql`select d.id from public.pipeline_deployments d join public.watches w on w.id=d.watch_id where w.desired_state='running' and d.version_id in (w.active_version_id,w.pending_version_id) and d.artifact_hash is not null and d.state in ('starting','backfilling','watching','delayed','paused') order by d.created_at limit 10`;
      const ids = desired.map((row) => z.string().uuid().parse(row.id));

      for (const [deploymentId, task] of running) {
        if (!ids.includes(deploymentId)) {
          task.controller.abort();
          continue;
        }

        const renewed =
          await sql`update app_private.pipeline_leases set expires_at=now()+interval '40 seconds' where deployment_id=${deploymentId} and owner=${id} and expires_at>now() returning deployment_id`;

        if (!renewed[0]) {
          task.controller.abort();
        }
      }

      for (const deploymentId of ids) {
        if (running.has(deploymentId)) {
          continue;
        }

        const lease =
          await sql`insert into app_private.pipeline_leases(deployment_id,owner,expires_at) values(${deploymentId},${id},now()+interval '40 seconds') on conflict(deployment_id) do update set owner=excluded.owner,expires_at=excluded.expires_at,generation=app_private.pipeline_leases.generation+1 where app_private.pipeline_leases.expires_at<now() returning deployment_id`;

        if (!lease[0]) {
          continue;
        }

        const controller = new AbortController();
        const promise = runPipeline(
          sql,
          storage,
          rpc,
          config,
          deploymentId,
          id,
          AbortSignal.any([controller.signal, shutdown.signal]),
        )
          .catch(async (error) => {
            if (controller.signal.aborted || shutdown.signal.aborted) {
              return;
            }

            const context = z
              .object({
                workflow_id: z.string().uuid().nullable(),
                workflow_state: z.string().nullable(),
              })
              .parse(
                (
                  await sql`select d.workflow_id,f.state workflow_state from public.pipeline_deployments d left join public.watch_workflows f on f.id=d.workflow_id where d.id=${deploymentId}`
                )[0],
              );

            log("pipeline.disconnected", {
              deploymentId,
              code: errorCode(error),
            });

            if (
              error instanceof IntegrationError &&
              error.code === "RECOVERY_BUDGET"
            ) {
              if (context.workflow_id) {
                await failWorkflow(
                  sql,
                  context.workflow_id,
                  "STREAM",
                  "RECOVERY_BUDGET",
                  "Recovery exceeds Scout's bounded 5,000-block catch-up window. Adjust the request to create a replacement version with a recent starting point.",
                  false,
                );
              }

              await sql`update public.pipeline_deployments set state='failed',error='Recovery exceeds 5,000 blocks. Adjust the rule to create a replacement version with a recent starting window.' where id=${deploymentId}`;
              await sql`update public.watches w set status='failed',error='Recovery exceeds 5,000 blocks. Adjust the rule to start a replacement version.' from public.pipeline_deployments d where d.id=${deploymentId} and w.id=d.watch_id and w.active_version_id=d.version_id`;

              return;
            }

            if (
              context.workflow_id &&
              ["DEPLOYMENT_VERIFYING", "CATCHING_UP"].includes(
                context.workflow_state ?? "",
              )
            ) {
              const recent = (
                await sql`select 1 from public.watch_workflow_events where workflow_id=${context.workflow_id} and type='stream.reconnecting' and created_at>now()-interval '1 minute' limit 1`
              )[0];

              if (!recent) {
                await sql`select app_private.append_workflow_event(${context.workflow_id},${context.workflow_state},'stream.reconnecting','warning','Live connection interrupted','Scout will reconnect from the durable cursor; no completed stage or evidence has been discarded.',${sql.json({ code: errorCode(error), deploymentId })})`;
              }
            }

            const streamMessage =
              error instanceof IntegrationError &&
              error.code === "SUBSTREAMS_CAPACITY"
                ? "Waiting for provider session capacity. One slot is reserved for verification."
                : "Stream interrupted. Scout will retry from the saved checkpoint.";

            await sql`update public.pipeline_deployments set state='delayed',error=${streamMessage} where id=${deploymentId} and state<>'failed'`;
            await sql`update public.watches w set status='delayed',error=${streamMessage} from public.pipeline_deployments d where d.id=${deploymentId} and w.id=d.watch_id and (w.active_version_id=d.version_id or (w.active_version_id is null and w.pending_version_id=d.version_id)) and w.desired_state='running'`;
            await pause(10_000);
          })
          .finally(async () => {
            running.delete(deploymentId);
            await sql`delete from app_private.pipeline_leases where deployment_id=${deploymentId} and owner=${id}`;
          });

        running.set(deploymentId, { controller, promise });
      }

      await sql`update public.watches w set status='delayed',error='The latest persisted block is behind. Check the technical status.' from public.pipeline_deployments d where d.watch_id=w.id and d.version_id=w.active_version_id and w.status in ('watching','live') and (d.last_message_at is null or d.last_block_time is null or d.last_message_at<now()-interval '3 minutes' or d.last_block_time<now()-interval '20 minutes')`;

      if (Date.now() - maintenanceAt > 60_000) {
        maintenanceAt = Date.now();
        await sql.begin(async (tx) => {
          const pendingInvestigations =
            await tx`select d.incident_id,d.revision from public.investigation_decisions d join public.incidents i on i.id=d.incident_id where d.status='PENDING' and d.next_attempt_at<=now() and d.revision=md5(i.detection::text) and i.status<>'retracted' and not exists(select 1 from app_private.jobs j where j.kind='enrich' and j.payload->>'incidentId'=d.incident_id::text and j.status in ('queued','running')) order by d.next_attempt_at limit 100 for update of d skip locked`;

          for (const pending of pendingInvestigations) {
            await tx`select app_private.enqueue('enrich',${tx.json({ incidentId: pending.incident_id })},${`investigation:${pending.incident_id}:${Math.floor(Date.now() / 60000)}`})`;
            await tx`update public.investigation_decisions set next_attempt_at=now()+interval '5 minutes' where incident_id=${pending.incident_id} and revision=${pending.revision} and status='PENDING'`;
          }
        });
        await sql`update app_private.jobs set status='failed',error_code='LEASE_EXHAUSTED' where status='running' and leased_until<now() and attempts>=max_attempts`;
        await sql`update public.notification_deliveries d set status=case when d.status='sending' then 'ambiguous' else 'failed' end,error_code='LEASE_EXHAUSTED' from app_private.jobs j where j.status='failed' and j.error_code='LEASE_EXHAUSTED' and d.status in ('queued','sending') and ((j.kind='email' and j.payload->>'deliveryId'=d.id::text) or (j.kind='notify' and d.channel='telegram' and (j.payload->>'incidentId'=d.incident_id::text or j.payload->>'findingId'=d.finding_id::text)))`;
        await sql`update app_private.email_outbox set payload=null where kind='verification' and expires_at<now() and payload is not null`;
        await sql`delete from app_private.email_verifications where expires_at<now()-interval '1 day'`;
        await sql`delete from app_private.rate_limits where resets_at<now()-interval '1 day'`;
        await sql`delete from app_private.telegram_pairings where expires_at<now()-interval '1 day'`;
        await sql`delete from app_private.webhook_updates where received_at<now()-interval '7 days'`;
        await sql`delete from app_private.events where block_time<now()-interval '2 days'`;
        // Retention follows processed chain time, not wall time: a historical replay
        // must not lose its window just because it is behind chain head.
        await sql`delete from app_private.program_events p where (p.version_id,p.event_id) in (select pe.version_id,pe.event_id from app_private.program_events pe join app_private.normalized_events e on e.id=pe.event_id join app_private.checkpoints c on c.deployment_id=pe.deployment_id where e.block_time<c.block_time-interval '2 days' and not exists(select 1 from public.finding_events fe where fe.event_id=e.id) limit 10000)`;
        await sql`delete from app_private.normalized_events e where e.id in (select n.id from app_private.normalized_events n where not exists(select 1 from app_private.program_events p where p.event_id=n.id) and not exists(select 1 from public.finding_events f where f.event_id=n.id) and not exists(select 1 from public.watch_findings f where f.anchor_event_id=n.id) limit 10000)`;

        await sql`delete from app_private.jobs where status='complete' and updated_at<now()-interval '7 days'`;
        await sql`update public.transaction_intents set state='expired' where state='quoted' and expires_at<now()`;
        await sql`update public.transaction_intents set state='unknown' where state='pending' and created_at<=now()-interval '1 day'`;

        const intents =
          await sql`select id from public.transaction_intents where state in ('pending','unknown') and transaction_hash is not null and created_at>now()-interval '1 day' limit 100`;

        for (const intent of intents) {
          await sql`select app_private.enqueue('reconcile',${sql.json({ intentId: intent.id })},${`reconcile:${intent.id}:${Math.floor(Date.now() / 60000)}`})`;
        }
      }
    } catch (error) {
      log("worker.supervisor.error", { code: errorCode(error) });
    }

    await pause(10_000);
  }
}

// Existing artifacts predate the acceptance contract. Preserve their cursors, but reverify before consuming more blocks.
await sql.begin(async (tx) => {
  const legacy =
    await tx`select d.id,d.workflow_id,d.watch_id from public.pipeline_deployments d join public.watches w on w.id=d.watch_id where w.desired_state='running' and d.version_id in(w.active_version_id,w.pending_version_id) and d.artifact_hash is not null and (d.proof->>'pipelineStatus' is distinct from 'PIPELINE_VERIFIED' or d.proof->>'intentAcceptanceStatus' is null) for update of d skip locked`;

  for (const deployment of legacy) {
    await tx`update public.pipeline_deployments set state='checking',error='Acceptance contract upgrade requires re-verification.' where id=${deployment.id}`;
    await tx`update public.watches set status='checking' where id=${deployment.watch_id}`;

    if (deployment.workflow_id) {
      await tx`select app_private.append_workflow_event(${deployment.workflow_id},'BUILDING','verification.upgrade.required','active','Rechecking Watch acceptance','The saved cursor is preserved. This artifact must pass the new pipeline and intent acceptance gates before monitoring resumes.', '{}')`;
    }

    await tx`select app_private.enqueue('build',${tx.json({ deploymentId: deployment.id })},${"acceptance-contract-v1:" + deployment.id})`;
  }
});

log("worker.started", { workerId: id });
await Promise.all([jobs(true), jobs(false), jobs(false), supervise()]);

for (const task of running.values()) {
  task.controller.abort();
}

await Promise.allSettled([...running.values()].map((task) => task.promise));
await sql`delete from app_private.worker_heartbeats where id=${id}`;
await sql.end({ timeout: 5 });
server.close();
log("worker.stopped", { workerId: id });
