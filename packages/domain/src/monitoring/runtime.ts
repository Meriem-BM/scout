import {
  type EventProjection,
  type NormalizedOnchainEvent,
  NormalizedOnchainEventSchema,
  projectEvent,
  sameNormalizedEvidence,
} from "./event";
import {
  type HistoricalEvidence,
  HistoricalEvidenceSchema,
  type HistoricalRequirement,
  type Metric,
  type Predicate,
  type ProgramCondition,
  type WatchProgram,
  WatchProgramSchema,
} from "./program";

type Truth = true | false | "UNKNOWN";

export type Fraction = { numerator: string; denominator: string };

export type ProgramEvaluation = {
  status: "MATCH" | "NO_MATCH" | "PENDING_CONTEXT" | "INSUFFICIENT_DATA";
  evidenceIds: string[];
  actorSet: string[];
  group: string[];
  metrics: Record<string, Fraction | null>;
  reasons: string[];
};

export type ObservationCoverage = { from: number; through: number };

const fraction = (n: bigint, d = 1n): Fraction => ({
  numerator: n.toString(),
  denominator: d.toString(),
});

export function compareFraction(
  left: Fraction,
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte",
  right: string,
): boolean {
  const a = BigInt(left.numerator);
  const b = BigInt(right) * BigInt(left.denominator);

  switch (op) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
  }
}

function combine(kind: "all" | "any", values: Truth[]): Truth {
  if (kind === "all") {
    return values.includes(false)
      ? false
      : values.includes("UNKNOWN")
        ? "UNKNOWN"
        : true;
  }

  return values.includes(true)
    ? true
    : values.includes("UNKNOWN")
      ? "UNKNOWN"
      : false;
}

export function evaluatePredicate(
  predicate: Predicate,
  fields: EventProjection,
): Truth {
  if (predicate.kind === "all" || predicate.kind === "any") {
    return combine(
      predicate.kind,
      predicate.terms.map((p) => evaluatePredicate(p, fields)),
    );
  }

  if (predicate.kind === "not") {
    const result = evaluatePredicate(predicate.term, fields);

    return result === "UNKNOWN" ? result : !result;
  }

  const value = fields[predicate.field];

  if (value === null) {
    return "UNKNOWN";
  }

  if (predicate.kind === "text") {
    return predicate.operator === "ne"
      ? !predicate.values.includes(value)
      : predicate.values.includes(value);
  }

  if (!/^-?\d{1,78}$/.test(value)) {
    return "UNKNOWN";
  }

  return compareFraction(
    fraction(BigInt(value)),
    predicate.operator,
    predicate.value,
  );
}

function evaluateCondition(
  condition: ProgramCondition,
  metrics: Record<string, Fraction | null>,
): Truth {
  if (condition.kind === "all" || condition.kind === "any") {
    return combine(
      condition.kind,
      condition.terms.map((c) => evaluateCondition(c, metrics)),
    );
  }

  if (condition.kind === "not") {
    const result = evaluateCondition(condition.term, metrics);

    return result === "UNKNOWN" ? result : !result;
  }

  const metric = metrics[condition.metric];

  return metric
    ? compareFraction(metric, condition.operator, condition.value)
    : "UNKNOWN";
}

export function aggregateMetric(
  metric: Metric,
  rows: EventProjection[],
): Fraction | null {
  if (metric.operation === "count") {
    return fraction(BigInt(rows.length));
  }

  const values = rows.map((row) => (metric.field ? row[metric.field] : null));

  if (values.some((value) => value === null)) {
    return null;
  }

  if (metric.operation === "unique_count") {
    return fraction(BigInt(new Set(values).size));
  }

  if (values.some((value) => !/^-?\d{1,78}$/.test(value!))) {
    return null;
  }

  const numbers = values.map((value) => BigInt(value!));

  if (metric.operation === "sum") {
    return fraction(numbers.reduce((sum, n) => sum + n, 0n));
  }

  if (!numbers.length) {
    return null;
  }

  if (metric.operation === "average") {
    return fraction(
      numbers.reduce((sum, n) => sum + n, 0n),
      BigInt(numbers.length),
    );
  }

  if (
    metric.operation === "absolute_delta" ||
    metric.operation === "percentage_delta"
  ) {
    if (numbers.length < 2) {
      return null;
    }

    const before = numbers[0]!;
    const delta = numbers.at(-1)! - before;

    if (metric.operation === "absolute_delta") {
      return fraction(delta);
    }

    if (before === 0n) {
      return null;
    }

    return fraction(delta * 100n, before < 0n ? -before : before);
  }

  numbers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (metric.operation === "min") {
    return fraction(numbers[0]!);
  }

  if (metric.operation === "max") {
    return fraction(numbers.at(-1)!);
  }

  const middle = Math.floor(numbers.length / 2);

  return numbers.length % 2
    ? fraction(numbers[middle]!)
    : fraction(numbers[middle - 1]! + numbers[middle]!, 2n);
}

