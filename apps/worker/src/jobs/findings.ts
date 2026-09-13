import { z } from "zod";

import { type WatchProgram } from "@scout/domain";
import { emailTemplate, manageEmailToken } from "@scout/integrations/email";
import { IntegrationError } from "@scout/integrations/http";
import { TelegramAdapter } from "@scout/integrations/telegram";

import type { WorkerConfig } from "../config";
import type { DatabaseConnection } from "@scout/database";

export async function queueFindingDelivery(
  tx: DatabaseConnection,
  findingId: string,
  program: WatchProgram,
) {
  const row = (
    await tx`select f.user_id,w.desired_state,w.muted_until,w.destination_overrides,p.telegram,p.email,t.chat_id,e.id email_id,e.address from public.watch_findings f join public.watches w on w.id=f.watch_id join public.finding_decisions d on d.finding_id=f.id and d.status='ALERT' left join public.account_preferences p on p.user_id=w.user_id left join app_private.telegram_connections t on t.user_id=w.user_id left join app_private.email_connections e on e.user_id=w.user_id and e.enabled and not e.suppressed where f.id=${findingId}`
  )[0];

  if (
    !row ||
    row.desired_state !== "running" ||
    (row.muted_until && new Date(row.muted_until).getTime() > Date.now())
  ) {
    return;
  }

  for (const channel of ["telegram", "email"] as const) {
    const enabled =
      row.destination_overrides?.[channel] ??
      (program.delivery.useDefaults
        ? (row[channel] ?? channel === "telegram")
        : program.delivery.channels.includes(channel));
    const destination = channel === "telegram" ? row.chat_id : row.address;

    if (!enabled || !destination) {
      continue;
    }

    const inserted = (
      await tx`insert into public.notification_deliveries(finding_id,user_id,channel,destination) values(${findingId},${row.user_id},${channel},${destination}) on conflict(finding_id,channel) do nothing returning id`
    )[0];

    if (!inserted) {
      continue;
    }

    if (channel === "telegram") {
      await tx`select app_private.enqueue('notify',${tx.json({ findingId })},${`finding-notify:${findingId}`})`;
    } else {
      await tx`insert into app_private.email_outbox(id,user_id,connection_id,kind,destination,dedupe_key) values(${inserted.id},${row.user_id},${row.email_id},'finding',${destination},${`finding-email:${findingId}`})`;
      await tx`select app_private.enqueue('email',${tx.json({ deliveryId: inserted.id })},${`finding-email:${findingId}`})`;
    }
  }
}

export async function findingDeliveryContext(
  sql: DatabaseConnection,
  id: string,
  channel: "telegram" | "email",
) {
  const row = (
    await sql`select f.*,w.name,w.desired_state,w.muted_until,w.active_version_id,w.destination_overrides,p.telegram,p.email,pr.program,nd.status delivery_status,nd.destination,d.status decision_status from public.watch_findings f join public.watches w on w.id=f.watch_id join public.watch_programs pr on pr.version_id=f.version_id join public.finding_decisions d on d.finding_id=f.id join public.notification_deliveries nd on nd.finding_id=f.id and nd.channel=${channel} left join public.account_preferences p on p.user_id=f.user_id where f.id=${id}`
  )[0];

  if (!row || row.decision_status !== "ALERT") {
    return null;
  }

  const enabled =
    row.destination_overrides?.[channel] ??
    (row.program.delivery.useDefaults
      ? (row[channel] ?? channel === "telegram")
      : row.program.delivery.channels.includes(channel));

  if (
    !enabled ||
    row.desired_state !== "running" ||
    row.active_version_id !== row.version_id ||
    (row.muted_until && new Date(row.muted_until).getTime() > Date.now())
  ) {
    return null;
  }

  return row;
}

function findingLines(row: {
  name: string;
  program: WatchProgram;
  actor_set: string[];
  anchor_event_id: string;
}) {
  return [
    `A qualifying event matched ${row.name}.`,
    `Chain ${row.program.source.chainId} · ${row.program.source.eventType}`,
    `Observed actors: ${(row.actor_set as string[]).join(", ") || "Not established"}`,
    `Finalized event: ${row.anchor_event_id}`,
    "Observed actors do not establish ownership or motive.",
  ];
}

