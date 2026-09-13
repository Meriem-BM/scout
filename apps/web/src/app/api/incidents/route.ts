import { z } from "zod";

import { authorizedBudget, body, route } from "@/server/http";

export const PATCH = route(async (request) => {
  const input = await body(
    request,
    z.object({
      id: z.string().uuid(),
      action: z.enum(["read", "unread", "reviewed", "open"]),
    }),
  );
  const { client } = await authorizedBudget("incident-action", 20);
  const { error } = await client.rpc("scout_incident_action", {
    incident_id: input.id,
    action: input.action,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true };
});
