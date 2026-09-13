import { PreferencesSchema } from "@scout/domain";
import { authorizedBudget, body, route } from "@/server/http";

export const PATCH = route(async (request) => {
  const preferences = await body(request, PreferencesSchema);
  const { client } = await authorizedBudget("watch-action", 20);
  const { error } = await client.rpc("scout_preferences", { preferences });

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true };
});
