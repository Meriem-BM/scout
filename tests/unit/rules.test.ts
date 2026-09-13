import { describe, expect, it } from "vitest";

import {
  canonicalEvents,
  decimal,
  defaultSpec,
  evaluate,
  eventId,
  POOLS,
  rollbackEvents,
  TOKENS,
  units,
  usd,
  valueUsd,
  WatchSpecSchema,
} from "@scout/domain";

import { fixtureEvents } from "../fixtures/swap-events";

import type { SwapEvent } from "@scout/domain";

const events = () => fixtureEvents();

const anchor = () => {
  const value = events()[2];

  if (!value) {
    throw new Error("Fixture missing");
  }

  return value;
};

function altered(event: SwapEvent, patch: Partial<SwapEvent>) {
  const result = { ...event, ...patch };

  // Keep controlled reference prices coherent when moving fixture chain evidence.
  if (!Object.hasOwn(patch, "valuation") && result.valuation) {
    result.valuation = {
      ...result.valuation,
      blockNumber: result.blockNumber,
      updatedAt: Math.min(result.valuation.updatedAt, result.timestamp - 1),
    };
  }

  return { ...result, id: eventId(result) };
}

describe("precise token and USD amounts", () => {
  it("preserves one wei and very large balances", () => {
    expect(units("123456789012.000000000000000001", 18)).toBe(
      123456789012000000000000000001n,
    );
    expect(decimal(1n, 18, 18)).toBe("0.000000000000000001");
  });
  it.each(["1e6", "-1", "NaN", " 1", "1.0000001"])(
    "rejects malformed or overprecise USDC %s",
    (value) => expect(() => units(value, 6)).toThrow(),
  );
  it("never assumes USDC equals a dollar", () =>
    expect(valueUsd("1000000000", 6, "98000000", 8)).toBe("980000000"));
  it("uses input-side value only and floors sub-micro fractions", () => {
    expect(valueUsd("1000000000000000000", 18, "320000000000", 8)).toBe(
      "3200000000",
    );
    expect(valueUsd("1", 18, "320000000000", 8)).toBe("0");
  });
  it("formats USD without losing integer precision", () =>
    expect(usd("208000000000")).toBe("$208,000"));
});
describe("composable deterministic conditions", () => {
  it("matches exactly the third attributed transaction", () => {
    expect(evaluate(defaultSpec(), events()[0]!, events())).toBeNull();

    const match = evaluate(defaultSpec(), anchor(), events());

    expect(match?.transactionCount).toBe(3);
    expect(match?.totalUsdMicros).toBe("208000000000");
    expect(match?.evidenceIds).toHaveLength(3);
  });
  it("uses strict greater-than for USD, inclusive minimum for count", () => {
    const spec = defaultSpec();

    spec.conditions = [{ kind: "large_swap", usd: "83200" }];
    expect(evaluate(spec, anchor(), events())).toBeNull();
    spec.conditions = [{ kind: "large_swap", usd: "83199.999999" }];
    expect(evaluate(spec, anchor(), events())).not.toBeNull();
  });
  it("excludes the exact window-start boundary", () => {
    const data = events();
    const last = anchor();
    const first = data[0];

    if (!first) {
      throw new Error("Missing fixture");
    }

    data[0] = altered(first, { timestamp: last.timestamp - 900 });
    expect(evaluate(defaultSpec(), last, data)).toBeNull();
    data[0] = altered(first, { timestamp: last.timestamp - 899 });
    expect(evaluate(defaultSpec(), last, data)).not.toBeNull();
  });
  it("does not count later logs from the same block", () => {
    const data = events()
      .slice(0, 3)
      .map((item, index) =>
        altered(item, {
          blockNumber: "99",
          blockHash: anchor().blockHash,
          timestamp: anchor().timestamp,
          logIndex: index,
        }),
      );

    expect(evaluate(defaultSpec(), data[0]!, data)).toBeNull();
    expect(evaluate(defaultSpec(), data[2]!, data)?.transactionCount).toBe(3);
  });
  it("replay and duplicate logs never increase volume", () => {
    const data = events();
    const result = evaluate(defaultSpec(), anchor(), [
      ...data,
      ...data,
      ...data,
    ]);

    expect(result?.totalUsdMicros).toBe("208000000000");
    expect(canonicalEvents([...data, ...data])).toHaveLength(4);
  });
  it("two events in one transaction do not count as two initiator transactions", () => {
    const data = events();

    data[1] = altered(data[1]!, { transactionHash: data[0]!.transactionHash });
    expect(evaluate(defaultSpec(), anchor(), data)).toBeNull();
  });
  it("does not sum routed hops across pools", () => {
    const data = events();

    data[1] = altered(data[1]!, { pool: POOLS[1].address });

    const spec = defaultSpec();

    spec.pools = [...POOLS.map((pool) => pool.address)];
    expect(evaluate(spec, anchor(), data)).toBeNull();
  });
  it("buying WETH does not count as selling WETH", () => {
    const event = altered(anchor(), { sellToken: TOKENS[1].address });

    expect(evaluate(defaultSpec(), event, events())).toBeNull();
  });
  it("does not label a router or bundler as an attributable seller", () => {
    const data = events().map((event) => ({ ...event, attributable: false }));

    expect(evaluate(defaultSpec(), data[2]!, data)).toBeNull();
  });
  it("can detect aggregate pool selling without attributing ownership", () => {
    const spec = defaultSpec();

    spec.conditions = [
      { kind: "pool_selling", cumulativeUsd: "200000", windowSeconds: 900 },
    ];

    const data = events().map((event) => ({ ...event, attributable: false }));

    expect(evaluate(spec, data[2]!, data)?.totalUsdMicros).toBe("208000000000");
    expect(evaluate(spec, data[2]!, data)?.initiator).toBeNull();
  });
  it("combines cumulative and count thresholds with explicit OR", () => {
    const spec = defaultSpec();

    spec.conditions = [
      {
        kind: "repeated_selling",
        count: 10,
        cumulativeUsd: "200000",
        minSwapUsd: "50000",
        windowSeconds: 900,
      },
    ];
    expect(evaluate(spec, anchor(), events())).not.toBeNull();
  });
  it("combines conditions using the reviewed operator", () => {
    const spec = defaultSpec();

    spec.conditions = [
      { kind: "large_swap", usd: "100000" },
      { kind: "pool_selling", cumulativeUsd: "200000", windowSeconds: 900 },
    ];
    expect(evaluate(spec, anchor(), events())).toBeNull();
    spec.combine = "any";
    expect(evaluate(spec, anchor(), events())).not.toBeNull();
  });
  it("will not fabricate a USD match when the oracle is unavailable", () => {
    expect(
      evaluate(defaultSpec(), { ...anchor(), valuation: null }, events()),
    ).toBeNull();

    const data = events().map((event) => ({ ...event, valuation: null }));

    expect(evaluate(defaultSpec(), anchor(), data)).toBeNull();
  });
  it.each(["provisional", "retracted"] as const)(
    "does not alert on %s evidence",
    (finality) =>
      expect(
        evaluate(defaultSpec(), { ...anchor(), finality }, events()),
      ).toBeNull(),
  );
  it("retracts only events past the valid block and no longer matches", () => {
    const data = rollbackEvents(events(), events()[1]!.blockNumber);

    expect(data[0]?.finality).toBe("finalized");
    expect(data[2]?.finality).toBe("retracted");
    expect(evaluate(defaultSpec(), data[2]!, data)).toBeNull();
  });
  it("validates token contract, pool, windows, and meaning", () => {
    expect(
      WatchSpecSchema.safeParse({ ...defaultSpec(), sellToken: "WETH" })
        .success,
    ).toBe(false);
    expect(
      WatchSpecSchema.safeParse({ ...defaultSpec(), pools: [] }).success,
    ).toBe(false);
    expect(
      WatchSpecSchema.safeParse({
        ...defaultSpec(),
        pools: [POOLS[0].address, POOLS[0].address],
      }).success,
    ).toBe(false);
    expect(
      WatchSpecSchema.safeParse({
        ...defaultSpec(),
        conditions: [
          {
            kind: "repeated_selling",
            count: null,
            cumulativeUsd: null,
            minSwapUsd: "0",
            windowSeconds: 7200,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
