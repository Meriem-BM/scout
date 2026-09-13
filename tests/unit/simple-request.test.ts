import { describe, expect, it } from "vitest";

import {
  compileExecutableSpec,
  dataPlanningClarification,
  explainWatchCapabilities,
  resolveSimpleMonitoringRequest,
} from "@scout/domain";

describe("closed grammar for basic amount requests", () => {
  it.each([
    "Watch USDC transfers above $500K on Base.",
    "Watch native USDC transfers above $0.75M on Base.",
    "Watch USDC transfers above $123.456789 on Base.",
  ])("preserves token and threshold for %s", (prompt) => {
    const intent = resolveSimpleMonitoringRequest(prompt)!;

    expect(intent.subject.tokens[0]?.value).toBe("USDC");
    expect(explainWatchCapabilities(intent).state).toBe("READY_TO_BUILD");
    expect(compileExecutableSpec(intent).protocol).toBe("erc20");
  });
  it("resolves the confirmed pool choice without dropping ETH, direction or amount", () => {
    const prompt = "Watch $100K+ ETH buys on Uniswap V3.";
    const first = resolveSimpleMonitoringRequest(prompt)!;

    expect(explainWatchCapabilities(first).state).toBe("NEEDS_DETAIL");

    const answer = dataPlanningClarification(first)!.choices[0]!.value;
    const confirmed = resolveSimpleMonitoringRequest(prompt, [
      { field: "poolScope", answer },
    ])!;

    expect(confirmed.subject.tokens.map((t) => t.value)).toEqual([
      "WETH",
      "USDC",
    ]);
    expect(confirmed.activity.direction?.value).toBe("buy");
    expect(confirmed.filters[0]?.value).toBe("100000");
    expect(explainWatchCapabilities(confirmed).state).toBe("READY_TO_BUILD");
  });
  it.each([
    "Watch USDC transfers above $500K on Base from this wallet.",
    "Watch $100K+ ETH buys on Uniswap V3 from new wallets.",
    "Watch $100K+ ETH buys on Uniswap V4.",
    "Watch USDC transfers above $500K on Ethereum.",
    "Watch USDC transfers above $0 on Base.",
  ])("does not discard additional or different conditions: %s", (prompt) => {
    expect(resolveSimpleMonitoringRequest(prompt)).toBeNull();
  });
});
