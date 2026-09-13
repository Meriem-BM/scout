"use client";

import { useQuery } from "@tanstack/react-query";

import { CapabilityCatalogSchema } from "@scout/domain";

import { AppApiError } from "../workspace/api";

/** Public support information must remain readable when sign-in is unavailable. */
async function readCapabilities(signal: AbortSignal) {
  let response: Response;

  try {
    response = await fetch("/api/capabilities", { cache: "no-store", signal });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    throw new AppApiError(
      "Scout could not load its current capabilities.",
      0,
      "NETWORK_ERROR",
    );
  }

  if (!response.ok) {
    throw new AppApiError(
      "Scout could not load its current capabilities.",
      response.status,
      "REQUEST_FAILED",
    );
  }

  return CapabilityCatalogSchema.parse(await response.json());
}

export function useCapabilities() {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: ({ signal }) => readCapabilities(signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
