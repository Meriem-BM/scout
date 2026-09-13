import { z } from "zod";

import { verifyEmailWebhook } from "@scout/integrations/email";
import { admin, HttpError } from "@/server/auth";
import { required } from "@/server/env";
import { route } from "@/server/http";

export const POST = route(async (request) => {
  const raw = await request.text();

  if (raw.length > 32000) {
    throw new HttpError(413, "Webhook too large.");
  }

  let verified: unknown;

  try {
    verified = verifyEmailWebhook(
      raw,
      request.headers,
      required("RESEND_WEBHOOK_SECRET"),
    );
  } catch {
    throw new HttpError(403, "Invalid webhook authentication.");
  }

  const event = z
    .object({
      type: z.string(),
      created_at: z.iso.datetime({ offset: true }),
      data: z.object({ email_id: z.string() }),
    })
    .safeParse(verified);

  if (!event.success) {
    return { ok: true };
  }

  const { error } = await admin().rpc("scout_email_event", {
    event_id: request.headers.get("svix-id")!,
    provider: event.data.data.email_id,
    event_type: event.data.type,
    occurred_at: event.data.created_at,
  });

  if (error) {
    throw new Error("Webhook was not persisted. Provider should retry.");
  }

  return { ok: true };
});
