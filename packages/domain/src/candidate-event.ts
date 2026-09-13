import { z } from "zod";

import { Address, Hash, Integer } from "./spec";

export const CandidateEventSchema = z.object({
  id: z.string(),
  chainId: z.number().int().positive(),
  block: z.object({ number: Integer, hash: Hash, timestamp: z.number().int() }),
  transaction: z.object({ hash: Hash, initiator: Address }),
  eventIndex: z.number().int().nonnegative(),
  actor: z.object({
    address: Address,
    role: z.enum(["transaction_initiator", "sender"]),
  }),
  subject: z.object({ address: Address, kind: z.enum(["pool", "token"]) }),
  eventType: z.enum(["swap", "transfer"]),
  protocol: z.enum(["uniswap_v3", "erc20"]),
  assets: z.array(
    z.object({
      address: Address,
      amount: Integer,
      decimals: z.number().int().min(0).max(36),
    }),
  ),
  value: z
    .object({
      usdMicros: Integer,
      source: z.enum(["chainlink", "nominal_usdc"]),
    })
    .nullable(),
  metadata: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("transfer"), from: Address, to: Address }),
    z.object({
      kind: z.literal("swap"),
      soldToken: Address,
      amount0: z.string(),
      amount1: z.string(),
    }),
  ]),
  finality: z.literal("finalized"),
  source: z.literal("substreams"),
});

export type CandidateEvent = z.infer<typeof CandidateEventSchema>;

export function candidateIdentity(
  event: Pick<
    CandidateEvent,
    "chainId" | "block" | "transaction" | "eventIndex"
  >,
) {
  return `${event.chainId}:${event.block.hash}:${event.transaction.hash}:${event.eventIndex}`;
}
