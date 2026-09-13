import { describe, expect, it } from "vitest";

import {
  compileExecutableSpec,
  dataPlanningClarification,
  planDataRequirements,
  resolveWatchStarter,
  unavailableIntentCapability,
  WATCH_STARTERS,
  WatchWorkflowSchema,
  workflowPresentation,
} from "@scout/domain";

import { resolveWorkflowIntent } from "../../apps/worker/src/workflow/resolve-intent";

const source = <T>(value: T) => ({
  value,
  source: "explicit" as const,
  confidence: 1,
});
const liquidity = () => resolveWatchStarter(WATCH_STARTERS[2].prompt)!;

describe("supported Watch starters", () => {
  it.each(WATCH_STARTERS)(
    "compiles $id without clarification or an AI provider",
    async (starter) => {
      const resolved = await resolveWorkflowIntent(starter.prompt, [], {
        GROQ_MODEL: "test",
      });

      expect(resolved.status).toBe("READY");
      expect(resolved.intent.unresolved).toEqual([]);
      expect(dataPlanningClarification(resolved.intent)).toBeNull();
      expect(unavailableIntentCapability(resolved.intent)).toBeNull();
      expect(planDataRequirements(resolved.intent).execution.status).toBe(
        "verified",
      );
      expect(
        compileExecutableSpec(resolved.intent).notifications,
      ).toMatchObject({ inbox: true, useDefaults: true });
    },
  );

  it("does not override edits or clarification answers with a starter", async () => {
    const edited = WATCH_STARTERS[0].prompt.replace("$250K", "$500K");

    expect(resolveWatchStarter(edited)).toBeNull();
    await expect(
      resolveWorkflowIntent(edited, [], { GROQ_MODEL: "test" }),
    ).rejects.toMatchObject({ code: "GROQ_SETUP_REQUIRED" });
    await expect(
      resolveWorkflowIntent(
        WATCH_STARTERS[0].prompt,
        [{ field: "chain", answer: "Base" }],
        { GROQ_MODEL: "test" },
      ),
    ).rejects.toMatchObject({ code: "GROQ_SETUP_REQUIRED" });
  });

  it("does not share mutable intent state between watches", () => {
    const first = liquidity();

    first.filters.push({
      field: "liquidityUsd",
      value: "500000",
      unit: "USD",
      operator: "gt",
      source: "explicit",
    });
    expect(liquidity().filters).toEqual([]);
  });
});

describe("capability feedback", () => {
  it.each([null, "v3", "v4"])(
    "rejects a dollar threshold before asking about version %s",
    (version) => {
      const intent = liquidity();

      intent.subject.chain = null;
      intent.subject.protocolVersion = version ? source(version) : null;
      intent.filters = [
        {
          field: "liquidityUsd",
          value: "500000",
          unit: "USD",
          operator: "gt",
          source: "explicit",
        },
      ];

      const before = structuredClone(intent);

      expect(unavailableIntentCapability(intent)?.code).toBe(
        "LIQUIDITY_USD_UNAVAILABLE",
      );
      expect(intent).toEqual(before);
    },
  );

  it("preserves version and does not confuse swaps with liquidity", () => {
    const intent = liquidity();

    intent.subject.protocolVersion = source("v3");
    expect(unavailableIntentCapability(intent)?.code).toBe(
      "LIQUIDITY_VERSION_UNAVAILABLE",
    );
    expect(
      unavailableIntentCapability(
        resolveWatchStarter(WATCH_STARTERS[0].prompt)!,
      ),
    ).toBeNull();
  });

  const workflow = () =>
    WatchWorkflowSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      watchId: "22222222-2222-4222-8222-222222222222",
      originalPrompt:
        "Flag liquidity removals above $500K from a Uniswap pool.",
      state: "FAILED",
      errorCode: "VERIFIED_EXECUTOR_UNAVAILABLE",
      errorCategory: "PLAN",
      errorMessage: "Legacy planning-only message",
      recoverable: false,
      events: [],
      clarification: null,
      outputs: {
        intent: liquidity(),
        dataRequirements: null,
        packageResolution: null,
        pipelinePlan: null,
        verification: null,
      },
      updatedAt: "2026-09-13T12:00:00Z",
    });

  it("gives old saved failures an actionable unsupported state", () => {
    const flow = workflow();

    flow.outputs.intent!.filters = [
      {
        field: "liquidityUsd",
        value: "500000",
        unit: "USD",
        operator: "gt",
        source: "explicit",
      },
    ];

    const state = workflowPresentation(flow);

    expect(state.label).toBe("Not supported yet");
    expect(state.message).toContain("dollar value");
    expect(state.note).toContain("not monitoring");
  });

  it("distinguishes provider waiting, clarification and terminal failure", () => {
    const flow = workflow();

    flow.state = "INTENT_RESOLVING";
    flow.events = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        sequence: 1,
        stage: "INTENT_RESOLVING",
        type: "workflow.retry.scheduled",
        status: "warning",
        title: "Provider retry scheduled",
        summary: "Groq is rate limiting requests.",
        metadata: {},
        createdAt: flow.updatedAt,
      },
    ];
    expect(workflowPresentation(flow).label).toBe("Waiting for provider");
    flow.state = "NEEDS_CLARIFICATION";
    expect(workflowPresentation(flow).label).toBe("Your input needed");
    flow.state = "FAILED";
    flow.errorCode = "PROVIDER_TIMEOUT";
    expect(workflowPresentation(flow)).toMatchObject({
      label: "Setup stopped",
      unsupported: false,
    });
  });
});
