import { z } from "zod";

import { type CandidateEvent, CandidateEventSchema } from "./candidate-event";
import { units } from "./money";
import {
  legacyProvenance,
  normalizeCandidate,
  transferProgram,
} from "./monitoring/compatibility";
import { WatchProgramSchema } from "./monitoring/program";
import { evaluateWatchProgram } from "./monitoring/runtime";
import { Address, Integer, UniswapV3SwapWatchSpecSchema } from "./spec";

import type { WatchIntentSpec } from "./workflow";

// Circle's canonical native USDC on Base; bridged USDbC is a different asset.
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export const BASE_USDC_EXECUTOR = "erc20-base-usdc-v1";

export const TRANSFER_SIGNATURE =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const Erc20WatchSpecSchema = z.object({
  schemaVersion: z.literal(1),
  protocol: z.literal("erc20"),
  chainId: z.literal(8453),
  name: z.string().min(3).max(72),
  token: Address.refine((value) => value === BASE_USDC),
  thresholdMicros: Integer,
  operator: z.enum(["gt", "gte"]),
  valuation: z.literal("nominal_usdc"),
  confirmation: z.literal("finalized"),
  notifications: UniswapV3SwapWatchSpecSchema.shape.notifications,
});

export const ProgramWatchSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protocol: z.literal("program"),
  name: z.string().min(3).max(72),
  program: WatchProgramSchema,
  notifications: UniswapV3SwapWatchSpecSchema.shape.notifications,
});

export type ProgramWatchSpec = z.infer<typeof ProgramWatchSpecSchema>;

export const ExecutableWatchSpecSchema = z.discriminatedUnion("protocol", [
  UniswapV3SwapWatchSpecSchema,
  Erc20WatchSpecSchema,
  ProgramWatchSpecSchema,
]);

export type Erc20WatchSpec = z.infer<typeof Erc20WatchSpecSchema>;

export type ExecutableWatchSpec = z.infer<typeof ExecutableWatchSpecSchema>;

export function isBaseUsdcIntent(intent: WatchIntentSpec) {
  return (
    intent.subject.chain?.value.toLowerCase() === "base" &&
    intent.activity.type.value === "transfer" &&
    (!intent.subject.protocol ||
      ["erc20", "erc-20"].includes(
        intent.subject.protocol.value.toLowerCase(),
      )) &&
    intent.subject.tokens.length === 1 &&
    ["usdc", BASE_USDC].includes(intent.subject.tokens[0]!.value.toLowerCase())
  );
}

export function compileErc20(intent: WatchIntentSpec): Erc20WatchSpec {
  if (
    !isBaseUsdcIntent(intent) ||
    intent.subject.wallets.length ||
    intent.activity.direction !== null ||
    intent.unresolved.some((field) => field.classification === "BLOCKING") ||
    intent.subject.contracts.some((x) => x.value.toLowerCase() !== BASE_USDC) ||
    intent.temporal.mode.value !== "continuous" ||
    intent.temporal.comparisonWindowSeconds ||
    intent.temporal.evaluationWindowSeconds ||
    intent.investigation.length ||
    intent.investigationRequirements.length
  ) {
    throw new Error(
      "ERC20 executor cannot preserve the additional requested scope or history requirement.",
    );
  }

  const filter = intent.filters[0];

  if (
    intent.filters.length !== 1 ||
    !filter ||
    !["transferusd", "amountusd"].includes(filter.field.toLowerCase()) ||
    !["gt", "gte"].includes(filter.operator) ||
    (filter.unit && filter.unit.toUpperCase() !== "USD")
  ) {
    throw new Error("A single explicit USDC transfer threshold is required.");
  }

  return Erc20WatchSpecSchema.parse({
    schemaVersion: 1,
    protocol: "erc20",
    chainId: 8453,
    name: `USDC transfers ${filter.operator === "gte" ? "≥" : ">"} $${filter.value}`,
    token: BASE_USDC,
    thresholdMicros: units(String(filter.value), 6).toString(),
    operator: filter.operator,
    valuation: "nominal_usdc",
    confirmation: "finalized",
    notifications: {
      inbox: true,
      telegram: intent.delivery.length
        ? intent.delivery.some((item) => item.value === "telegram")
        : true,
      email: intent.delivery.some((item) => item.value === "email"),
      useDefaults: intent.delivery.length === 0,
    },
  });
}

export function evaluateTransfer(spec: Erc20WatchSpec, input: CandidateEvent) {
  const event = CandidateEventSchema.parse(input);

  if (
    event.chainId !== spec.chainId ||
    event.protocol !== "erc20" ||
    event.eventType !== "transfer" ||
    event.subject.address !== spec.token ||
    event.metadata.kind !== "transfer" ||
    !event.value ||
    event.value.source !== spec.valuation
  ) {
    return null;
  }

  const evaluated = evaluateWatchProgram(
    transferProgram(spec),
    normalizeCandidate(event, legacyProvenance),
  );

  if (evaluated.status !== "MATCH") {
    return null;
  }

  return {
    candidateId: event.id,
    actor: event.actor,
    subject: event.subject,
    value: event.value,
    rule: { operator: spec.operator, thresholdMicros: spec.thresholdMicros },
    evidenceIds: [event.id],
  };
}
