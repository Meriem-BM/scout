import { z } from "zod";

import { loadIncident } from "@scout/database";
import {
  EmailPayloadSchema,
  emailTemplate,
  incidentEmail,
  ResendAdapter,
} from "@scout/integrations/email";

import { findingEmail } from "./findings";

import type { WorkerConfig } from "../config";
import type { DatabaseConnection, Job } from "@scout/database";

export async function deliverEmail(
  sql: DatabaseConnection,
  job: Job,
  config: WorkerConfig,
) {
  const id = z.string().uuid().parse(job.payload.deliveryId);
  // One durable row per incident/channel. Payload is frozen before first attempt.
  const row = (
    await sql`select o.*,d.status,d.provider_id,c.address current_address,c.enabled,c.suppressed from app_private.email_outbox o join public.notification_deliveries d on d.id=o.id left join app_private.email_connections c on c.id=o.connection_id where o.id=${id}`
  )[0];

  if (
    !row ||
    [
      "sent",
      "delivered",
      "bounced",
      "suppressed",
      "muted",
      "ambiguous",
    ].includes(row.status) ||
    row.provider_id
  ) {
    return;
  }

  const status = async (value: string, code: string | null) => {
    await sql`update public.notification_deliveries set status=${value},error_code=${code} where id=${id} and provider_id is null`;
  };

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    await status("failed", "VERIFICATION_EXPIRED");

    return;
  }

  if (
    row.kind !== "verification" &&
    (row.current_address !== row.destination || !row.enabled || row.suppressed)
  ) {
    await status("suppressed", "DESTINATION_DISABLED_OR_CHANGED");

    return;
  }

  if (row.kind === "verification") {
    const valid = (
      await sql`select 1 from app_private.email_verifications where user_id=${row.user_id} and address=${row.destination} and expires_at>now() and consumed_at is null and ${row.dedupe_key}='verification:'||token_hash`
    )[0];

    if (!valid) {
      await status("muted", "VERIFICATION_REPLACED");

      return;
    }
  }

  if (
    (
      await sql`select 1 from app_private.email_suppressions where address=${row.destination}`
    )[0]
  ) {
    await status("suppressed", "DESTINATION_SUPPRESSED");

    return;
  }

  // Resend retains idempotency keys for 24h. Never retry an uncertain send beyond 23h.
  if (
    row.first_attempt_at &&
    Date.now() - new Date(row.first_attempt_at).getTime() > 23 * 3600_000
  ) {
    await status("ambiguous", "PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED");

    return;
  }

  let payload = row.payload;

  if (row.kind === "finding") {
    const finding = (
      await sql`select finding_id from public.notification_deliveries where id=${id}`
    )[0];
    const currentPayload = finding?.finding_id
      ? await findingEmail(sql, finding.finding_id, config, row.connection_id)
      : null;

    if (!currentPayload) {
      await status("muted", "FINDING_NO_LONGER_DELIVERABLE");

      return;
    }

    payload ??= currentPayload;
  } else if (row.kind === "incident") {
    const delivery = (
      await sql`select d.incident_id,w.desired_state,w.muted_until,case when w.destination_overrides is null then coalesce(p.email,false) else coalesce((w.destination_overrides->>'email')::boolean,false) end enabled from public.notification_deliveries d join public.incidents i on i.id=d.incident_id join public.watches w on w.id=i.watch_id left join public.account_preferences p on p.user_id=w.user_id where d.id=${id}`
    )[0];

    if (
      !delivery ||
      delivery.desired_state !== "running" ||
      !delivery.enabled ||
      (delivery.muted_until &&
        new Date(delivery.muted_until).getTime() > Date.now())
    ) {
      await status("muted", null);

      return;
    }

    const incident = await loadIncident(sql, delivery.incident_id);

    if (
      incident.spec.investigation.requireNoPriorUniswapSwaps &&
      !(
        await sql`select 1 from public.investigation_decisions d join public.incidents i on i.id=d.incident_id where i.id=${delivery.incident_id} and d.revision=md5(i.detection::text) and d.status='ALERT'`
      )[0]
    ) {
      return;
    }

    if (incident.status === "retracted") {
      await status("muted", "EVIDENCE_RETRACTED");

      return;
    }

    if (!payload && config.EMAIL_LINK_SECRET) {
      payload = incidentEmail(
        incident,
        config.SCOUT_SITE_URL,
        row.connection_id,
        config.EMAIL_LINK_SECRET,
      );
    }
  } else if (row.kind === "test" && !payload) {
    payload = emailTemplate(
      "Scout test alert",
      [
        "This is a test you requested. Your verified email destination is ready to receive Scout alerts.",
      ],
      `${config.SCOUT_SITE_URL}/connections`,
      "Manage connections",
    );
  }

  if (
    !config.RESEND_API_KEY ||
    !config.RESEND_FROM_EMAIL ||
    !config.EMAIL_LINK_SECRET
  ) {
    await status("failed", "EMAIL_SETUP_REQUIRED");

    throw new Error("Email delivery configuration is missing.");
  }

  const valid = EmailPayloadSchema.parse(payload);

  await sql`update app_private.email_outbox set payload=${sql.json(valid)},first_attempt_at=coalesce(first_attempt_at,now()) where id=${id}`;
  await sql`update public.notification_deliveries set status='sending',attempts=attempts+1,error_code=null where id=${id}`;

  try {
    const providerId = await new ResendAdapter(
      config.RESEND_API_KEY,
      config.RESEND_FROM_EMAIL,
    ).send(row.destination, valid, `scout-email/${id}`);

    await sql.begin(async (tx) => {
      await tx`update public.notification_deliveries set status='sent',provider_id=${providerId},sent_at=now(),error_code=null where id=${id}`;
      await tx`select app_private.reconcile_email(${providerId})`;

      // Verification secrets no longer need to remain in outbox content.
      if (row.kind === "verification") {
        await tx`update app_private.email_outbox set payload=null where id=${id}`;
      }
    });
  } catch (error) {
    await status(
      job.attempts >= job.max_attempts ? "failed" : "queued",
      "EMAIL_SEND_RETRY",
    );

    throw error;
  }
}
