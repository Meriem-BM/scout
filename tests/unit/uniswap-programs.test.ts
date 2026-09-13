import { describe, expect, it } from "vitest";

import {
  evaluateWatchProgram,
  type HistoricalEvidence,
  type NormalizedOnchainEvent,
  POOLS,
  TOKENS,
} from "@scout/domain";

import { normalizedEventIdentity } from "../../packages/domain/src/monitoring/event";
import {
  resolveUniswapScope,
  uniswapReferencePrograms,
} from "../../packages/domain/src/uniswap/programs";

const programs = uniswapReferencePrograms({
  kind: "pool",
  address: POOLS[0].address,
});
const hex = (n: number, len: number) =>
  `0x${n.toString(16).padStart(len, "0")}`;

function event(
  n: number,
  direction: "buy" | "sell" = "buy",
): NormalizedOnchainEvent {
  const raw = {
    chainId: 1,
    blockNumber: String(n),
    blockHash: hex(n, 64),
    timestamp: 2000 + n,
    transactionHash: hex(n + 100, 64),
    transactionIndex: 0,
    eventIndex: 0,
    actor: hex(n, 40),
    subject: POOLS[0].address,
    contract: POOLS[0].address,
    protocol: "uniswap_v3",
    eventType: "swap",
    assets: [
      {
        address: TOKENS[0].address,
        direction,
        rawAmount: "1000000000000000000",
        decimals: 18,
        valuation: {
          kind: "nominal_stablecoin" as const,
          source: "controlled_trade_notional",
          valueMicros: "200000000000",
        },
      },
    ],
    attributes: {},
    provenance: {
      source: "substreams" as const,
      package: "CONTROLLED",
      module: "CONTROLLED",
      decoder: "CONTROLLED",
      pipelineVersion: "CONTROLLED",
    },
    finalized: true as const,
  };

  return { ...raw, id: normalizedEventIdentity(raw) };
}

function history(
  e: NormalizedOnchainEvent,
  status: HistoricalEvidence["status"],
): HistoricalEvidence {
  return {
    requirementId: "prior_protocol",
    eventId: e.id,
    subject: e.actor!,
    protocol: "uniswap_v3",
    beforeTransaction: e.transactionHash,
    status,
    coverage: {
      fromBlock: "0",
      throughBlock: e.blockNumber,
      blockHash: e.blockHash,
      complete: true,
    },
    evidenceIds: status === "FOUND" ? ["controlled-prior"] : [],
    provider: "CONTROLLED",
    reason: "Controlled acceptance, not real history",
  };
}

describe("Uniswap supplies data; generic primitives decide", () => {
  it("never substitutes two catalog pools for all fee tiers", () => {
    expect(resolveUniswapScope({ kind: "all_matching" })).toMatchObject({
      status: "NEEDS_DATA_RESOLUTION",
      contracts: [],
      completeForRequestedScope: false,
    });
    expect(
      resolveUniswapScope({ kind: "fee_tier", fee: 500 }).contracts,
    ).toEqual([POOLS[0].address]);
    expect(resolveUniswapScope({ kind: "fee_tier", fee: 100 }).status).toBe(
      "NEEDS_DATA_RESOLUTION",
    );
  });
  it("reports missing liquidity data instead of creating a fake program", () => {
    expect(programs.liquidityExits.program).toBeNull();
    expect(programs.liquidityExits.missing[0]).toContain("liquidity_removal");
  });
  it("accepts buys and rejects sells, below threshold and wrong pools", () => {
    const p = programs.buys.program!;

    expect(evaluateWatchProgram(p, event(1)).status).toBe("MATCH");
    expect(evaluateWatchProgram(p, event(1, "sell")).status).toBe("NO_MATCH");

    const low = event(1);

    low.assets[0]!.valuation!.valueMicros = "99999000000";
    expect(evaluateWatchProgram(p, low).status).toBe("NO_MATCH");

    const wrong = event(1);

    wrong.contract = POOLS[1].address;
    expect(evaluateWatchProgram(p, wrong).status).toBe("NO_MATCH");
  });
  it.each([
    ["FOUND", "NO_MATCH"],
    ["NONE_WITH_PROVEN_COVERAGE", "MATCH"],
    ["UNKNOWN", "PENDING_CONTEXT"],
    ["ERROR_RETRYABLE", "PENDING_CONTEXT"],
  ] as const)("context %s -> %s", (status, expected) => {
    const e = event(1);

    expect(
      evaluateWatchProgram(programs.firstTimeBuys.program!, e, [e], undefined, [
        history(e, status),
      ]).status,
    ).toBe(expected);
  });
  it("composes actor count, sum, first-seen eligibility and expiry without a detector", () => {
    const p = programs.firstTimeCombinedBuys.program!;
    const events = [event(1), event(2), event(3)];
    const prior = events.map((e) => history(e, "NONE_WITH_PROVEN_COVERAGE"));
    const coverage = { from: 0, through: 2003 };

    expect(
      evaluateWatchProgram(p, events[1]!, events.slice(0, 2), coverage, prior)
        .status,
    ).toBe("NO_MATCH");

    const result = evaluateWatchProgram(p, events[2]!, events, coverage, prior);

    expect(result.status).toBe("MATCH");
    expect(
      evaluateWatchProgram(
        p,
        events[2]!,
        [...events, ...events],
        coverage,
        prior,
      ),
    ).toEqual(result);

    const expired = structuredClone(events);

    expired[0]!.timestamp = 1000;
    expect(
      evaluateWatchProgram(p, expired[2]!, expired, coverage, prior).status,
    ).toBe("NO_MATCH");

    const other = structuredClone(events);

    other[0]!.assets[0]!.address = TOKENS[1].address;
    expect(
      evaluateWatchProgram(p, other[2]!, other, coverage, prior).status,
    ).toBe("NO_MATCH");
    prior[0] = history(events[0]!, "UNKNOWN");
    expect(
      evaluateWatchProgram(p, events[2]!, events, coverage, prior).status,
    ).toBe("PENDING_CONTEXT");
  });
  it("counts distinct sellers using the same engine", () => {
    const e = [event(1, "sell"), event(2, "sell"), event(3, "sell")];
    const p = programs.distinctSellers.program!;

    expect(
      evaluateWatchProgram(p, e[2]!, e, { from: 0, through: 2003 }).status,
    ).toBe("MATCH");
    e[0]!.actor = e[1]!.actor;
    expect(
      evaluateWatchProgram(p, e[2]!, e, { from: 0, through: 2003 }).status,
    ).toBe("NO_MATCH");
  });
});
