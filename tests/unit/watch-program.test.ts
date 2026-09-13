import { describe, expect, it } from "vitest";

import {
  BASE_USDC,
  evaluateWatchProgram,
  type HistoricalEvidence,
  normalizedEventIdentity,
  type NormalizedOnchainEvent,
  planProgramCapabilities,
  POOLS,
  TOKENS,
  verifyProgramAcceptance,
  type WatchProgram,
  WatchProgramSchema,
} from "@scout/domain";

import { projectEvent } from "../../packages/domain/src/monitoring/event";
import { aggregateMetric } from "../../packages/domain/src/monitoring/runtime";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function event(
  n: number,
  amount = "500000000000",
  time = 1000 + n,
): NormalizedOnchainEvent {
  const raw = {
    chainId: 8453,
    blockNumber: String(n),
    blockHash: hash(n),
    timestamp: time,
    transactionHash: hash(n + 100),
    transactionIndex: 0,
    eventIndex: 0,
    actor: address(n),
    subject: BASE_USDC,
    contract: BASE_USDC,
    protocol: "erc20",
    eventType: "transfer",
    assets: [
      {
        address: BASE_USDC,
        direction: "transfer" as const,
        rawAmount: amount,
        decimals: 6,
        valuation: {
          kind: "nominal_stablecoin" as const,
          valueMicros: amount,
          source: "nominal_usdc",
        },
      },
    ],
    attributes: { sender: address(n), recipient: address(50) },
    provenance: {
      source: "substreams" as const,
      package: "controlled",
      module: "controlled",
      decoder: "controlled",
      pipelineVersion: "controlled",
    },
    finalized: true as const,
  };

  return { ...raw, id: normalizedEventIdentity(raw) };
}

function program(): WatchProgram {
  return WatchProgramSchema.parse({
    version: 1,
    source: {
      chainId: 8453,
      eventType: "transfer",
      protocol: "erc20",
      contracts: [BASE_USDC],
    },
    asset: BASE_USDC,
    filter: null,
    window: { kind: "event" },
    metrics: [{ id: "amount", operation: "sum", field: "amount" }],
    condition: {
      kind: "metric",
      metric: "amount",
      operator: "gte",
      value: "500000000000",
    },
    history: [],
    decision: "alert_on_match",
    delivery: { channels: ["inbox"], useDefaults: true },
  });
}

function swaps(): { p: WatchProgram; events: NormalizedOnchainEvent[] } {
  const p = program();

  p.source = {
    chainId: 1,
    eventType: "swap",
    protocol: "uniswap_v3",
    contracts: [POOLS[0].address],
  };
  p.asset = TOKENS[0].address;
  p.window = { kind: "rolling", seconds: 600, groupBy: ["asset"] };
  p.filter = {
    kind: "text",
    field: "direction",
    operator: "eq",
    values: ["sell"],
  };
  p.metrics = [{ id: "actors", operation: "unique_count", field: "actor" }];
  p.condition = {
    kind: "metric",
    metric: "actors",
    operator: "gte",
    value: "5",
  };

  const events = [1, 2, 3, 4, 5].map((n) => {
    const e = event(n);

    e.chainId = 1;
    e.protocol = "uniswap_v3";
    e.eventType = "swap";
    e.subject = e.contract = POOLS[0].address;
    e.assets[0]!.address = TOKENS[0].address;
    e.assets[0]!.direction = "sell";
    e.id = normalizedEventIdentity(e);

    return e;
  });

  return { p, events };
}

function prior(
  e: NormalizedOnchainEvent,
  status: HistoricalEvidence["status"],
): HistoricalEvidence {
  return {
    requirementId: "first",
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
    evidenceIds: status === "FOUND" ? ["prior-chain-event"] : [],
    provider: "controlled-history",
    reason: null,
  };
}

