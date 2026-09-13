import { describe, expect, it, vi } from "vitest";

import { resolveWatchStarter, WATCH_STARTERS } from "@scout/domain";
import { GroqAdapter } from "@scout/integrations/ai";
import { SubstreamsRegistry } from "@scout/integrations/substreams-registry";

import { runWatchWorkflow } from "../../apps/worker/src/workflow/watch-workflow";

import type { WorkerConfig } from "../../apps/worker/src/config";
import type { DatabaseConnection } from "@scout/database";
import type { WatchIntentSpec } from "@scout/domain";

function database(savedIntent: WatchIntentSpec | null) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?");

      calls.push({ text, values });

      if (text.includes("select * from public.watch_workflows")) {
        return [
          {
            id: "11111111-1111-4111-8111-111111111111",
            watch_id: "22222222-2222-4222-8222-222222222222",
            user_id: "33333333-3333-4333-8333-333333333333",
            original_prompt:
              "Flag liquidity removals above $500K from a Uniswap pool.",
            state: "RECEIVED",
            run_number: 1,
          },
        ];
      }

      if (text.includes("select payload")) {
        return values[1] === "intent" && savedIntent
          ? [{ payload: savedIntent }]
          : [];
      }

      if (text.includes("select field,answer")) {
        return [];
      }

      if (
        /app_private\.(put_workflow_output|append_workflow_event)|update public\.(watches|watch_workflows)/.test(
          text,
        )
      ) {
        return [];
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    {
      json: (value: unknown) => value,
      begin: async (callback: (tx: unknown) => Promise<void>) => callback(sql),
    },
  );

  return { sql: sql as unknown as DatabaseConnection, calls };
}

async function run(db: ReturnType<typeof database>) {
  await runWatchWorkflow(
    db.sql,
    {} as Parameters<typeof runWatchWorkflow>[1],
    {} as Parameters<typeof runWatchWorkflow>[2],
    { GROQ_API_KEY: "test-key", GROQ_MODEL: "test" } as WorkerConfig,
    "11111111-1111-4111-8111-111111111111",
    new AbortController().signal,
  );
}

describe("workflow capability gate", () => {
  it("stops a partial USD liquidity request before asking questions or searching packages", async () => {
    const intent = resolveWatchStarter(WATCH_STARTERS[2].prompt)!;

    intent.subject.chain = null;
    intent.subject.protocolVersion = null;
    intent.filters = [
      {
        field: "liquidityUsd",
        value: "500000",
        unit: "USD",
        operator: "gt",
        source: "explicit",
      },
    ];
    intent.unresolved = [
      {
        field: "protocolVersion",
        classification: "BLOCKING",
        reason: "Version is unspecified",
      },
    ];

    const model = vi
      .spyOn(GroqAdapter.prototype, "resolveIntent")
      .mockResolvedValue({
        status: "NEEDS_CLARIFICATION",
        intent,
        unsupportedReason: null,
        supportedAlternative: null,
        clarification: {
          field: "protocolVersion",
          question: "Which version?",
          reason: "Version is unspecified",
          choices: [{ value: "v4", label: "V4", recommended: false }],
          allowCustom: true,
        },
      });
    const discover = vi.spyOn(SubstreamsRegistry.prototype, "discover");
    const db = database(null);

    await run(db);
    expect(model).toHaveBeenCalledOnce();
    expect(discover).not.toHaveBeenCalled();
    expect(
      db.calls.some((call) =>
        call.text.includes("insert into public.watch_clarifications"),
      ),
    ).toBe(false);
    expect(
      db.calls.some(
        (call) =>
          call.text.includes("set error_category") &&
          call.values.includes("LIQUIDITY_USD_UNAVAILABLE"),
      ),
    ).toBe(true);
    expect(
      db.calls.find((call) => call.text.includes("put_workflow_output"))
        ?.values,
    ).toContainEqual(intent);
  });

  it("stops an unexecutable scope before a package proposal even on resumed work", async () => {
    const intent = resolveWatchStarter(WATCH_STARTERS[1].prompt)!;

    intent.subject.wallets = [
      {
        value: "0x1111111111111111111111111111111111111111",
        source: "explicit",
        confidence: 1,
      },
    ];

    const model = vi.spyOn(GroqAdapter.prototype, "resolveIntent");
    const discover = vi.spyOn(SubstreamsRegistry.prototype, "discover");
    const db = database(intent);

    await run(db);
    expect(model).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(
      db.calls.some(
        (call) =>
          call.text.includes("set error_category") &&
          call.values.includes("EXECUTABLE_SPEC_INVALID"),
      ),
    ).toBe(true);
  });
});
