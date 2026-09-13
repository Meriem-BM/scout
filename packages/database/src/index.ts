import postgres from "postgres";
import { z } from "zod";

import { IncidentSchema, WatchSpecSchema } from "@scout/domain";

export function connectDatabase(url: string, max = 8) {
  return postgres(url, {
    max,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { application_name: "scout-worker" },
    transform: { undefined: null },
    onnotice: () => {
      /* SQL notices are intentionally excluded from application logs. */
    },
  });
}

export type DatabaseConnection = ReturnType<typeof connectDatabase>;

const JobSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    "build",
    "enrich",
    "notify",
    "reconcile",
    "test_alert",
    "email",
    "workflow",
  ]),
  payload: z.record(z.string(), z.unknown()),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
});

export type Job = z.infer<typeof JobSchema>;

export async function claimJob(
  sql: DatabaseConnection,
  owner: string,
  kinds: Job["kind"][],
): Promise<Job | null> {
  const rows =
    await sql`with candidate as (select id from app_private.jobs where kind=any(${kinds}) and attempts<max_attempts and run_at<=now() and (status='queued' or (status='running' and leased_until<now())) order by run_at for update skip locked limit 1)
  update app_private.jobs j set status='running',attempts=attempts+1,leased_by=${owner},leased_until=now()+interval '4 minutes',updated_at=now() from candidate c where j.id=c.id returning j.*`;

  return rows[0] ? JobSchema.parse(rows[0]) : null;
}

export async function finishJob(
  sql: DatabaseConnection,
  job: Job,
  owner: string,
  errorCode?: string,
  retryAfter = 0,
) {
  if (!errorCode) {
    await sql`update app_private.jobs set status='complete',leased_until=null,leased_by=null,updated_at=now() where id=${job.id} and leased_by=${owner} and attempts=${job.attempts} and status='running' and leased_until>now()`;

    return;
  }

  const seconds = Math.max(retryAfter, Math.min(900, 2 ** job.attempts * 5));

  await sql`update app_private.jobs set status=case when attempts>=max_attempts then 'failed' else 'queued' end,error_code=${errorCode},leased_until=null,leased_by=null,run_at=now()+(${seconds}*interval '1 second'),updated_at=now() where id=${job.id} and leased_by=${owner} and attempts=${job.attempts} and status='running' and leased_until>now()`;
}

export async function loadIncident(sql: DatabaseConnection, id: string) {
  const rows =
    await sql`select i.*,v.spec,coalesce((select jsonb_agg(e.payload) from public.incident_evidence e where e.incident_id=i.id),'[]'::jsonb) evidence from public.incidents i join public.watch_versions v on v.id=i.version_id where i.id=${id}`;
  const row = rows[0];

  if (!row) {
    throw new Error("Incident not found.");
  }

  return IncidentSchema.parse({
    id: row.id,
    watchId: row.watch_id,
    title: row.title,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    read: row.read_at !== null,
    status: row.status,
    detection: row.detection,
    spec: row.spec,
    evidence: row.evidence,
    context: row.context,
    explanation: row.explanation,
    delivery: row.delivery,
    deliveryStates: [],
  });
}

export const DeploymentSchema = z.object({
  id: z.string().uuid(),
  watch_id: z.string().uuid(),
  user_id: z.string().uuid(),
  version_id: z.string().uuid(),
  artifact_hash: z.string().nullable(),
  state: z.string(),
  proof: z.record(z.string(), z.unknown()),
  spec: WatchSpecSchema,
  prompt: z.string(),
  workflow_id: z.string().uuid().nullable(),
});

export type Deployment = z.infer<typeof DeploymentSchema>;

export async function loadDeployment(sql: DatabaseConnection, id: string) {
  const rows =
    await sql`select d.*,v.spec,v.prompt from public.pipeline_deployments d join public.watch_versions v on v.id=d.version_id where d.id=${id}`;

  return DeploymentSchema.parse(rows[0]);
}
