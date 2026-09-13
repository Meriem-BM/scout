import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { identity } from "@/server/auth";
import { required } from "@/server/env";
import { authorizedBudget, body, route } from "@/server/http";

export const GET = route(async () => {
  const { client } = await identity();
  const { data, error } = await client.rpc("scout_telegram_test_status");

  if (error) {
    throw new Error("Test delivery status is unavailable.");
  }

  return { test: data };
});

export const POST = route(async (request) => {
  const { action, minutes } = await body(
    request,
    z.object({
      action: z.enum(["pair", "test", "disconnect", "mute", "unmute"]),
      minutes: z.number().int().min(1).max(10080).optional(),
    }),
  );
  const { client } = await authorizedBudget("telegram", 5, 60);

  if (action === "pair") {
    const username = z
      .string()
      .regex(/^[A-Za-z0-9_]{5,32}$/)
      .parse(required("TELEGRAM_BOT_USERNAME"));

    required("TELEGRAM_BOT_TOKEN");

    const token = randomBytes(24).toString("base64url");
    const { error } = await client.rpc("scout_pair_telegram", {
      token_hash: createHash("sha256").update(token).digest("hex"),
    });

    if (error) {
      throw new Error("Could not create a pairing link.");
    }

    return {
      url: `https://t.me/${username}?start=${token}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }

  const { error } = await client.rpc("scout_telegram_action", {
    action,
    mute_minutes: minutes ?? 60,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true };
});
