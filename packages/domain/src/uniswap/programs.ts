import { z } from "zod";

import { type WatchProgram, WatchProgramSchema } from "../monitoring/program";
import { validateProgram } from "../monitoring/validation";
import { POOLS, TOKENS } from "../uniswap-scope";

const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase());

export const UniswapScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pool"), address: Address }),
  z.strictObject({
    kind: z.literal("fee_tier"),
    fee: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal("all_matching") }),
]);

export type UniswapScope = z.infer<typeof UniswapScopeSchema>;

/** This catalog is verified but deliberately NOT a complete factory index. */
export function resolveUniswapScope(input: UniswapScope) {
  const requested = UniswapScopeSchema.parse(input);
  const pools =
    requested.kind === "pool"
      ? POOLS.filter((p) => p.address === requested.address)
      : requested.kind === "fee_tier"
        ? POOLS.filter((p) => p.fee === requested.fee)
        : [];

  return {
    version: "v3" as const,
    chainId: 1,
    pair: [TOKENS[0].address, TOKENS[1].address],
    requested,
    status: pools.length
      ? ("RESOLVED" as const)
      : ("NEEDS_DATA_RESOLUTION" as const),
    contracts: pools.map((p) => p.address),
    provenance: "SCOUT_VERIFIED_POOL_CATALOG" as const,
    completeForRequestedScope: pools.length > 0,
    reason:
      requested.kind === "all_matching"
        ? "Complete factory discovery and verification across all fee tiers is required. The two installed pools are not the whole pair market."
        : pools.length
          ? "Explicit pool/fee scope matches the installed Ethereum V3 catalog."
          : "This pool or fee tier needs authoritative factory resolution and acquisition verification.",
  };
}

export const UniswapMonitoringRequestSchema = z.strictObject({
  version: z.literal("v3"),
  activity: z.enum([
    "swap",
    "liquidity_addition",
    "liquidity_removal",
    "pool_creation",
  ]),
  scope: UniswapScopeSchema,
  direction: z.enum(["buy", "sell"]),
  subjectAsset: Address,
  valueOperator: z.enum(["gt", "gte"]),
  minimumValueMicros: z
    .string()
    .regex(/^\d{1,78}$/)
    .nullable(),
  distinctActors: z.number().int().min(2).max(1000).nullable(),
  windowSeconds: z.number().int().min(1).max(86400).nullable(),
  priorProtocolActivity: z.enum(["none", "not_required"]),
});

export type UniswapMonitoringRequest = z.infer<
  typeof UniswapMonitoringRequestSchema
>;

/** Compile data-specific vocabulary into existing primitives. No event evaluation,
 * threshold decision or custom detector belongs in this module. */
export function compileUniswapProgram(input: UniswapMonitoringRequest) {
  const request = UniswapMonitoringRequestSchema.parse(input);
  const scope = resolveUniswapScope(request.scope);
  const missing: string[] = [];

  if (request.activity !== "swap") {
    missing.push(
      `Verified ${request.activity} acquisition, normalization and reference acceptance are not installed.`,
    );
  }

  if (scope.status !== "RESOLVED") {
    missing.push(scope.reason);
  }

  if (!TOKENS.some((t) => t.address === request.subjectAsset)) {
    missing.push(
      "The subject token is outside the independently valued pair catalog.",
    );
  }

  if ((request.distinctActors === null) !== (request.windowSeconds === null)) {
    missing.push(
      "Actor aggregation requires both an explicit count and a window.",
    );
  }

  if (request.minimumValueMicros === null && request.distinctActors === null) {
    missing.push(
      "A deterministic amount or actor-count condition is required.",
    );
  }

  if (missing.length) {
    return { status: "UNAVAILABLE" as const, scope, program: null, missing };
  }

  const metrics: WatchProgram["metrics"] = [];
  const terms: Array<Extract<WatchProgram["condition"], { kind: "metric" }>> =
    [];

  if (request.minimumValueMicros !== null) {
    metrics.push({ id: "value", operation: "sum", field: "valueMicros" });
    terms.push({
      kind: "metric",
      metric: "value",
      operator: request.valueOperator,
      value: request.minimumValueMicros,
    });
  }

  if (request.distinctActors !== null) {
    metrics.push({ id: "actors", operation: "unique_count", field: "actor" });
    terms.push({
      kind: "metric",
      metric: "actors",
      operator: "gte",
      value: String(request.distinctActors),
    });
  }

  const program = WatchProgramSchema.parse({
    version: 1,
    source: {
      chainId: 1,
      eventType: "swap",
      protocol: "uniswap_v3",
      contracts: scope.contracts,
    },
    asset: request.subjectAsset,
    filter: {
      kind: "text",
      field: "direction",
      operator: "eq",
      values: [request.direction],
    },
    window: request.windowSeconds
      ? { kind: "rolling", seconds: request.windowSeconds, groupBy: ["asset"] }
      : { kind: "event" },
    metrics,
    condition: terms.length === 1 ? terms[0] : { kind: "all", terms },
    history:
      request.priorProtocolActivity === "none"
        ? [
            {
              id: "prior_protocol",
              kind: "prior_activity",
              subject: "actor",
              protocol: "uniswap_v3",
              before: "current_transaction",
              expected: "none",
              application: request.windowSeconds
                ? "eligible_events"
                : "candidate",
            },
          ]
        : [],
    decision: "alert_on_match",
    delivery: { channels: ["inbox"], useDefaults: true },
  });
  const validation = validateProgram(program);

  return {
    status: "PROGRAM_COMPILED" as const,
    scope,
    program,
    validation,
    missing,
  };
}

/** Examples, never a separate natural-language matching/creation path. */
export function uniswapReferencePrograms(scope: UniswapScope) {
  const base: UniswapMonitoringRequest = {
    version: "v3",
    activity: "swap",
    scope,
    direction: "buy",
    subjectAsset: TOKENS[0].address,
    valueOperator: "gt",
    minimumValueMicros: "100000000000",
    distinctActors: null,
    windowSeconds: null,
    priorProtocolActivity: "not_required",
  };

  return {
    buys: compileUniswapProgram(base),
    firstTimeBuys: compileUniswapProgram({
      ...base,
      priorProtocolActivity: "none",
    }),
    liquidityExits: compileUniswapProgram({
      ...base,
      activity: "liquidity_removal",
      minimumValueMicros: "500000000000",
    }),
    distinctSellers: compileUniswapProgram({
      ...base,
      direction: "sell",
      minimumValueMicros: null,
      distinctActors: 3,
      windowSeconds: 900,
    }),
    firstTimeCombinedBuys: compileUniswapProgram({
      ...base,
      minimumValueMicros: "500000000000",
      valueOperator: "gte",
      distinctActors: 3,
      windowSeconds: 900,
      priorProtocolActivity: "none",
    }),
  };
}
