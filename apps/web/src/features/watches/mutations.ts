"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { queryKeys } from "@/lib/query/keys";

import { useScoutAuth } from "../account/auth-context";
import { api, Ok } from "../workspace/api";

import type { WatchSpec } from "@scout/domain";

export function useCreateWatch() {
  const invalidate = useWatchInvalidation();

  return useMutation({
    mutationFn: (prompt: string) =>
      api("/api/watches", z.object({ id: z.string().uuid() }), {
        method: "POST",
        body: { prompt },
      }),
    onSuccess: invalidate,
  });
}

function useWatchInvalidation() {
  const client = useQueryClient();
  const auth = useScoutAuth();

  return async () => {
    await Promise.all([
      client.invalidateQueries({
        queryKey: queryKeys.snapshot(auth.account?.userId ?? null),
      }),
      client.invalidateQueries({ queryKey: queryKeys.watches }),
    ]);
  };
}

export function useSaveWatch() {
  const invalidate = useWatchInvalidation();
  const mutation = useMutation({
    mutationFn: (input: {
      spec: WatchSpec;
      prompt: string;
      watchId: string | null;
      draft: boolean;
    }) =>
      api("/api/watches", z.object({ id: z.string() }), {
        method: "POST",
        body: input,
      }),
    onSuccess: invalidate,
  });

  return async (spec: WatchSpec, prompt: string, id?: string, draft = false) =>
    (await mutation.mutateAsync({ spec, prompt, watchId: id ?? null, draft }))
      .id;
}

export function useWatchAction() {
  const invalidate = useWatchInvalidation();
  const mutation = useMutation({
    mutationFn: (input: {
      id: string;
      action: "pause" | "resume" | "archive" | "restore" | "mute" | "unmute";
    }) =>
      api("/api/watches", Ok, {
        method: "PATCH",
        body: { ...input, minutes: 60 },
      }),
    onSuccess: invalidate,
  });

  return async (
    id: string,
    action: Parameters<typeof mutation.mutateAsync>[0]["action"],
  ) => {
    await mutation.mutateAsync({ id, action });
  };
}