describe("one monitoring language across acquisition adapters", () => {
  it("scenario 1: tests exact boundaries, wrong asset, chain and duplicates", () => {
    const p = program();

    expect(evaluateWatchProgram(p, event(1)).status).toBe("MATCH");
    expect(evaluateWatchProgram(p, event(1, "499999999999")).status).toBe(
      "NO_MATCH",
    );
    expect(
      evaluateWatchProgram(p, event(1), [event(1)]).evidenceIds,
    ).toHaveLength(1);

    const wrong = event(1);

    wrong.assets[0]!.address = address(9);
    expect(evaluateWatchProgram(p, wrong).status).toBe("NO_MATCH");
  });
  it("scenario 2: threshold plus proven prior activity; unknown never alerts", () => {
    const { p, events } = swaps();
    const e = events[0]!;

    p.window = { kind: "event" };
    p.metrics = [{ id: "amount", operation: "sum", field: "valueMicros" }];
    p.condition = {
      kind: "metric",
      metric: "amount",
      operator: "gte",
      value: "100000000000",
    };
    p.history = [
      {
        id: "first",
        kind: "prior_activity",
        subject: "actor",
        protocol: "uniswap_v3",
        before: "current_transaction",
        expected: "none",
        application: "candidate",
      },
    ];

    for (const [status, expected] of [
      ["FOUND", "NO_MATCH"],
      ["NONE_WITH_PROVEN_COVERAGE", "MATCH"],
      ["UNKNOWN", "PENDING_CONTEXT"],
      ["ERROR_RETRYABLE", "PENDING_CONTEXT"],
    ] as const) {
      expect(
        evaluateWatchProgram(p, e, [], undefined, [prior(e, status)]).status,
      ).toBe(expected);
    }

    const absence = prior(e, "NONE_WITH_PROVEN_COVERAGE");

    absence.coverage = null;
    expect(evaluateWatchProgram(p, e, [], undefined, [absence]).status).toBe(
      "PENDING_CONTEXT",
    );
    expect(
      evaluateWatchProgram(p, e, [], undefined, [
        prior(e, "FOUND"),
        prior(e, "NONE_WITH_PROVEN_COVERAGE"),
      ]).status,
    ).toBe("PENDING_CONTEXT");
  });
  it("scenario 3: five unique sellers; repeated actor and expiry do not count", () => {
    const { p, events } = swaps();
    const coverage = { from: 0, through: 2000 };

    expect(evaluateWatchProgram(p, events[3]!, events, coverage).status).toBe(
      "NO_MATCH",
    );
    expect(evaluateWatchProgram(p, events[4]!, events, coverage).status).toBe(
      "MATCH",
    );
    events[0]!.actor = events[1]!.actor;
    expect(evaluateWatchProgram(p, events[4]!, events, coverage).status).toBe(
      "NO_MATCH",
    );
    events[0]!.actor = address(1);
    events[0]!.timestamp = events[4]!.timestamp - 600;
    expect(evaluateWatchProgram(p, events[4]!, events, coverage).status).toBe(
      "NO_MATCH",
    );
  });
  it("scenario 4: sums transfers per recipient without pool fields", () => {
    const p = program();

    p.window = { kind: "rolling", seconds: 3600, groupBy: ["recipient"] };
    p.condition = {
      kind: "metric",
      metric: "amount",
      operator: "gte",
      value: "1000000000000",
    };

    const events = [event(1, undefined, 4001), event(2, undefined, 4002)];

    expect(
      evaluateWatchProgram(p, events[1]!, events, { from: 0, through: 4002 })
        .status,
    ).toBe("MATCH");
    events[0]!.attributes.recipient = address(51);
    expect(
      evaluateWatchProgram(p, events[1]!, events, { from: 0, through: 4002 })
        .status,
    ).toBe("NO_MATCH");
  });
  it("scenario 5: metric drop is representable, but no liquidity state source is claimed", () => {
    const p = program();

    p.source.eventType = "liquidity_state";
    p.metrics = [
      { id: "change", operation: "percentage_delta", field: "metric" },
    ];
    p.condition = {
      kind: "metric",
      metric: "change",
      operator: "lte",
      value: "-30",
    };

    const plan = planProgramCapabilities(p);

    expect(plan.status).not.toBe("READY_TO_MONITOR");
    expect(plan.dependencies).toContainEqual(
      expect.objectContaining({
        capability: "field:metric",
        status: "REQUIRES_DATA_PIPELINE",
      }),
    );
  });
  it("scenario 6: history filters each actor BEFORE distinct count and sum", () => {
    const { p, events } = swaps();

    p.window = { kind: "rolling", seconds: 900, groupBy: ["asset"] };
    p.filter = null;
    p.history = [
      {
        id: "first",
        kind: "prior_activity",
        subject: "actor",
        protocol: "uniswap_v3",
        before: "current_transaction",
        expected: "none",
        application: "eligible_events",
      },
    ];
    p.metrics.push({ id: "value", operation: "sum", field: "valueMicros" });
    p.condition = {
      kind: "all",
      terms: [
        { kind: "metric", metric: "actors", operator: "gte", value: "3" },
        {
          kind: "metric",
          metric: "value",
          operator: "gte",
          value: "500000000000",
        },
      ],
    };

    const evidence = events.map((e) => prior(e, "NONE_WITH_PROVEN_COVERAGE"));
    const coverage = { from: 0, through: 2000 };

    expect(
      evaluateWatchProgram(p, events[2]!, events, coverage, evidence).status,
    ).toBe("MATCH");
    evidence[0] = prior(events[0]!, "FOUND");
    expect(
      evaluateWatchProgram(p, events[2]!, events, coverage, evidence).status,
    ).toBe("NO_MATCH");
    evidence[0] = prior(events[0]!, "UNKNOWN");
    expect(
      evaluateWatchProgram(p, events[2]!, events, coverage, evidence).status,
    ).toBe("PENDING_CONTEXT");
  });
  it("fails closed on missing coverage, conflicting events and invented primitives", () => {
    const { p, events } = swaps();

    expect(evaluateWatchProgram(p, events[4]!, events).status).toBe(
      "INSUFFICIENT_DATA",
    );
    expect(
      evaluateWatchProgram(
        p,
        events[4]!,
        [...events, { ...events[0]!, actor: address(99) }],
        { from: 0, through: 2000 },
      ).status,
    ).toBe("INSUFFICIENT_DATA");
    expect(
      WatchProgramSchema.safeParse({
        ...p,
        metrics: [
          { id: "magic", operation: "magical_whale_behavior", field: "actor" },
        ],
      }).success,
    ).toBe(false);
  });
  it("does not allow NOT to turn a missing field into a match", () => {
    const p = program();

    p.filter = {
      kind: "not",
      term: { kind: "number", field: "metric", operator: "eq", value: "1" },
    };
    expect(evaluateWatchProgram(p, event(1)).status).toBe("INSUFFICIENT_DATA");
  });
  it("keeps averages and even medians exact, including signed deltas", () => {
    const p = program();
    const rows = [event(1, "1"), event(2, "2")].map((e) => projectEvent(e, p));

    for (const operation of ["average", "median"] as const) {
      expect(
        aggregateMetric({ id: "n", operation, field: "amount" }, rows),
      ).toEqual({ numerator: "3", denominator: "2" });
    }

    expect(
      aggregateMetric(
        { id: "n", operation: "percentage_delta", field: "amount" },
        rows.reverse(),
      ),
    ).toEqual({ numerator: "-100", denominator: "2" });
  });
  it("capability support is not a substitute for pipeline, acceptance and stream proof", () => {
    const p = program();

    expect(planProgramCapabilities(p).status).toBe("NEEDS_PIPELINE_BUILD");
    expect(
      planProgramCapabilities(p, {
        pipelineVerified: true,
        acceptanceVerified: false,
        healthyStream: true,
      }).status,
    ).not.toBe("READY_TO_MONITOR");
    expect(
      planProgramCapabilities(p, {
        pipelineVerified: true,
        acceptanceVerified: true,
        healthyStream: true,
      }).status,
    ).toBe("READY_TO_MONITOR");
  });
  it("generates whole-program threshold acceptance evidence without claiming pipeline verification", () => {
    const p = program();
    const report = verifyProgramAcceptance(p, event(1));

    expect(report.finalStatus).toBe("INTENT_ACCEPTANCE_VERIFIED");
    expect(report.pipelineVerification.status).toBe("NOT_VERIFIED");
    expect(report.acceptanceCases.map((c) => c.description)).toContain(
      "threshold_equal",
    );

    const { p: composed, events } = swaps();

    expect(verifyProgramAcceptance(composed, events[0]!).finalStatus).toBe(
      "PARTIAL",
    );
  });
  it("rejects stale prices and prices checked at a different block", () => {
    const p = program();

    p.metrics[0]!.field = "valueMicros";

    const e = event(1);

    e.assets[0]!.valuation = {
      kind: "usd_price",
      valueMicros: "600000000000",
      source: "controlled",
      blockNumber: "999",
      timestamp: e.timestamp,
      stale: false,
    };
    expect(evaluateWatchProgram(p, e).status).toBe("INSUFFICIENT_DATA");
    e.assets[0]!.valuation.blockNumber = e.blockNumber;
    e.assets[0]!.valuation.stale = true;
    expect(evaluateWatchProgram(p, e).status).toBe("INSUFFICIENT_DATA");
  });
});