export async function deliverFindingTelegram(
  sql: DatabaseConnection,
  findingId: string,
  config: WorkerConfig,
) {
  const row = await findingDeliveryContext(sql, findingId, "telegram");
  const delivery = (
    await sql`select d.*,t.chat_id,t.muted_until from public.notification_deliveries d left join app_private.telegram_connections t on t.user_id=d.user_id where d.finding_id=${findingId} and d.channel='telegram'`
  )[0];

  if (!delivery || ["sent", "ambiguous", "muted"].includes(delivery.status)) {
    return;
  }

  const status = async (
    value: string,
    error: string | null,
    expected = delivery.status,
  ) => {
    await sql`update public.notification_deliveries set status=${value},error_code=${error} where id=${delivery.id} and status=${expected}`;
  };

  if (delivery.status === "sending") {
    await status("ambiguous", "WORKER_INTERRUPTED_DURING_DELIVERY");

    return;
  }

  if (
    !row ||
    delivery.chat_id !== delivery.destination ||
    (delivery.muted_until &&
      new Date(delivery.muted_until).getTime() > Date.now())
  ) {
    await status("muted", null);

    return;
  }

  if (!config.TELEGRAM_BOT_TOKEN) {
    throw new IntegrationError(
      "TELEGRAM_SETUP_REQUIRED",
      "Telegram is not configured.",
    );
  }

  const claimed =
    await sql`update public.notification_deliveries set status='sending',attempts=attempts+1 where id=${delivery.id} and status in ('queued','failed') returning id`;

  if (!claimed[0]) {
    return;
  }

  try {
    const messageId = await new TelegramAdapter(
      config.TELEGRAM_BOT_TOKEN,
      config.SCOUT_SITE_URL,
    ).sendFinding(
      z.string().parse(delivery.destination),
      findingLines({
        name: row.name,
        program: row.program,
        actor_set: row.actor_set,
        anchor_event_id: row.anchor_event_id,
      }),
      row.watch_id,
    );

    await sql`update public.notification_deliveries set status='sent',message_id=${messageId},sent_at=now(),error_code=null where id=${delivery.id} and status='sending'`;
  } catch (error) {
    await status(
      error instanceof IntegrationError && error.ambiguous
        ? "ambiguous"
        : "queued",
      error instanceof IntegrationError ? error.code : "DELIVERY_ERROR",
      "sending",
    );

    if (!(error instanceof IntegrationError && error.ambiguous)) {
      throw error;
    }
  }
}

export async function findingEmail(
  sql: DatabaseConnection,
  findingId: string,
  config: WorkerConfig,
  connectionId: string,
) {
  const row = await findingDeliveryContext(sql, findingId, "email");

  if (!row) {
    return null;
  }

  if (!config.EMAIL_LINK_SECRET) {
    throw new Error("Email link secret is required");
  }

  return emailTemplate(
    `Scout · ${row.name}`,
    findingLines({
      name: row.name,
      program: row.program,
      actor_set: row.actor_set,
      anchor_event_id: row.anchor_event_id,
    }),
    `${config.SCOUT_SITE_URL}/watches/${row.watch_id}`,
    "Open Watch",
    `${config.SCOUT_SITE_URL}/email/manage#${connectionId}.${manageEmailToken(connectionId, config.EMAIL_LINK_SECRET)}`,
  );
}

/** Compatibility bridge is scoped to the exact immutable version and event evidence. */
export async function mirrorLegacyDecision(
  tx: DatabaseConnection,
  incidentId: string,
  status: string,
  evidence: unknown,
) {
  await tx`update public.finding_decisions fd set status=${status},evidence=${tx.json(evidence as never)},legacy_incident_id=${incidentId},updated_at=now() from public.watch_findings f,public.incidents i where i.id=${incidentId} and f.id=fd.finding_id and f.watch_id=i.watch_id and f.version_id=i.version_id and f.anchor_event_id in (select jsonb_array_elements_text(i.detection->'evidenceIds')) and fd.status='PENDING'`;
}
