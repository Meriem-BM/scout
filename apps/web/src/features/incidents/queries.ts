"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { DeliverySchema, IncidentSchema } from "@scout/domain";
import { queryKeys } from "@/lib/query/keys";

import { api } from "../workspace/api";
import { useWorkspace } from "../workspace/use-workspace";

export const IncidentResponse = z.object({
  incident: IncidentSchema,
  deliveries: z.array(DeliverySchema),
});

export function useIncident(id: string | null) {
  const { signedIn } = useWorkspace();
  const query = useQuery({
    queryKey: queryKeys.incident(id),
    queryFn: () => api(`/api/incidents/detail?id=${id}`, IncidentResponse),
    enabled: !!id && signedIn,
    refetchInterval: 10000,
  });

  return {
    ...query,
    incident: query.data?.incident,
    deliveries: query.data?.deliveries ?? [],
  };
}
