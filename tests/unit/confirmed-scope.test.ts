import { describe, expect, it } from "vitest";

import {
  applyConfirmedPoolScope,
  compileExecutableSpec,
  dataPlanningClarification,
  POOLS,
  resolveWatchStarter,
  WATCH_STARTERS,
} from "@scout/domain";

function setup() {
  const intent = resolveWatchStarter(WATCH_STARTERS[0].prompt)!;

  intent.subject.contracts = [];
  intent.unresolved = [
    {
      field: "poolScope",
      classification: "BLOCKING",
      reason: "Pool scope is missing",
    },
  ];

  const answer = dataPlanningClarification(intent)!.choices[0]!.value;

  return { intent, answer };
}

describe("confirmed pool scope", () => {
  it.each(["v3", "uniswap_v3"])(
    "preserves an exact choice for %s after the model drops it",
    (version) => {
      const { intent, answer } = setup();

      intent.subject.protocolVersion!.value = version;

      expect(
        applyConfirmedPoolScope(intent, [{ field: "poolScope", answer }]),
      ).toBe(true);
      expect(intent.subject.contracts.map((c) => c.value)).toEqual(
        POOLS.map((p) => p.address),
      );
      expect(intent.unresolved).toEqual([]);
      expect(dataPlanningClarification(intent)).toBeNull();
      intent.subject.tokens = [];
      applyConfirmedPoolScope(intent, [{ field: "poolScope", answer }]);
      expect(() => compileExecutableSpec(intent)).not.toThrow();
    },
  );
  it("does not narrow an arbitrary or subsequently broadened answer", () => {
    const { intent, answer } = setup();

    expect(
      applyConfirmedPoolScope(intent, [
        { field: "poolScope", answer: "all pools" },
      ]),
    ).toBe(false);
    expect(
      applyConfirmedPoolScope(intent, [
        { field: "poolScope", answer },
        { field: "pool_scope", answer: "all ETH pools" },
      ]),
    ).toBe(false);
    expect(intent.subject.contracts).toEqual([]);
  });
  it("keeps unrelated blocking questions", () => {
    const { intent, answer } = setup();

    intent.unresolved.push({
      field: "asset",
      classification: "BLOCKING",
      reason: "Choose the token",
    });
    applyConfirmedPoolScope(intent, [{ field: "poolScope", answer }]);
    expect(intent.unresolved.map((f) => f.field)).toEqual(["asset"]);
  });
});
