import type { DatabaseConnection } from "@scout/database";

// Jobs use typed JSON references rather than user foreign keys. Remove only work
// belonging to the disposable account, before its relational records cascade.
export async function cleanupTestJobs(sql: DatabaseConnection, id: string) {
  await sql`delete from app_private.jobs where payload->>'userId'=${id}
    or payload->>'incidentId' in (select id::text from public.incidents where user_id=${id})
    or payload->>'deploymentId' in (select id::text from public.pipeline_deployments where user_id=${id})
    or payload->>'workflowId' in (select id::text from public.watch_workflows where user_id=${id})
    or payload->>'intentId' in (select id::text from public.transaction_intents where user_id=${id})
    or payload->>'deliveryId' in (select id::text from public.notification_deliveries where user_id=${id})`;
}
