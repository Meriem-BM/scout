import { z } from "zod";

import { LIMITS } from "./limits";
import { units, usd } from "./money";
import { RuntimeRuleSchema } from "./runtime-rules";
import { poolByAddress, POOLS, tokenByAddress, TOKENS } from "./uniswap-scope";

export const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase());

export const Hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase());

export const Integer = z.string().regex(/^\d{1,78}$/);

export const UsdInput = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/);

const Window = z.number().int().min(60).max(LIMITS.windowSeconds);

export const ConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("aggregate"),
    rule: RuntimeRuleSchema.refine(
      (rule) =>
        rule.windowSeconds + (rule.baseline?.windowSeconds ?? 0) <= 7200 &&
        rule.groupBy.includes("pool") &&
        [
          ...rule.groupBy,
          ...rule.predicates.map((item) => item.field),
          ...(rule.aggregate.field ? [rule.aggregate.field] : []),
        ].every((field) =>
          [
            "pool",
            "participant",
            "transaction",
            "soldToken",
            "usdMicros",
          ].includes(field),
        ) &&
        (rule.aggregate.operation !== "sum" ||
          rule.aggregate.field === "usdMicros") &&
        rule.predicates.every(
          (item) => item.kind !== "numeric" || item.field === "usdMicros",
        ),
      "Swap rules require per-pool grouping, supported fields, USD sums, and at most two hours of retained history.",
    ),
    description: z.string().min(1).max(300),
  }),
  z.object({ kind: z.literal("large_swap"), usd: UsdInput }),
  z
    .object({
      kind: z.literal("repeated_selling"),
      minSwapUsd: UsdInput,
      count: z.number().int().min(2).max(100).nullable(),
      cumulativeUsd: UsdInput.nullable(),
      windowSeconds: Window,
    })
    .refine(
      (value) => value.count !== null || value.cumulativeUsd !== null,
      "Set a count or cumulative value.",
    ),
  z.object({
    kind: z.literal("pool_selling"),
    cumulativeUsd: UsdInput,
    windowSeconds: Window,
  }),
]);

// Runtime specifications are protocol-specific and versioned. Keep them behind
// this union so a new verified executor adds one member instead of changing the
// generic Watch, workflow, or database projection.
export const UniswapV3SwapWatchSpecSchema = z.object({
  schemaVersion: z.literal(1),
  chainId: z.literal(1),
  protocol: z.literal("uniswap_v3"),
  name: z.string().trim().min(3).max(72),
  pools: z
    .array(Address)
    .min(1)
    .max(POOLS.length)
    .refine(
      (addresses) =>
        new Set(addresses).size === addresses.length &&
        addresses.every((address) =>
          POOLS.some((pool) => pool.address === address),
        ),
      "Select a supported, unique pool.",
    ),
  sellToken: Address.refine(
    (address) => TOKENS.some((token) => token.address === address),
    "Choose WETH or USDC.",
  ),
  streamDirection: z.enum(["selected", "either"]).default("selected"),
  combine: z.enum(["all", "any"]),
  conditions: z.array(ConditionSchema).min(1).max(LIMITS.conditions),
  attribution: z.literal("transaction_initiator_eoa"),
  confirmation: z.literal("finalized"),
  valuation: z.literal("chainlink_at_block"),
  unvaluedPolicy: z.literal("exclude"),
  investigation: z
    .object({
      requireNoPriorUniswapSwaps: z.boolean().default(false),
    })
    .default({ requireNoPriorUniswapSwaps: false }),
  notifications: z.object({
    inbox: z.literal(true), // Legacy storage flag: incident history is always retained.
    telegram: z.boolean(),
    email: z.boolean().default(false),
    useDefaults: z.boolean().default(false),
  }),
  cooldownSeconds: z.number().int().min(300).max(3600).default(900),
});

export const WatchSpecSchema = z.discriminatedUnion("protocol", [
  UniswapV3SwapWatchSpecSchema,
]);

export type UniswapV3SwapWatchSpec = z.infer<
  typeof UniswapV3SwapWatchSpecSchema
>;

export type WatchSpec = z.infer<typeof WatchSpecSchema>;

export type Condition = z.infer<typeof ConditionSchema>;

export const DEFAULT_PROMPT =
  "Track Uniswap V3 ETH/USDC buys above $100K from wallets that haven't traded on Uniswap before.";

export const defaultSpec = (): WatchSpec => ({
  schemaVersion: 1,
  streamDirection: "selected",
  chainId: 1,
  protocol: "uniswap_v3",
  name: "Repeated WETH selling",
  pools: [POOLS[0].address],
  sellToken: TOKENS[0].address,
  combine: "all",
  conditions: [
    { kind: "large_swap", usd: "50000" },
    {
      kind: "repeated_selling",
      minSwapUsd: "50000",
      count: 3,
      cumulativeUsd: null,
      windowSeconds: 900,
    },
  ],
  attribution: "transaction_initiator_eoa",
  confirmation: "finalized",
  valuation: "chainlink_at_block",
  unvaluedPolicy: "exclude",
  investigation: { requireNoPriorUniswapSwaps: false },
  notifications: {
    inbox: true,
    telegram: true,
    email: false,
    useDefaults: true,
  },
  cooldownSeconds: 900,
});

export function describeCondition(condition: Condition): string {
  if (condition.kind === "aggregate") {
    return condition.description;
  }

  if (condition.kind === "large_swap") {
    return `A trade above ${usd(units(condition.usd, 6))}`;
  }

  if (condition.kind === "pool_selling") {
    return `Pool sales totaling more than ${usd(units(condition.cumulativeUsd, 6))} in ${condition.windowSeconds / 60} minutes`;
  }

  const thresholds = [
    condition.count !== null
      ? `${condition.count}+ distinct transactions`
      : null,
    condition.cumulativeUsd !== null
      ? `more than ${usd(units(condition.cumulativeUsd, 6))}`
      : null,
  ]
    .filter(Boolean)
    .join(" or ");

  return `${thresholds} from the same initiator in ${condition.windowSeconds / 60} minutes, each above ${usd(units(condition.minSwapUsd, 6))}`;
}

export function describeSpec(spec: WatchSpec): string {
  return `${spec.streamDirection === "either" ? "Both swap directions" : `${tokenByAddress(spec.sellToken).symbol} selling`} · ${spec.conditions.map(describeCondition).join(spec.combine === "all" ? "; AND " : "; OR ")}`;
}

export function scopeLabel(spec: WatchSpec): string {
  return `Ethereum · Uniswap v3 · ${spec.pools.map((address) => poolByAddress(address).feeLabel).join(" + ")} WETH / USDC`;
}

export const maxWindow = (spec: WatchSpec) =>
  Math.max(
    60,
    ...spec.conditions.map((condition) =>
      condition.kind === "aggregate"
        ? condition.rule.windowSeconds +
          (condition.rule.baseline?.windowSeconds ?? 0)
        : condition.kind === "large_swap"
          ? 0
          : condition.windowSeconds,
    ),
  );
