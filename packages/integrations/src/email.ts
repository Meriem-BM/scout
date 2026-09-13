import { createHmac, timingSafeEqual } from "node:crypto";

import { Resend } from "resend";
import { z } from "zod";

import { describeSpec, usd } from "@scout/domain";

import { IntegrationError } from "./http";

import type { Incident } from "@scout/domain";

export type AlertChannel = "telegram" | "email" | "discord";

export interface AlertAdapter {
  readonly channel: AlertChannel;
}

export const EmailPayloadSchema = z.object({
  subject: z.string().max(200),
  html: z.string().max(30000),
  text: z.string().max(16000),
});

export type EmailPayload = z.infer<typeof EmailPayloadSchema>;

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function emailTemplate(
  subject: string,
  lines: string[],
  url: string,
  action: string,
  manage?: string,
): EmailPayload {
  return {
    subject,
    text: `SCOUT\n\n${subject}\n\n${lines.join("\n\n")}\n\n${action}: ${url}${manage ? `\n\nDisable alerts to this email: ${manage}` : ""}`,
    html: `<html><body style="margin:0;background:#0c1013;color:#f1f5f3;font:16px/1.6 Arial,sans-serif"><main style="max-width:560px;margin:auto;padding:36px 24px"><p style="color:#8de0bb;font-weight:bold;letter-spacing:2px">SCOUT</p><h1 style="font-size:26px;line-height:1.3">${escape(subject)}</h1>${lines.map((line) => `<p style="color:#abb6bd">${escape(line)}</p>`).join("")}<p style="padding:20px 0"><a style="display:inline-block;background:#8de0bb;color:#0c1013;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold" href="${escape(url)}">${escape(action)}</a></p>${manage ? `<p style="border-top:1px solid #344047;padding-top:20px;font-size:14px"><a style="color:#abb6bd" href="${escape(manage)}">Disable alerts to this email</a></p>` : ""}</main></body></html>`,
  };
}

export function manageEmailToken(id: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`disable-email:${id}`)
    .digest("base64url");
}

export function verifyManageEmailToken(
  id: string,
  token: string,
  secret: string,
) {
  const a = Buffer.from(manageEmailToken(id, secret));
  const b = Buffer.from(token);

  return a.length === b.length && timingSafeEqual(a, b);
}

export function incidentEmail(
  incident: Incident,
  site: string,
  connectionId: string,
  secret: string,
) {
  const path = `${site}/watches/${incident.watchId}/incidents/${incident.id}`;
  const manage = `${site}/email/manage#${connectionId}.${manageEmailToken(connectionId, secret)}`;

  return emailTemplate(
    `${incident.spec.name}: ${incident.title}`,
    [
      `${usd(incident.detection.totalUsdMicros)} in observed sales across ${incident.detection.transactionCount} distinct transactions.`,
      `Matched rule: ${describeSpec(incident.spec)}`,
      `Observed ${new Date(incident.detection.timestamp * 1000).toISOString()} · finalized Ethereum evidence.`,
      "An observed initiator does not establish asset ownership or motive. Open the incident to inspect the evidence.",
    ],
    path,
    "Investigate in Scout",
    manage,
  );
}

export class ResendAdapter implements AlertAdapter {
  readonly channel = "email" as const;
  constructor(
    private key: string,
    private sender: string,
  ) {}
  async send(destination: string, payload: EmailPayload, key: string) {
    let response: Response;

    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          from: this.sender,
          to: [destination],
          ...payload,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new IntegrationError(
        "EMAIL_NETWORK_UNKNOWN",
        "Email acceptance is unknown; a bounded idempotent retry is queued.",
        30,
        true,
      );
    }

    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after"));

      throw new IntegrationError(
        "EMAIL_PROVIDER_ERROR",
        "Email was not accepted. Check sender domain, credentials, quota and destination.",
        Number.isFinite(retry) ? Math.min(3600, Math.max(30, retry)) : 30,
      );
    }

    const result = z
      .object({ id: z.string() })
      .safeParse(await response.json());

    if (!result.success) {
      throw new IntegrationError(
        "EMAIL_RESPONSE_UNKNOWN",
        "Email acceptance could not be confirmed.",
        30,
        true,
      );
    }

    return result.data.id;
  }
}

export function verifyEmailWebhook(
  raw: string,
  headers: Headers,
  secret: string,
) {
  return new Resend("webhook-verification-only").webhooks.verify({
    payload: raw,
    headers: {
      id: headers.get("svix-id") ?? "",
      timestamp: headers.get("svix-timestamp") ?? "",
      signature: headers.get("svix-signature") ?? "",
    },
    webhookSecret: secret,
  });
}
