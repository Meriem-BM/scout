import { describe, expect, it, vi } from "vitest";

import { defaultSpec, evaluate } from "@scout/domain";
import { normalizeBlock, RawSwapSchema } from "@scout/integrations/substreams";
import { swapCandidate } from "@scout/integrations/uniswap-candidate";

import { fixtureEvents } from "../fixtures/swap-events";

import type { Ethereum } from "@scout/integrations/ethereum";

vi.mock("@scout/integrations/ethereum", () => ({
  oracleValue: vi.fn(async () => ({
    answer: "320000000000",
    decimals: 8,
    feed: "0x" + "1".repeat(40),
    roundId: "1",
    updatedAt: 1788534000,
    blockNumber: "23240000",
    source: "chainlink",
    usdMicros: "200000000000",
  })),
  attributableInitiator: vi.fn(async () => ({
    attributable: true,
    attributionReason: "Controlled EOA check",
  })),
}));
describe("initiator across the ingestion boundary", () => {
  const spec = {
    ...defaultSpec(),
    conditions: [{ kind: "large_swap" as const, usd: "10000" }],
    investigation: { requireNoPriorUniswapSwaps: true },
  };
  const seed = fixtureEvents(spec)[0]!;
  const block = {
    type: "block" as const,
    cursor: "controlled",
    number: seed.blockNumber,
    hash: seed.blockHash,
    timestamp: seed.timestamp,
    swaps: [RawSwapSchema.parse(seed)],
  };
  const rpc = (from = seed.initiator) =>
    ({
      getBlock: vi.fn(async () => ({
        number: BigInt(seed.blockNumber),
        hash: seed.blockHash,
        timestamp: BigInt(seed.timestamp),
      })),
      getTransaction: vi.fn(async () => ({
        from,
        to: seed.transactionTo,
        blockHash: seed.blockHash,
      })),
    }) as unknown as Ethereum;

  it("preserves the RPC-checked actor through raw output, normalized event, candidate and deterministic detection", async () => {
    const [event] = await normalizeBlock(block, rpc(), () => {});

    expect(event!.initiator).toBe(seed.initiator);
    expect(swapCandidate(event!).actor.address).toBe(seed.initiator);
    expect(swapCandidate(event!).transaction.initiator).toBe(seed.initiator);
    expect(evaluate(spec, event!, [event!])?.initiator).toBe(seed.initiator);
  });
  it("rejects an actor that differs from canonical RPC before advancing the cursor", async () => {
    await expect(
      normalizeBlock(block, rpc("0x" + "2".repeat(40)), () => {}),
    ).rejects.toThrow("canonical RPC");
  });
});