function order(a: NormalizedOnchainEvent, b: NormalizedOnchainEvent) {
  const blocks = BigInt(a.blockNumber) - BigInt(b.blockNumber);

  return blocks < 0n ? -1 : blocks > 0n ? 1 : a.eventIndex - b.eventIndex;
}

export function historicalTruth(
  requirement: HistoricalRequirement,
  event: NormalizedOnchainEvent,
  fields: EventProjection,
  evidence: readonly HistoricalEvidence[],
): Truth {
  const subject = fields[requirement.subject];

  if (!subject) {
    return "UNKNOWN";
  }

  const relevant = evidence.filter(
    (item) =>
      item.requirementId === requirement.id &&
      item.eventId === event.id &&
      item.subject === subject &&
      item.protocol === requirement.protocol &&
      item.beforeTransaction === event.transactionHash,
  );
  // A final observation is immutable; conflicting final evidence is not resolved by array order.
  const final = relevant.filter(
    (item) =>
      item.status === "FOUND" || item.status === "NONE_WITH_PROVEN_COVERAGE",
  );

  if (new Set(final.map((item) => item.status)).size !== 1) {
    return "UNKNOWN";
  }

  const result = final[0];

  if (!result) {
    return "UNKNOWN";
  }

  if (result.status === "FOUND" && !result.evidenceIds.length) {
    return "UNKNOWN";
  }

  if (
    result.status === "NONE_WITH_PROVEN_COVERAGE" &&
    (!result.coverage?.complete ||
      result.coverage.blockHash !== event.blockHash ||
      BigInt(result.coverage.throughBlock) !== BigInt(event.blockNumber))
  ) {
    return "UNKNOWN";
  }

  return requirement.expected === "none"
    ? result.status === "NONE_WITH_PROVEN_COVERAGE"
    : result.status === "FOUND";
}

