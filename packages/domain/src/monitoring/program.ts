import { z } from "zod";

const ProgramAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase());

const Identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/);

export const AtomicNumber = z.string().regex(/^-?\d{1,78}$/);

export const Comparison = z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]);

export const Field = z.enum([
  "actor",
  "subject",
  "contract",
  "protocol",
  "eventType",
  "transaction",
  "asset",
  "direction",
  "amount",
  "valueMicros",
  "valuationSource",
  "sender",
  "recipient",
  "metric",
  "participant",
]);

export type EventField = z.infer<typeof Field>;

/** Field types are owned by Scout, never declared by a model. */
export const NUMERIC_FIELDS: ReadonlySet<EventField> = new Set([
  "amount",
  "valueMicros",
  "metric",
]);

export const PredicateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      field: Field,
      operator: z.enum(["eq", "ne", "in"]),
      values: z.array(z.string().max(256)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("number"),
      field: Field,
      operator: Comparison,
      value: AtomicNumber,
    })
    .strict(),
  z.strictObject({
    kind: z.literal("all"),
    get terms() {
      return z.array(PredicateSchema).min(1).max(32);
    },
  }),
  z.strictObject({
    kind: z.literal("any"),
    get terms() {
      return z.array(PredicateSchema).min(1).max(32);
    },
  }),
  z.strictObject({
    kind: z.literal("not"),
    get term() {
      return PredicateSchema;
    },
  }),
]);

export type Predicate = z.infer<typeof PredicateSchema>;

export const HistoricalRequirementSchema = z
  .object({
    id: Identifier,
    kind: z.literal("prior_activity"),
    subject: z.enum(["actor", "sender", "recipient"]),
    protocol: Identifier,
    before: z.literal("current_transaction"),
    expected: z.enum(["none", "found"]),
    application: z.enum(["eligible_events", "candidate"]),
  })
  .strict();

export type HistoricalRequirement = z.infer<typeof HistoricalRequirementSchema>;

export const HistoricalEvidenceSchema = z
  .object({
    requirementId: Identifier,
    eventId: z.string(),
    subject: z.string(),
    protocol: Identifier,
    beforeTransaction: z.string(),
    status: z.enum([
      "FOUND",
      "NONE_WITH_PROVEN_COVERAGE",
      "UNKNOWN",
      "ERROR_RETRYABLE",
    ]),
    coverage: z
      .object({
        fromBlock: AtomicNumber,
        throughBlock: AtomicNumber,
        blockHash: z.string(),
        complete: z.boolean(),
      })
      .strict()
      .nullable(),
    evidenceIds: z.array(z.string()),
    provider: z.string(),
    reason: z.string().nullable(),
  })
  .strict();

export type HistoricalEvidence = z.infer<typeof HistoricalEvidenceSchema>;

export const MetricSchema = z
  .object({
    id: Identifier,
    operation: z.enum([
      "count",
      "sum",
      "average",
      "min",
      "max",
      "median",
      "unique_count",
      "absolute_delta",
      "percentage_delta",
    ]),
    field: Field.nullable(),
  })
  .strict()
  .refine(
    (x) => x.operation === "count" || x.field !== null,
    "This operation requires a field.",
  );

export type Metric = z.infer<typeof MetricSchema>;

export const ConditionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("metric"),
      metric: Identifier,
      operator: Comparison,
      value: AtomicNumber,
    })
    .strict(),
  z.strictObject({
    kind: z.literal("all"),
    get terms() {
      return z.array(ConditionSchema).min(1).max(32);
    },
  }),
  z.strictObject({
    kind: z.literal("any"),
    get terms() {
      return z.array(ConditionSchema).min(1).max(32);
    },
  }),
  z.strictObject({
    kind: z.literal("not"),
    get term() {
      return ConditionSchema;
    },
  }),
]);

export type ProgramCondition = z.infer<typeof ConditionSchema>;

export const WatchProgramSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        chainId: z.number().int().positive(),
        eventType: Identifier,
        protocol: Identifier.nullable(),
        contracts: z.array(ProgramAddress).max(100),
      })
      .strict(),
    // Exactly one asset projection per program prevents cross-asset amount/direction comparisons.
    asset: ProgramAddress.nullable(),
    filter: PredicateSchema.nullable(),
    window: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("event") }).strict(),
      z
        .object({
          kind: z.literal("rolling"),
          seconds: z.number().int().min(1).max(86400),
          groupBy: z.array(Field).max(4),
        })
        .strict(),
    ]),
    metrics: z.array(MetricSchema).min(1).max(16),
    condition: ConditionSchema,
    history: z.array(HistoricalRequirementSchema).max(8),
    decision: z.literal("alert_on_match"),
    delivery: z
      .object({
        channels: z.array(z.enum(["inbox", "telegram", "email"])).min(1),
        useDefaults: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((program, ctx) => {
    function invalid(message: string) {
      ctx.addIssue({ code: "custom", message });
    }

    function checkPredicate(p: Predicate, depth = 0) {
      if (depth > 12) {
        invalid("Predicate nesting exceeds compiler limit.");

        return;
      }

      if (p.kind === "all" || p.kind === "any") {
        p.terms.forEach((term) => checkPredicate(term, depth + 1));
      } else if (p.kind === "not") {
        checkPredicate(p.term, depth + 1);
      } else if ((p.kind === "number") !== NUMERIC_FIELDS.has(p.field)) {
        invalid(`Predicate type does not match field ${p.field}.`);
      } else if (
        p.kind === "text" &&
        p.operator !== "in" &&
        p.values.length !== 1
      ) {
        invalid("Text equality requires exactly one value.");
      }
    }

    if (program.filter) {
      checkPredicate(program.filter);
    }

    for (const metric of program.metrics) {
      if (metric.operation === "count" && metric.field !== null) {
        invalid("Count counts events and must not bind an ignored field.");
      }

      if (
        metric.operation !== "count" &&
        metric.operation !== "unique_count" &&
        (!metric.field || !NUMERIC_FIELDS.has(metric.field))
      ) {
        invalid(`Aggregation ${metric.operation} requires a numeric field.`);
      }
    }

    const ids = new Set(program.metrics.map((m) => m.id));

    if (ids.size !== program.metrics.length) {
      ctx.addIssue({
        code: "custom",
        message: "Metric identifiers must be unique.",
      });
    }

    if (
      new Set(program.history.map((h) => h.id)).size !== program.history.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Historical identifiers must be unique.",
      });
    }

    function check(c: ProgramCondition, depth: number) {
      if (depth > 12) {
        ctx.addIssue({
          code: "custom",
          message: "Condition nesting exceeds compiler limit.",
        });

        return;
      }

      if (c.kind === "metric") {
        if (!ids.has(c.metric)) {
          ctx.addIssue({
            code: "custom",
            message: `Unknown metric ${c.metric}.`,
          });
        }
      } else if (c.kind === "not") {
        check(c.term, depth + 1);
      } else {
        c.terms.forEach((t) => check(t, depth + 1));
      }
    }

    check(program.condition, 0);
  });

export type WatchProgram = z.infer<typeof WatchProgramSchema>;
