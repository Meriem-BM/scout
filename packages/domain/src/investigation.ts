import { z } from "zod";

import { Address, Hash, Integer } from "./spec";

export const PriorActivitySchema = z.object({
  status: z.enum(["FOUND", "NONE_WITH_PROVEN_COVERAGE", "UNKNOWN"]),
  protocol: z.literal("uniswap_v3"),
  actor: Address,
  beforeTransaction: Hash,
  throughBlock: Integer,
  blockHash: Hash,
  deployment: z.string().nullable(),
  evidenceTransaction: Hash.nullable(),
  reason: z.string(),
  coverage: z
    .object({
      fromBlock: Integer,
      throughBlock: Integer,
      blockHash: Hash,
      complete: z.literal(true),
    })
    .optional(),
});

export type PriorActivity = z.infer<typeof PriorActivitySchema>;

export function investigationDecision(
  required: boolean,
  prior: PriorActivity | null | undefined,
) {
  if (!required) {
    return "ALERT" as const;
  }

  if (
    prior?.status === "FOUND" &&
    prior.evidenceTransaction &&
    prior.evidenceTransaction !== prior.beforeTransaction
  ) {
    return "SUPPRESS" as const;
  }

  if (
    prior?.status === "NONE_WITH_PROVEN_COVERAGE" &&
    prior.coverage?.complete &&
    prior.coverage.blockHash === prior.blockHash &&
    prior.coverage.throughBlock === prior.throughBlock &&
    BigInt(prior.coverage.fromBlock) <= BigInt(prior.throughBlock) &&
    !prior.evidenceTransaction
  ) {
    return "ALERT" as const;
  }

  return "PENDING" as const;
}
