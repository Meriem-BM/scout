import { z } from "zod";

import { Address, Hash, Integer } from "./spec";

export const ValuationSchema = z.object({
  usdMicros: Integer,
  feed: Address,
  roundId: Integer,
  answer: Integer,
  decimals: z.number().int().min(0).max(36),
  updatedAt: z.number().int(),
  blockNumber: Integer,
  source: z.literal("chainlink"),
});

export const SwapEventSchema = z.object({
  id: z.string().max(250),
  chainId: z.literal(1),
  blockNumber: Integer,
  blockHash: Hash,
  transactionHash: Hash,
  logIndex: z.number().int().nonnegative(),
  timestamp: z.number().int(),
  pool: Address,
  initiator: Address,
  transactionTo: Address.nullable(),
  poolCaller: Address,
  recipient: Address,
  attributable: z.boolean(),
  attributionReason: z.string().max(250),
  amount0: z.string().regex(/^-?\d{1,78}$/),
  amount1: z.string().regex(/^-?\d{1,78}$/),
  sellToken: Address,
  sellAmount: Integer,
  valuation: ValuationSchema.nullable(),
  finality: z.enum(["provisional", "finalized", "retracted"]),
  source: z.enum(["substreams", "subgraph_preview"]),
});

export type SwapEvent = z.infer<typeof SwapEventSchema>;

export const MatchSchema = z.object({
  aggregation: z
    .object({
      ruleId: z.string(),
      status: z.enum(["MATCH", "NO_MATCH", "INSUFFICIENT_DATA"]),
      reason: z.string().nullable(),
      observed: z.string().nullable(),
      baseline: z.string().nullable(),
      evidenceIds: z.array(z.string()),
      baselineEvidenceIds: z.array(z.string()),
      baselineEvidence: z.array(SwapEventSchema).max(200).optional(),
      baselineEvidenceComplete: z.boolean().optional(),
    })
    .optional(),
  condition: z.string(),
  matched: z.boolean(),
  observedUsdMicros: Integer,
  observedCount: z.number().int(),
  evidenceIds: z.array(z.string()),
  rule: z.string(),
});

export type ConditionMatch = z.infer<typeof MatchSchema>;

export const DetectionSchema = z.object({
  pool: Address,
  initiator: Address.nullable(),
  timestamp: z.number().int(),
  totalUsdMicros: Integer,
  transactionCount: z.number().int(),
  evidenceIds: z.array(z.string()),
  matches: z.array(MatchSchema),
  severity: z.enum(["notice", "attention"]),
});

export type Detection = z.infer<typeof DetectionSchema>;

export const eventId = (
  event: Pick<
    SwapEvent,
    "chainId" | "blockHash" | "transactionHash" | "logIndex"
  >,
) =>
  `${event.chainId}:${event.blockHash}:${event.transactionHash}:${event.logIndex}`;
