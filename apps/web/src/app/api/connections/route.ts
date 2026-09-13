import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { emailTemplate } from "@scout/integrations/email";
import { identity } from "@/server/auth";
import { required, siteUrl } from "@/server/env";
import { authorizedBudget, body, route } from "@/server/http";

export const GET = route(async () => {
  const { client } = await identity();
  const { data, error } = await client.rpc("scout_telegram_test_status");

  if (error) {
    throw new Error("Connection status could not be loaded.");
  }

  return {
    telegramConfigured: !!(
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_BOT_USERNAME &&
      process.env.TELEGRAM_WEBHOOK_SECRET
    ),
    emailConfigured: !!(
      process.env.RESEND_API_KEY &&
      process.env.RESEND_FROM_EMAIL &&
      process.env.EMAIL_LINK_SECRET &&
      process.env.RESEND_WEBHOOK_SECRET
    ),
    telegramTest: data,
  };
});

export const POST = route(async (request) => {
  const input = await body(
    request,
    z.object({
      action: z.enum([
        "verify",
        "use-account",
        "test",
        "disconnect",
        "enable",
        "disable",
      ]),
      address: z.email().max(254).optional(),
    }),
  );
  const { client, email } = await authorizedBudget("telegram", 5, 60);

  if (["verify", "use-account", "test"].includes(input.action)) {
    required("RESEND_API_KEY");
    required("RESEND_FROM_EMAIL");
    required("EMAIL_LINK_SECRET");
    required("RESEND_WEBHOOK_SECRET");
  }

  if (input.action === "verify" || input.action === "use-account") {
    const address = input.action === "use-account" ? email : input.address;

    if (!address) {
      throw new Error("Enter a destination email address.");
    }

    const token = randomBytes(32).toString("base64url");
    // Fragment keeps the verification secret out of access logs and referrers.
    const payload = emailTemplate(
      "Verify your Scout alert email",
      [
        "You requested alerts at this email address. Confirm within 10 minutes. This is separate from signing in to Scout.",
      ],
      `${siteUrl()}/email/verify#${token}`,
      "Verify alert destination",
    );
    const { error } = await client.rpc("scout_email_begin_for_account", {
      destination: address,
      token_hash: createHash("sha256").update(token).digest("hex"),
      mail_payload: payload,
      use_account: input.action === "use-account",
    });

    if (error) {
      throw new Error(error.message);
    }
  } else {
    const { error } = await client.rpc("scout_email_action", {
      action: input.action,
    });

    if (error) {
      throw new Error(error.message);
    }
  }

  return { ok: true };
});
