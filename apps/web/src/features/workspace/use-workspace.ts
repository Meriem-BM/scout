"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { emptySnapshot, SnapshotSchema } from "@scout/domain";
import { queryKeys } from "@/lib/query/keys";

import { useScoutAuth } from "../account/auth-context";

import { api } from "./api";

export function useWorkspace(poll = false) {
  const auth = useScoutAuth();
  const client = useQueryClient();
  const session = {
    userId: auth.account?.userId ?? null,
    email: auth.account?.email ?? null,
    signedIn: !!auth.account,
    authConfigured: auth.configured,
  };
  const query = useQuery({
    queryKey: queryKeys.snapshot(session.userId),
    queryFn: () => api("/api/state", SnapshotSchema),
    enabled: session.signedIn,
    refetchInterval: poll ? 10_000 : false,
    refetchIntervalInBackground: false,
  });

  const refresh = async () => {
    await client.invalidateQueries({
      queryKey: queryKeys.snapshot(session.userId),
    });
  };

  return {
    ...session,
    state: session.signedIn ? (query.data ?? emptySnapshot()) : emptySnapshot(),
    loading: session.signedIn && query.isPending,
    error: query.error?.message ?? auth.error,
    refresh,
  };
}
