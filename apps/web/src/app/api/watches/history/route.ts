import { z } from "zod";

import { IncidentSchema } from "@scout/domain";
import { identity } from "@/server/auth";
import { route } from "@/server/http";

export const GET = route(async (request) => {
  const p = new URL(request.url).searchParams;
  const { client } = await identity();
  const { data, error } = await client.rpc("scout_watch_history", {
    watch_id: z.uuid().parse(p.get("watch")),
    page_offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .parse(p.get("offset") ?? 0),
    search_text: (p.get("q") ?? "").slice(0, 100),
    status_filter: p.get("status") ?? "all",
  });

  if (error) {
    throw new Error("Watch history could not be loaded.");
  }

  return z.array(IncidentSchema).parse(data);
});
