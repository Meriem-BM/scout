import { connectDatabase } from "@scout/database";

const sql = connectDatabase(process.env.DATABASE_URL!, 1);

try {
  console.log(
    JSON.stringify({
      deployments:
        await sql`select d.id,w.name,w.status,d.state,d.last_block::text,d.last_message_at,d.proof->>'pipelineStatus' pipeline_verification,d.proof->>'intentAcceptanceStatus' acceptance_verification,d.error from public.pipeline_deployments d join public.watches w on w.id=d.watch_id where w.desired_state='running' and d.version_id in(w.active_version_id,w.pending_version_id) and d.artifact_hash is not null`,
      sessions:
        await sql`select kind,expires_at from app_private.substreams_sessions`,
      worker:
        await sql`select last_seen from app_private.worker_heartbeats order by last_seen desc limit 1`,
    }),
  );
} finally {
  await sql.end();
}
