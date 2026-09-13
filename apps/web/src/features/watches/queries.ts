"use client";

import { useQuery } from "@tanstack/react-query";

import { WatchSchema, WatchWorkflowSchema } from "@scout/domain";
import { queryKeys } from "@/lib/query/keys";

import { api } from "../workspace/api";

export function useWatch(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.watch(id),
    queryFn: () => api(`/api/watches?id=${id}`, WatchSchema),
    enabled: !!id && enabled,
    staleTime: 5000,
    refetchInterval: 10_000,
  });
}

export function useWorkflowQuery(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workflow(id),
    queryFn: () => api(`/api/watches/${id}/workflow`, WatchWorkflowSchema),
    enabled,
    staleTime: 5000,
  });
}
