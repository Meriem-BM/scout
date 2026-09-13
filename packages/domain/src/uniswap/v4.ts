import { z } from "zod";

import { WatchProgramSchema } from "../monitoring/program";

import type { WatchIntentSpec } from "../workflow";

// Ethereum PoolManager from Uniswap's deployment registry and the inspected package.
export const V4_POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";

export const V4_PACKAGE = "uniswap-v4-substreams@v0.1.1";

export const V4_PACKAGE_URL =
  "https://spkg.io/v1/packages/uniswap-v4-substreams/v0.1.1";

export const V4_INITIAL_BLOCK = 21688329n;

export const V4_CAPABILITIES = {
  UNISWAP_V4_LIQUIDITY_CHANGE: "AVAILABLE",
  UNISWAP_V4_LIQUIDITY_VALUE: "UNSUPPORTED",
} as const;

export const V4LiquidityRequestSchema = z.strictObject({
  version: z.literal("v4"),
  chainId: z.literal(1),
  change: z.enum(["increase", "decrease"]),
  poolId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((v) => v.toLowerCase())
    .nullable(),
  transactionInitiator: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((v) => v.toLowerCase())
    .nullable(),
  minimumUsd: z.string().regex(/^\d+$/).nullable(),
});

export function compileV4LiquidityProgram(
  input: z.input<typeof V4LiquidityRequestSchema>,
) {
  const request = V4LiquidityRequestSchema.parse(input);

  if (request.minimumUsd !== null) {
    return {
      status: "UNSUPPORTED" as const,
      missingCapability: "UNISWAP_V4_LIQUIDITY_VALUE",
      reason:
        "ModifyLiquidity supplies signed liquidity units, not withdrawn token amounts or USD value.",
    };
  }

  return {
    status: "COMPILED" as const,
    program: WatchProgramSchema.parse({
      version: 1,
      source: {
        chainId: 1,
        protocol: "uniswap_v4",
        eventType: "liquidity_change",
        contracts: [V4_POOL_MANAGER],
      },
      asset: null,
      filter: {
        kind: "all",
        terms: [
          {
            kind: "number",
            field: "metric",
            operator: request.change === "decrease" ? "lt" : "gt",
            value: "0",
          },
          // Resolved subject is withheld until Initialize evidence establishes the PoolKey.
          {
            kind: "text",
            field: "subject",
            operator: request.poolId ? "eq" : "ne",
            values: [request.poolId ?? ""],
          },
          ...(request.transactionInitiator
            ? [
                {
                  kind: "text",
                  field: "actor",
                  operator: "eq",
                  values: [request.transactionInitiator],
                },
              ]
            : []),
        ],
      },
      window: { kind: "event" },
      metrics: [{ id: "events", operation: "count", field: null }],
      condition: {
        kind: "metric",
        metric: "events",
        operator: "gte",
        value: "1",
      },
      history: [],
      decision: "alert_on_match",
      delivery: { channels: ["inbox"], useDefaults: true },
    }),
  };
}

export const V4_LIQUIDITY_EXECUTOR = "uniswap-v4-liquidity-v1";

export function isV4LiquidityIntent(intent: WatchIntentSpec) {
  return (
    intent.subject.chain?.value === "ethereum" &&
    ["uniswap", "uniswap_v4", "uniswap-v4", "uniswap v4"].includes(
      intent.subject.protocol?.value.toLowerCase() ?? "",
    ) &&
    intent.subject.protocolVersion?.value.toLowerCase() === "v4" &&
    ["liquidity_removal", "liquidity_addition"].includes(
      intent.activity.type.value,
    )
  );
}

export function compileV4Intent(intent: WatchIntentSpec) {
  if (!isV4LiquidityIntent(intent)) {
    throw new Error(
      "Explicit Ethereum Uniswap V4 liquidity scope is required.",
    );
  }

  if (intent.filters.length) {
    throw new Error(
      "UNISWAP_V4_LIQUIDITY_VALUE is unsupported. Only signed liquidity-change monitoring without amount/value thresholds is available.",
    );
  }

  if (
    (intent.activity.direction &&
      intent.activity.direction.value !== "either") ||
    intent.subject.tokens.length ||
    intent.subject.wallets.length > 1 ||
    (intent.subject.wallets.length === 1 && !intent.subject.actorRole) ||
    intent.subject.contracts.length > 1 ||
    intent.investigationRequirements.length ||
    intent.investigation.length ||
    intent.temporal.mode.value !== "continuous" ||
    intent.temporal.evaluationWindowSeconds ||
    intent.temporal.comparisonWindowSeconds
  ) {
    throw new Error(
      "Additional scope requires clarification: this adapter supports pool-scoped liquidity changes; actor ownership and token valuation are not established.",
    );
  }

  const result = compileV4LiquidityProgram({
    version: "v4",
    chainId: 1,
    change:
      intent.activity.type.value === "liquidity_removal"
        ? "decrease"
        : "increase",
    poolId: intent.subject.contracts[0]?.value ?? null,
    transactionInitiator:
      intent.subject.actorRole?.value === "transaction_initiator"
        ? (intent.subject.wallets[0]?.value ?? null)
        : null,
    minimumUsd: null,
  });

  if (result.status !== "COMPILED") {
    throw new Error(result.reason);
  }

  if (
    intent.subject.actorRole?.value === "contract_caller" &&
    intent.subject.wallets.length
  ) {
    const caller = z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .parse(intent.subject.wallets[0]!.value)
      .toLowerCase();

    result.program.filter = {
      kind: "all",
      terms: [
        result.program.filter!,
        { kind: "text", field: "sender", operator: "eq", values: [caller] },
      ],
    };
  }

  const channels = intent.delivery.map((item) => item.value);

  result.program.delivery = {
    channels: ["inbox", ...channels],
    useDefaults: channels.length === 0,
  };

  return {
    schemaVersion: 1 as const,
    protocol: "program" as const,
    name: `Uniswap V4 liquidity ${intent.activity.type.value === "liquidity_removal" ? "decreases" : "increases"}`,
    program: result.program,
    notifications: {
      inbox: true as const,
      telegram: channels.includes("telegram"),
      email: channels.includes("email"),
      useDefaults: channels.length === 0,
    },
  };
}

export const V4_PACKAGE_SHA =
  "d9e4f57698f153c8782adb7e03c266216143f9f595d37c812c169934b7b44c34";
