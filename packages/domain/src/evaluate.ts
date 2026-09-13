import { LIMITS } from "./limits";
import {
  normalizeLegacySwap,
  swapConditionProgram,
} from "./monitoring/compatibility";
import { evaluateWatchProgram } from "./monitoring/runtime";
import {
  evaluateRuntimeRule,
  type RuntimeCoverage,
  type RuntimeEvent,
} from "./runtime-rules";
import { describeCondition, maxWindow } from "./spec";

import type { ConditionMatch, Detection, SwapEvent } from "./evidence";
import type { Condition, WatchSpec } from "./spec";

export function canonicalEvents(events: readonly SwapEvent[]): SwapEvent[] {
  const unique = new Map<string, SwapEvent>();

  for (const event of events) {
    if (event.finality === "finalized") {
      unique.set(event.id, event);
    }
  }

  return [...unique.values()].sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      (BigInt(a.blockNumber) < BigInt(b.blockNumber)
        ? -1
        : BigInt(a.blockNumber) > BigInt(b.blockNumber)
          ? 1
          : a.logIndex - b.logIndex),
  );
}

const total = (events: readonly SwapEvent[]) =>
  events.reduce(
    (sum, event) => sum + BigInt(event.valuation?.usdMicros ?? "0"),
    0n,
  );
const transactions = (events: readonly SwapEvent[]) =>
  new Set(events.map((event) => event.transactionHash)).size;

function conditionMatch(
  condition: Condition,
  anchor: SwapEvent,
  events: SwapEvent[],
  coverage?: RuntimeCoverage,
  specForCondition?: WatchSpec,
): ConditionMatch {
  let selected: SwapEvent[];

  if (condition.kind === "aggregate") {
    const toRuntime = (event: SwapEvent): RuntimeEvent => ({
      id: event.id,
      chainId: event.chainId,
      blockNumber: event.blockNumber,
      index: event.logIndex,
      timestamp: event.timestamp,
      finalized: event.finality === "finalized",
      fields: {
        pool: event.pool,
        participant: event.attributable ? event.initiator : null,
        transaction: event.transactionHash,
        soldToken: event.sellToken,
        usdMicros: event.valuation?.usdMicros ?? null,
        amount: event.sellAmount,
      },
    });
    const evaluated = evaluateRuntimeRule(
      condition.rule,
      toRuntime(anchor),
      events.map(toRuntime),
      coverage ?? { from: anchor.timestamp, through: anchor.timestamp },
    );

    selected = events.filter((event) =>
      evaluated.evidenceIds.includes(event.id),
    );

    return {
      condition: condition.kind,
      matched: evaluated.status === "MATCH",
      observedUsdMicros: total(selected).toString(),
      observedCount: transactions(selected),
      evidenceIds: evaluated.evidenceIds,
      rule: condition.description,
      aggregation: {
        ...evaluated,
        baselineEvidence: events
          .filter((event) => evaluated.baselineEvidenceIds.includes(event.id))
          .slice(-LIMITS.evidencePerIncident),
        baselineEvidenceComplete:
          evaluated.baselineEvidenceIds.length <= LIMITS.evidencePerIncident,
      },
    };
  }

  const program = swapConditionProgram(specForCondition!, condition);

  // This boundary creates a candidate. Required historical truth is resolved by
  // the immutable investigation job before a delivery decision is made.
  program.history = [];

  const normalized = events.map((event) => normalizeLegacySwap(event));
  const normalizedAnchor = normalizeLegacySwap(anchor);
  const evaluated = evaluateWatchProgram(
    program,
    normalizedAnchor,
    normalized,
    coverage ?? {
      from:
        anchor.timestamp -
        (program.window.kind === "rolling" ? program.window.seconds : 0),
      through: anchor.timestamp,
    },
  );

  const matched = evaluated.status === "MATCH";

  selected = events.filter((event) =>
    evaluated.evidenceIds.includes(normalizeLegacySwap(event).id),
  );

  return {
    condition: condition.kind,
    matched,
    observedUsdMicros: total(selected).toString(),
    observedCount: transactions(selected),
    evidenceIds: matched ? selected.map((event) => event.id) : [],
    rule: describeCondition(condition),
  };
}

/** Sliding windows use block time, (anchor - duration, anchor]. Totals are gross, per-pool, input-side value. */
export function evaluate(
  spec: WatchSpec,
  anchor: SwapEvent,
  history: readonly SwapEvent[],
  coverage?: RuntimeCoverage,
): Detection | null {
  if (
    !spec.pools.includes(anchor.pool) ||
    (spec.streamDirection !== "either" &&
      anchor.sellToken !== spec.sellToken) ||
    anchor.finality !== "finalized" ||
    anchor.valuation === null
  ) {
    return null;
  }

  const events = canonicalEvents([...history, anchor]).filter(
    (event) =>
      event.pool === anchor.pool &&
      (spec.streamDirection === "either" ||
        event.sellToken === spec.sellToken) &&
      (spec.conditions.some((condition) => condition.kind === "aggregate") ||
        event.valuation !== null) &&
      event.timestamp <= anchor.timestamp &&
      (BigInt(event.blockNumber) < BigInt(anchor.blockNumber) ||
        (event.blockNumber === anchor.blockNumber &&
          event.logIndex <= anchor.logIndex)) &&
      event.timestamp > anchor.timestamp - maxWindow(spec),
  );

  if (events.length > LIMITS.eventsPerWindow) {
    throw new Error(
      "Window capacity exceeded; monitoring requires operator attention.",
    );
  }

  const matches = spec.conditions.map((condition) =>
    conditionMatch(condition, anchor, events, coverage, spec),
  );

  if (
    !(spec.combine === "all"
      ? matches.every((match) => match.matched)
      : matches.some((match) => match.matched))
  ) {
    return null;
  }

  const evidenceIds = [
    ...new Set(matches.flatMap((match) => match.evidenceIds)),
  ];
  const evidence = events.filter((event) => evidenceIds.includes(event.id));

  return {
    pool: anchor.pool,
    initiator:
      spec.investigation.requireNoPriorUniswapSwaps ||
      matches.some(
        (match) => match.condition === "repeated_selling" && match.matched,
      )
        ? anchor.initiator
        : null,
    timestamp: anchor.timestamp,
    totalUsdMicros: total(evidence).toString(),
    transactionCount: transactions(evidence),
    evidenceIds,
    matches,
    severity: matches.some(
      (match) => match.matched && match.condition !== "large_swap",
    )
      ? "attention"
      : "notice",
  };
}

export function rollbackEvents(
  events: readonly SwapEvent[],
  lastValidBlock: string,
): SwapEvent[] {
  return events.map((event) =>
    BigInt(event.blockNumber) > BigInt(lastValidBlock)
      ? { ...event, finality: "retracted" }
      : event,
  );
}
