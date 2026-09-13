import {
  CandidateEventSchema,
  type SwapEvent,
  tokenByAddress,
} from "@scout/domain";

export function swapCandidate(event: SwapEvent) {
  return CandidateEventSchema.parse({
    id: event.id,
    chainId: event.chainId,
    block: {
      number: event.blockNumber,
      hash: event.blockHash,
      timestamp: event.timestamp,
    },
    transaction: { hash: event.transactionHash, initiator: event.initiator },
    eventIndex: event.logIndex,
    actor: { address: event.initiator, role: "transaction_initiator" },
    subject: { address: event.pool, kind: "pool" },
    eventType: "swap",
    protocol: "uniswap_v3",
    assets: [
      {
        address: event.sellToken,
        amount: event.sellAmount,
        decimals: tokenByAddress(event.sellToken).decimals,
      },
    ],
    value: event.valuation
      ? { usdMicros: event.valuation.usdMicros, source: "chainlink" }
      : null,
    metadata: {
      kind: "swap",
      soldToken: event.sellToken,
      amount0: event.amount0,
      amount1: event.amount1,
    },
    finality: "finalized",
    source: "substreams",
  });
}
