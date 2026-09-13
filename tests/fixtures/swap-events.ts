import {
  defaultSpec,
  eventId,
  POOLS,
  TOKENS,
  units,
  valueUsd,
} from "@scout/domain";

import type { SwapEvent, WatchSpec } from "@scout/domain";

const FIXTURE_TIME = 1_788_534_600;

export function fixtureEvents(spec: WatchSpec = defaultSpec()): SwapEvent[] {
  const pool = spec.pools[0] ?? POOLS[0].address;
  const weth = spec.sellToken === TOKENS[0].address;

  return [18, 21, 26, 8].map((amount, index) => {
    const timestamp = FIXTURE_TIME - 600 + index * 180;
    const blockNumber = String(23_240_000 + index * 15);
    const raw = weth
      ? units(String(amount), 18).toString()
      : units(String(amount * 3_200), 6).toString();
    const event: SwapEvent = {
      id: "",
      chainId: 1,
      pool,
      blockNumber,
      blockHash: `0x${(index + 100).toString(16).padStart(64, "0")}`,
      transactionHash: `0x${(index + 500).toString(16).padStart(64, "0")}`,
      logIndex: 20 + index,
      timestamp,
      initiator: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
      transactionTo: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
      poolCaller: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
      recipient: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
      attributable: true,
      attributionReason:
        "Test fixture: transaction initiator is an EOA; economic ownership is unknown.",
      amount0: weth ? `-${amount * 3_200 * 1e6}` : raw,
      amount1: weth ? raw : `-${units(String(amount), 18)}`,
      sellToken: spec.sellToken,
      sellAmount: raw,
      valuation: {
        usdMicros: valueUsd(
          raw,
          weth ? 18 : 6,
          weth ? "320000000000" : "99980000",
          8,
        ),
        feed: weth ? TOKENS[0].feed : TOKENS[1].feed,
        roundId: "110680464442257320001",
        answer: weth ? "320000000000" : "99980000",
        decimals: 8,
        updatedAt: timestamp - 90,
        blockNumber,
        source: "chainlink",
      },
      finality: "finalized",
      source: "substreams",
    };

    event.id = eventId(event);

    return event;
  });
}
