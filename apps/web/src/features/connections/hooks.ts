"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { queryKeys } from "@/lib/query/keys";

import { api, Ok } from "../workspace/api";

const Configuration = z.object({
  telegramConfigured: z.boolean(),
  emailConfigured: z.boolean(),
  telegramTest: z
    .object({
      status: z.string().nullable(),
      messageId: z.string().nullable(),
      sentAt: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
});

export function useConnections(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api("/api/connections", Configuration),
    enabled,
    staleTime: 5000,
    refetchInterval: 5000,
  });
}

export function useConnectionMutation(refresh: () => Promise<void>) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async ({
      channel,
      action,
      address,
    }: {
      channel: "telegram" | "email";
      action: string;
      address: string;
    }) => {
      if (channel === "telegram" && action === "pair") {
        return api(
          "/api/telegram",
          z.object({ url: z.url(), expiresAt: z.string() }),
          { method: "POST", body: { action } },
        );
      }

      return api(
        channel === "telegram" ? "/api/telegram" : "/api/connections",
        Ok,
        { method: "POST", body: { action, address, minutes: 60 } },
      );
    },
    onSuccess: async () => {
      await Promise.all([
        refresh(),
        client.invalidateQueries({ queryKey: queryKeys.connections }),
      ]);
    },
  });
}