/** Pure replayable evaluator. Providers establish coverage; seeing an event never establishes it. */
export function evaluateWatchProgram(
  input: WatchProgram,
  anchorInput: NormalizedOnchainEvent,
  historyInput: readonly NormalizedOnchainEvent[] = [],
  coverage?: ObservationCoverage,
  evidenceInput: readonly HistoricalEvidence[] = [],
): ProgramEvaluation {
  const program = WatchProgramSchema.parse(input);
  const anchor = NormalizedOnchainEventSchema.parse(anchorInput);
  const evidence = evidenceInput.map((item) =>
    HistoricalEvidenceSchema.parse(item),
  );
  const result: ProgramEvaluation = {
    status: "NO_MATCH",
    evidenceIds: [],
    actorSet: [],
    group: [],
    metrics: {},
    reasons: [],
  };
  const stop = (
    status: ProgramEvaluation["status"],
    reason: string,
  ): ProgramEvaluation => ({ ...result, status, reasons: [reason] });
  const sourceMatches = (event: NormalizedOnchainEvent) =>
    event.chainId === program.source.chainId &&
    event.eventType === program.source.eventType &&
    (!program.source.protocol || event.protocol === program.source.protocol) &&
    (!program.source.contracts.length ||
      program.source.contracts.includes(event.contract)) &&
    (!program.asset || event.assets.some((a) => a.address === program.asset));

  if (!sourceMatches(anchor)) {
    return result;
  }

  const anchorFields = projectEvent(anchor, program);
  const anchorFilter = program.filter
    ? evaluatePredicate(program.filter, anchorFields)
    : true;

  if (anchorFilter === false) {
    return result;
  }

  if (anchorFilter === "UNKNOWN") {
    return stop(
      "INSUFFICIENT_DATA",
      "A required event field or valid valuation is unavailable.",
    );
  }

  const window = program.window;
  const from =
    window.kind === "rolling"
      ? anchor.timestamp - window.seconds
      : anchor.timestamp;

  if (
    window.kind === "rolling" &&
    (!coverage ||
      !Number.isSafeInteger(coverage.from) ||
      !Number.isSafeInteger(coverage.through) ||
      coverage.from > from ||
      coverage.through < anchor.timestamp)
  ) {
    return stop(
      "INSUFFICIENT_DATA",
      "The complete event-time window has not been processed.",
    );
  }

  if (window.kind === "rolling") {
    if (window.groupBy.some((field) => anchorFields[field] === null)) {
      return stop("INSUFFICIENT_DATA", "A grouping field is unavailable.");
    }

    result.group = window.groupBy.map((field) => anchorFields[field]!);
  }

  const unique = new Map<string, NormalizedOnchainEvent>();

  for (const value of [...historyInput, anchor]) {
    const event = NormalizedOnchainEventSchema.parse(value);
    const previous = unique.get(event.id);

    if (previous && !sameNormalizedEvidence(previous, event)) {
      return stop("INSUFFICIENT_DATA", "Conflicting canonical event evidence.");
    }

    unique.set(event.id, event);
  }

  const eligible: { event: NormalizedOnchainEvent; fields: EventProjection }[] =
    [];
  let pending = false;

  for (const event of [...unique.values()].sort(order)) {
    if (
      !sourceMatches(event) ||
      order(event, anchor) > 0 ||
      event.timestamp > anchor.timestamp ||
      (window.kind === "event"
        ? event.id !== anchor.id
        : event.timestamp <= from)
    ) {
      continue;
    }

    const fields = projectEvent(event, program);

    if (
      window.kind === "rolling" &&
      window.groupBy.some((field) => fields[field] !== anchorFields[field])
    ) {
      continue;
    }

    const filtered = program.filter
      ? evaluatePredicate(program.filter, fields)
      : true;

    if (filtered === false) {
      continue;
    }

    if (filtered === "UNKNOWN") {
      return stop(
        "INSUFFICIENT_DATA",
        "A required window field is unavailable.",
      );
    }

    const prior = combine(
      "all",
      program.history
        .filter((req) => req.application === "eligible_events")
        .map((req) => historicalTruth(req, event, fields, evidence)),
    );

    if (prior === "UNKNOWN") {
      pending = true;
      continue;
    }

    if (prior) {
      eligible.push({ event, fields });
    }
  }

  if (pending) {
    return stop(
      "PENDING_CONTEXT",
      "Required historical evidence is unknown or retryable.",
    );
  }

  if (!eligible.some((row) => row.event.id === anchor.id)) {
    return result;
  }

  for (const metric of program.metrics) {
    result.metrics[metric.id] = aggregateMetric(
      metric,
      eligible.map((row) => row.fields),
    );
  }

  const decision = evaluateCondition(program.condition, result.metrics);

  if (decision === "UNKNOWN") {
    return stop(
      "INSUFFICIENT_DATA",
      "A metric has insufficient data or an undefined baseline.",
    );
  }

  if (!decision) {
    return result;
  }

  const candidateHistory = combine(
    "all",
    program.history
      .filter((req) => req.application === "candidate")
      .map((req) => historicalTruth(req, anchor, anchorFields, evidence)),
  );

  if (candidateHistory === "UNKNOWN") {
    return stop(
      "PENDING_CONTEXT",
      "Candidate investigation requires historical evidence.",
    );
  }

  if (!candidateHistory) {
    return result;
  }

  result.status = "MATCH";
  result.evidenceIds = eligible.map((row) => row.event.id);
  result.actorSet = [
    ...new Set(
      eligible.flatMap((row) => (row.event.actor ? [row.event.actor] : [])),
    ),
  ].sort();

  return result;
}
