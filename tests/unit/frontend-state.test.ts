import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { WatchWorkflowSchema } from "@scout/domain";

import { resetAuthTransport } from "../../apps/web/src/features/account/auth-transport";
import {
  consumeSse,
  mergeWorkflow,
} from "../../apps/web/src/features/workflow/stream";
import {
  api,
  AppApiError,
  shouldRetryRequest,
} from "../../apps/web/src/features/workspace/api";

const id = "00000000-0000-4000-8000-000000000001";

function workflow(sequence: number) {
  return WatchWorkflowSchema.parse({
    id,
    watchId: id,
    state: "INTENT_READY",
    originalPrompt: "Watch transfers",
    errorCategory: null,
    errorCode: null,
    errorMessage: null,
    recoverable: false,
    clarification: null,
    updatedAt: `2026-09-13T10:00:0${sequence}Z`,
    outputs: {
      intent: null,
      dataRequirements: null,
      packageResolution: null,
      pipelinePlan: null,
      verification: null,
    },
    events: [
      {
        id,
        sequence,
        stage: "INTENT_READY",
        type: "resolved",
        status: "complete",
        title: "Understood",
        summary: null,
        metadata: {},
        createdAt: "2026-09-13T10:00:00Z",
      },
    ],
  });
}

afterEach(() => {
  resetAuthTransport();
  vi.unstubAllGlobals();
});
describe("frontend remote-state boundaries", () => {
  it("deduplicates replayed workflow events and rejects an older state", () => {
    const first = workflow(1);
    const second = workflow(2);
    const merged = mergeWorkflow(first, second);

    expect(mergeWorkflow(merged, second).events.map((e) => e.sequence)).toEqual(
      [1, 2],
    );
    expect(mergeWorkflow(merged, first)).toBe(merged);
    expect(
      mergeWorkflow(merged, {
        ...second,
        id: "00000000-0000-4000-8000-000000000002",
      }).events,
    ).toHaveLength(1);
  });
  it("reassembles split SSE frames and releases the stream reader", async () => {
    const frame = `event: workflow\ndata: ${JSON.stringify(workflow(1))}\n\n`;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame.slice(0, 31)));
        controller.enqueue(new TextEncoder().encode(frame.slice(31)));
        controller.close();
      },
    });
    const received = vi.fn();

    await consumeSse(new Response(body), received);
    expect(received).toHaveBeenCalledExactlyOnceWith(workflow(1));
    expect(body.locked).toBe(false);
  });
  it("rejects malformed workflow payloads instead of updating the cache", async () => {
    const received = vi.fn();

    await expect(
      consumeSse(
        new Response('event: workflow\ndata: {"state":"LIVE"}\n\n'),
        received,
      ),
    ).rejects.toThrow();
    expect(received).not.toHaveBeenCalled();
  });
  it("does not retry authorization, validation, or missing resource failures", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(
        shouldRetryRequest(0, new AppApiError("denied", status, "DENIED")),
      ).toBe(false);
    }

    expect(
      shouldRetryRequest(0, new AppApiError("offline", 0, "NETWORK_ERROR")),
    ).toBe(true);
    expect(
      shouldRetryRequest(2, new AppApiError("busy", 503, "UNAVAILABLE")),
    ).toBe(false);
    expect(shouldRetryRequest(0, new Error("schema mismatch"))).toBe(false);
  });
  it("normalizes non-JSON server failures without accepting successful fallback data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    );
    await expect(
      api("/api/state", z.object({ ok: z.boolean() })),
    ).rejects.toMatchObject({ status: 503, code: "INVALID_RESPONSE" });
  });
});
