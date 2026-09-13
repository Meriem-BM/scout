import { z } from "zod";

import {
  CollectionWatchSchema,
  WatchSchema,
  WatchSpecSchema,
} from "@scout/domain";
import { HttpError, identity } from "@/server/auth";
import { authorizedBudget, body, route } from "@/server/http";
import { workflowRpc } from "@/server/workflow";

export const POST = route(async (request) => {
  const input = await body(
    request,
    z.union([
      z.object({ prompt: z.string().trim().min(1).max(2000) }).strict(),
      z.object({ duplicateId: z.string().uuid() }).strict(),
      z
        .object({
          spec: WatchSpecSchema,
          prompt: z.string().min(1).max(2000),
          draft: z.boolean().default(false),
          watchId: z.string().uuid(),
        })
        .strict(),
    ]),
  );
  const auth = await authorizedBudget("watch-save", 5, 3600);

  if ("duplicateId" in input) {
    const id = await workflowRpc(auth, "duplicate", {
      watch_id: input.duplicateId,
    });

    return { id: z.uuid().parse(id) };
  }

  if (!("spec" in input)) {
    const id = await workflowRpc(auth, "create", {
      original_prompt: input.prompt,
    });

    return { id: z.uuid().parse(id) };
  }

  const { client } = auth;
  const { data, error } = await client.rpc("scout_save_watch_v2", {
    save_draft: input.draft,
    watch_spec: input.spec,
    original_prompt: input.prompt,
    existing_id: input.watchId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { id: data };
});

export const PATCH = route(async (request) => {
  const input = await body(
    request,
    z.object({
      id: z.string().uuid(),
      action: z.enum([
        "pause",
        "resume",
        "archive",
        "restore",
        "mute",
        "unmute",
      ]),
      minutes: z.number().int().min(1).max(10080).optional(),
    }),
  );
  const { client } = await authorizedBudget("watch-action", 20);
  const { error } = await client.rpc("scout_watch_action", {
    watch_id: input.id,
    action: input.action,
    mute_minutes: input.minutes ?? 60,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true };
});

export const GET = route(async (request) => {
  const p = new URL(request.url).searchParams;
  const { client } = await identity();

  if (p.has("id")) {
    const result = await client.rpc("scout_watch_detail", {
      watch_id: z.uuid().parse(p.get("id")),
    });

    if (result.error) {
      throw new Error("Watch could not be loaded.");
    }

    if (!result.data) {
      throw new HttpError(404, "Watch not available to this account.");
    }

    return WatchSchema.parse(result.data);
  }

  const { data, error } = await client.rpc("scout_watches_page", {
    page_offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .parse(p.get("offset") ?? 0),
    search_text: (p.get("q") ?? "").slice(0, 100),
    status_filter: p.get("status") ?? "all",
    sort_order: p.get("sort") ?? "newest",
  });

  if (error) {
    throw new Error("Watches could not be loaded.");
  }

  return z.array(CollectionWatchSchema).parse(data);
});

export const PUT = route(async (request) => {
  const input = await body(
    request,
    z.object({
      id: z.uuid(),
      channels: z
        .object({ telegram: z.boolean(), email: z.boolean() })
        .nullable(),
    }),
  );
  const { client } = await authorizedBudget("watch-action", 20);
  const { error } = await client.rpc("scout_watch_destinations", {
    watch_id: input.id,
    channels: input.channels,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true };
});
