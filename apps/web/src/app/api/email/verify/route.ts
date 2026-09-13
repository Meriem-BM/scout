import { createHash } from "node:crypto";

import { z } from "zod";

import { authorizedBudget, body, route } from "@/server/http";

export const POST = route(async (request) => {
  const { token } = await body(
    request,
    z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  );
  const { client } = await authorizedBudget("telegram", 5, 60);
  const { error } = await client.rpc("scout_email_verify", {
    token_hash: createHash("sha256").update(token).digest("hex"),
  });

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true };
});
