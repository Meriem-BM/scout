"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { type Watch, type WatchWorkflow } from "@scout/domain";
import { queryKeys } from "@/lib/query/keys";

import { authenticatedFetch } from "../account/auth-transport";
import { useWorkflowQuery } from "../watches/queries";
import { api, AppApiError, Ok } from "../workspace/api";

import { consumeSse, mergeWorkflow } from "./stream";

export function useWatchWorkflow(watch: Watch) {
  const client = useQueryClient();
  const [streamError, setStreamError] = useState<string | null>(null);
  const queryKey = useMemo(() => queryKeys.workflow(watch.id), [watch.id]);
  const query = useWorkflowQuery(watch.id);
  const current = useRef<WatchWorkflow | undefined>(undefined);

  current.current = query.data;

  const workflowState = query.data?.state;

  useEffect(() => {
    if (
      !current.current ||
      ["LIVE", "FAILED", "NEEDS_CLARIFICATION"].includes(workflowState ?? "")
    ) {
      return;
    }

    const controller = new AbortController();
    let stopped = false;

    const run = async () => {
      while (!stopped) {
        try {
          const after = current.current?.events.at(-1)?.sequence ?? 0;
          const response = await authenticatedFetch(
            `/api/watches/${watch.id}/workflow/stream?after=${after}`,
            { signal: controller.signal },
          );

          if (!response.ok) {
            throw new AppApiError(
              "Live workflow updates are unavailable.",
              response.status,
              "STREAM_UNAVAILABLE",
            );
          }

          await consumeSse(response, (incoming) => {
            if (stopped) {
              return;
            }

            current.current = mergeWorkflow(current.current, incoming);
            setStreamError(null);
            client.setQueryData<WatchWorkflow>(queryKey, (previous) =>
              mergeWorkflow(previous, incoming),
            );
          });

          if (
            ["LIVE", "FAILED", "NEEDS_CLARIFICATION"].includes(
              current.current?.state ?? "",
            )
          ) {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          if (controller.signal.aborted) {
            break;
          }

          setStreamError(
            error instanceof Error
              ? error.message
              : "Live updates were interrupted.",
          );

          if (error instanceof AppApiError && !error.retryable) {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };

    void run();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [client, workflowState, queryKey, watch.id]);

  const workflow = query.data;

  const answerMutation = useMutation({
    mutationFn: (value: string) => {
      if (!workflow?.clarification) {
        throw new Error("No clarification is awaiting an answer.");
      }

      return api(
        `/api/watches/${watch.id}/clarifications/${workflow.clarification.id}`,
        Ok,
        { method: "POST", body: { answer: value } },
      );
    },
    onSuccess: async () => {
      await query.refetch();
      await client.invalidateQueries({ queryKey: queryKeys.watches });
    },
  });
  const retryMutation = useMutation({
    mutationFn: () =>
      api(`/api/watches/${watch.id}/workflow/retry`, Ok, {
        method: "POST",
        body: {},
      }),
    onSuccess: async () => {
      await query.refetch();
      await client.invalidateQueries({ queryKey: queryKeys.watches });
    },
  });

  return {
    query,
    workflow,
    streamError:
      answerMutation.error?.message ??
      retryMutation.error?.message ??
      streamError,
    answering: answerMutation.isPending,
    answeringValue: answerMutation.variables,
    retrying: retryMutation.isPending,
    answer: answerMutation.mutate,
    retry: () => retryMutation.mutate(),
  };
}
