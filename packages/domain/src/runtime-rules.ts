import { z } from "zod";

/** Integer arithmetic and explicit coverage make these rules independent of a protocol decoder. */
const Atomic = z.string().regex(/^\d{1,78}$/);
const Key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
const NumericPredicate = z
  .object({
    kind: z.literal("numeric"),
    field: Key,
    operator: z.enum(["gt", "gte", "lt", "lte", "eq"]),
    value: Atomic,
  })
  .strict();
const FieldPredicate = z
  .object({
    kind: z.literal("field"),
    field: Key,
    values: z.array(z.string().max(250)).min(1).max(100),
  })
  .strict();

export const EventPredicateSchema = z.discriminatedUnion("kind", [
  NumericPredicate,
  FieldPredicate,
]);

const Aggregate = z
  .object({
    operation: z.enum(["sum", "count", "distinct"]),
    field: Key.nullable(),
  })
  .strict()
  .refine(
    (value) => value.operation === "count" || value.field !== null,
    "Sum and distinct require a field.",
  );
const Window = z.number().int().min(1).max(86400);

export const RuntimeRuleSchema = z
  .object({
    id: Key,
    predicates: z.array(EventPredicateSchema).max(20),
    groupBy: z.array(Key).max(4),
    aggregate: Aggregate,
    windowSeconds: Window,
    threshold: Atomic,
    operator: z.enum(["gt", "gte", "lt", "lte", "eq"]),
    baseline: z
      .object({
        windowSeconds: Window,
        multiplierMicros: Atomic.refine((value) => BigInt(value) > 0n),
        minimum: Atomic.refine((value) => BigInt(value) > 0n),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type RuntimeRule = z.infer<typeof RuntimeRuleSchema>;

export type RuntimeEvent = {
  id: string;
  chainId: number;
  blockNumber: string;
  index: number;
  timestamp: number;
  finalized: boolean;
  fields: Record<string, string | null>;
};

export type RuntimeCoverage = { from: number; through: number };

export type RuleEvaluation = {
  ruleId: string;
  status: "MATCH" | "NO_MATCH" | "INSUFFICIENT_DATA";
  reason: string | null;
  observed: string | null;
  baseline: string | null;
  evidenceIds: string[];
  baselineEvidenceIds: string[];
};

export function compareInteger(
  left: bigint,
  operator: RuntimeRule["operator"],
  right: bigint,
) {
  switch (operator) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "eq":
      return left === right;
  }
}

function aggregate(events: RuntimeEvent[], rule: RuntimeRule): bigint | null {
  const { operation, field } = rule.aggregate;

  if (operation === "count") {
    return BigInt(events.length);
  }

  const values = events.map((event) => (field ? event.fields[field] : null));

  if (values.some((value) => value === null || value === undefined)) {
    return null;
  }

  if (operation === "distinct") {
    return BigInt(new Set(values).size);
  }

  if (values.some((value) => !/^\d{1,78}$/.test(value!))) {
    return null;
  }

  return values.reduce<bigint>((sum, value) => sum + BigInt(value!), 0n);
}

/** Coverage is supplied by the durable stream, never inferred from the first event. */
export function evaluateRuntimeRule(
  ruleInput: RuntimeRule,
  anchor: RuntimeEvent,
  history: readonly RuntimeEvent[],
  coverage: RuntimeCoverage,
): RuleEvaluation {
  const rule = RuntimeRuleSchema.parse(ruleInput);
  const result: RuleEvaluation = {
    ruleId: rule.id,
    status: "NO_MATCH",
    reason: null,
    observed: null,
    baseline: null,
    evidenceIds: [],
    baselineEvidenceIds: [],
  };
  const insufficient = (reason: string): RuleEvaluation => ({
    ...result,
    status: "INSUFFICIENT_DATA",
    reason,
  });

  if (!anchor.finalized) {
    return result;
  }

  const currentFrom = anchor.timestamp - rule.windowSeconds;
  const baselineFrom = currentFrom - (rule.baseline?.windowSeconds ?? 0);

  if (
    !Number.isSafeInteger(coverage.from) ||
    !Number.isSafeInteger(coverage.through) ||
    coverage.from > baselineFrom ||
    coverage.through < anchor.timestamp
  ) {
    return insufficient(
      "The complete observation window has not been processed.",
    );
  }

  if (
    rule.groupBy.some(
      (field) =>
        anchor.fields[field] === null || anchor.fields[field] === undefined,
    )
  ) {
    return insufficient("A grouping field is missing.");
  }

  const unique = new Map<string, RuntimeEvent>();

  for (const event of [...history, anchor]) {
    if (
      !event.finalized ||
      event.chainId !== anchor.chainId ||
      event.timestamp <= baselineFrom ||
      event.timestamp > anchor.timestamp
    ) {
      continue;
    }

    if (
      BigInt(event.blockNumber) > BigInt(anchor.blockNumber) ||
      (BigInt(event.blockNumber) === BigInt(anchor.blockNumber) &&
        event.index > anchor.index)
    ) {
      continue;
    }

    if (
      rule.groupBy.some(
        (field) =>
          event.fields[field] === null || event.fields[field] === undefined,
      )
    ) {
      return insufficient("An event is missing a grouping field.");
    }

    if (
      rule.groupBy.some((field) => event.fields[field] !== anchor.fields[field])
    ) {
      continue;
    }

    const previous = unique.get(event.id);

    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
      return insufficient(
        "Conflicting versions of a canonical event were supplied.",
      );
    }

    unique.set(event.id, event);
  }

  const eligible: RuntimeEvent[] = [];

  for (const event of unique.values()) {
    let included = true;

    for (const predicate of rule.predicates) {
      const value = event.fields[predicate.field];

      if (value === null || value === undefined) {
        return insufficient(`Required field ${predicate.field} is missing.`);
      }

      if (predicate.kind === "field") {
        if (!predicate.values.includes(value)) {
          included = false;
        }
      } else {
        if (!/^\d{1,78}$/.test(value)) {
          return insufficient(
            `Required field ${predicate.field} is not an unsigned integer.`,
          );
        }

        if (
          !compareInteger(
            BigInt(value),
            predicate.operator,
            BigInt(predicate.value),
          )
        ) {
          included = false;
        }
      }
    }

    if (included) {
      eligible.push(event);
    }
  }

  // Do not rediscover a past match when the newly observed event does not qualify.
  if (!eligible.some((event) => event.id === anchor.id)) {
    return result;
  }

  const current = eligible.filter((event) => event.timestamp > currentFrom);
  const observed = aggregate(current, rule);

  if (observed === null) {
    return insufficient("An aggregation field is missing or invalid.");
  }

  result.observed = observed.toString();

  let matched = compareInteger(observed, rule.operator, BigInt(rule.threshold));

  if (rule.baseline) {
    const baselineEvents = eligible.filter(
      (event) => event.timestamp <= currentFrom,
    );
    const baseline = aggregate(baselineEvents, rule);

    if (baseline === null) {
      return insufficient(
        "The baseline contains an invalid aggregation field.",
      );
    }

    result.baseline = baseline.toString();

    if (baseline < BigInt(rule.baseline.minimum)) {
      return insufficient(
        "The baseline is below the required minimum; a volume ratio would not be meaningful.",
      );
    }

    // Compare rates when windows differ. No floating-point division or rounded ratios.
    matched &&=
      observed * BigInt(rule.baseline.windowSeconds) * 1_000_000n >
      baseline *
        BigInt(rule.windowSeconds) *
        BigInt(rule.baseline.multiplierMicros);
    result.baselineEvidenceIds = baselineEvents.map((event) => event.id);
  }

  result.status = matched ? "MATCH" : "NO_MATCH";
  result.evidenceIds = matched ? current.map((event) => event.id) : [];

  return result;
}
