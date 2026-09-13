import { describe, expect, it } from "vitest";

import {
  defaultSpec,
  evaluate,
  investigationDecision,
  PriorActivitySchema,
  verifyUniswapAcceptance,
} from "@scout/domain";

import { fixtureEvents } from "../fixtures/swap-events";

const spec = {
  ...defaultSpec(),
  conditions: [{ kind: "large_swap" as const, usd: "100000" }],
  investigation: { requireNoPriorUniswapSwaps: true },
};

function prior(status: "FOUND" | "NONE_WITH_PROVEN_COVERAGE" | "UNKNOWN") {
  return PriorActivitySchema.parse({
    status,
    protocol: "uniswap_v3",
    actor: "0x" + "1".repeat(40),
    beforeTransaction: "0x" + "2".repeat(64),
    throughBlock: "1",
    blockHash: "0x" + "3".repeat(64),
    deployment: null,
    evidenceTransaction: status === "FOUND" ? "0x" + "4".repeat(64) : null,
    coverage:
      status === "NONE_WITH_PROVEN_COVERAGE"
        ? {
            fromBlock: "0",
            throughBlock: "1",
            blockHash: "0x" + "3".repeat(64),
            complete: true,
          }
        : undefined,
    reason: "Controlled acceptance case",
  });
}

describe("fresh trader semantics", () => {
  it.each([true, false])(
    "verifies controlled acceptance with history required=%s",
    (requireNoPriorUniswapSwaps) => {
      const request = {
        ...spec,
        investigation: { requireNoPriorUniswapSwaps },
      };
      const report = verifyUniswapAcceptance(
        request,
        fixtureEvents(request)[0]!,
      );

      expect(report.status).toBe("INTENT_ACCEPTANCE_VERIFIED");
      expect(report.cases.every((item) => item.passed)).toBe(true);
    },
  );
  it("retains the actor on a qualifying large swap", () => {
    const event = fixtureEvents(spec)[0]!;

    event.valuation = { ...event.valuation!, usdMicros: "250000000000" };
    expect(evaluate(spec, event, [event])?.initiator).toBe(event.initiator);
  });
  it("accepts only proven absence", () =>
    expect(
      investigationDecision(true, prior("NONE_WITH_PROVEN_COVERAGE")),
    ).toBe("ALERT"));
  it("suppresses prior traders", () =>
    expect(investigationDecision(true, prior("FOUND"))).toBe("SUPPRESS"));
  it("keeps unavailable history pending", () => {
    expect(investigationDecision(true, prior("UNKNOWN"))).toBe("PENDING");
    expect(investigationDecision(true, null)).toBe("PENDING");
  });
  it("does not match a below-threshold swap", () => {
    const event = fixtureEvents(spec)[0]!;

    event.valuation = { ...event.valuation!, usdMicros: "99999000000" };
    expect(evaluate(spec, event, [event])).toBeNull();
  });
});
