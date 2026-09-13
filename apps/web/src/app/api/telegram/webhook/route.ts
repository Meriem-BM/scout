import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { TelegramAdapter, TelegramUpdate } from "@scout/integrations/telegram";
import { admin, HttpError } from "@/server/auth";
import { required, siteUrl } from "@/server/env";
import { route } from "@/server/http";

export const maxDuration = 15;

export const POST = route(async (request) => {
  const expected = Buffer.from(required("TELEGRAM_WEBHOOK_SECRET"));
  const actual = Buffer.from(
    request.headers.get("x-telegram-bot-api-secret-token") ?? "",
  );

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new HttpError(403, "Invalid webhook authentication.");
  }

  const text = await request.text();

  if (text.length > 16000) {
    throw new HttpError(413, "Webhook too large.");
  }

  const update = TelegramUpdate.parse(JSON.parse(text));
  const message = update.message;
  const callback = update.callback_query;
  let args: {
    update_id: number;
    pairing_hash?: string;
    chat_id?: string;
    telegram_user_id?: string;
    display_label?: string;
    callback_watch_id?: string;
  } = { update_id: update.update_id };
  const token = message?.text?.match(
    /^\/start(?:@[A-Za-z0-9_]+)? ([A-Za-z0-9_-]{32})$/,
  )?.[1];

  if (
    token &&
    message?.chat.type === "private" &&
    message.from &&
    !message.from.is_bot
  ) {
    args = {
      ...args,
      pairing_hash: createHash("sha256").update(token).digest("hex"),
      chat_id: String(message.chat.id),
      telegram_user_id: String(message.from.id),
      display_label: message.from.first_name ?? "Telegram",
    };
  }

  if (
    callback?.data?.startsWith("mute:") &&
    callback.message?.chat.type === "private"
  ) {
    args = {
      ...args,
      callback_watch_id: z.string().uuid().parse(callback.data.slice(5)),
      chat_id: String(callback.message.chat.id),
      telegram_user_id: String(callback.from.id),
    };
  }

  const { data, error } = await admin().rpc("scout_telegram_webhook", args);

  if (error) {
    throw new Error("Webhook could not be persisted. Telegram should retry.");
  }

  if (callback) {
    await new TelegramAdapter(
      required("TELEGRAM_BOT_TOKEN"),
      siteUrl(),
    ).acknowledge(
      callback.id,
      data === "muted"
        ? "Watch muted for one hour."
        : data === "duplicate"
          ? "Already handled."
          : "This action is not authorized.",
    );
  }

  return { ok: true };
});
