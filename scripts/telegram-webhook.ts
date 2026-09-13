import { z } from "zod";

const config = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(20),
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .min(32)
      .regex(/^[A-Za-z0-9_-]+$/),
    SCOUT_SITE_URL: z
      .url()
      .refine(
        (value) => value.startsWith("https://"),
        "Public HTTPS URL required",
      ),
  })
  .parse(process.env);

if (process.argv[2] !== "--register") {
  throw new Error(
    "Registration changes external bot settings. After approval, pass --register explicitly.",
  );
}

const response = await fetch(
  `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setWebhook`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: new URL("/api/telegram/webhook", config.SCOUT_SITE_URL).href,
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
    signal: AbortSignal.timeout(15_000),
  },
);
const result = z.object({ ok: z.boolean() }).parse(await response.json());

if (!response.ok || !result.ok) {
  throw new Error(
    "Telegram rejected webhook registration. Verify bot and HTTPS configuration.",
  );
}

console.log(
  "Telegram accepted the configured webhook. Pair an account and send a test to verify delivery; registration alone is not delivery proof.",
);
