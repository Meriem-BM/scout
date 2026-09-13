import { z } from "zod";

import { type WatchWorkflow, WatchWorkflowSchema } from "@scout/domain";

export function mergeWorkflow(
  previous: WatchWorkflow | undefined,
  incoming: WatchWorkflow,
) {
  if (!previous || previous.id !== incoming.id) {
    return incoming;
  }

  if (Date.parse(incoming.updatedAt) < Date.parse(previous.updatedAt)) {
    return previous;
  }

  return {
    ...incoming,
    events: [
      ...new Map(
        [...previous.events, ...incoming.events].map((event) => [
          event.sequence,
          event,
        ]),
      ).values(),
    ].sort((a, b) => a.sequence - b.sequence),
  };
}

export async function consumeSse(
  response: Response,
  onWorkflow: (workflow: WatchWorkflow) => void,
) {
  if (!response.ok || !response.body) {
    throw new Error("Live workflow updates are unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");

      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);

        buffer = buffer.slice(boundary + 2);

        const event = frame
          .split("\n")
          .find((line) => line.startsWith("event: "))
          ?.slice(7);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);

        if (event === "workflow" && data) {
          onWorkflow(WatchWorkflowSchema.parse(JSON.parse(data)));
        }

        if (event === "error" && data) {
          throw new Error(
            z.object({ error: z.string() }).parse(JSON.parse(data)).error,
          );
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
