import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { z } from "zod";

import { evaluate, poolByAddress } from "@scout/domain";

import { normalizeBlock } from "./substreams";

import type { HistoricalSwap } from "./graph";
import type { SwapEvent, WatchSpec } from "@scout/domain";

const hash = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value),
);
const swapAbi = parseAbi([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);

/** A small oracle-verified sample, not a complete backtest. Bounded RPC timeouts and concurrency. */
export async function previewMatches(
  spec: WatchSpec,
  swaps: HistoricalSwap[],
  rpcUrl: string,
) {
  const deadline = AbortSignal.timeout(30_000);
  const rpc = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, {
      timeout: 3500,
      retryCount: 0,
      fetchOptions: { signal: deadline },
    }),
  });

  if ((await rpc.getChainId()) !== 1) {
    throw new Error("Ethereum mainnet RPC required.");
  }

  const finalized = await rpc.getBlock({ blockTag: "finalized" });
  const selected = swaps.slice(0, 12);
  const events: SwapEvent[] = [];
  let unavailable = 0;

  for (let i = 0; i < selected.length; i += 4) {
    if (deadline.aborted) {
      unavailable += selected.length - i;
      break;
    }

    await Promise.all(
      selected.slice(i, i + 4).map(async (swap) => {
        try {
          if (BigInt(swap.transaction.blockNumber) > finalized.number) {
            unavailable++;

            return;
          }

          const transactionHash = hash.parse(swap.transaction.id);
          const [transaction, receipt] = await Promise.all([
            rpc.getTransaction({ hash: transactionHash }),
            rpc.getTransactionReceipt({ hash: transactionHash }),
          ]);

          if (
            !transaction.to ||
            !transaction.blockHash ||
            transaction.blockNumber !== BigInt(swap.transaction.blockNumber) ||
            transaction.from.toLowerCase() !== swap.origin ||
            receipt.status !== "success" ||
            receipt.blockHash !== transaction.blockHash
          ) {
            throw new Error("Historical transaction identity mismatch");
          }

          const pool = poolByAddress(swap.pool.id);
          const log = receipt.logs.find(
            (entry) =>
              entry.logIndex === Number(swap.logIndex) &&
              entry.address.toLowerCase() === pool.address,
          );

          if (!log || log.removed) {
            throw new Error("Historical pool log is missing or removed.");
          }

          const { args } = decodeEventLog({
            abi: swapAbi,
            data: log.data,
            topics: log.topics,
          });
          let degraded = false;
          const normalized = await normalizeBlock(
            {
              type: "block",
              cursor: "bounded-preview",
              number: swap.transaction.blockNumber,
              hash: transaction.blockHash,
              timestamp: Number(swap.timestamp),
              swaps: [
                {
                  pool: pool.address,
                  transactionHash: transaction.hash,
                  logIndex: Number(swap.logIndex),
                  initiator: transaction.from.toLowerCase(),
                  transactionTo: transaction.to.toLowerCase(),
                  poolCaller: args.sender.toLowerCase(),
                  recipient: args.recipient.toLowerCase(),
                  amount0: args.amount0.toString(),
                  amount1: args.amount1.toString(),
                },
              ],
            },
            rpc,
            () => {
              degraded = true;
            },
          );

          if (
            degraded ||
            normalized.some((event) => event.valuation === null)
          ) {
            unavailable++;
          }

          events.push(
            ...normalized.map((event) => ({
              ...event,
              source: "subgraph_preview" as const,
            })),
          );
        } catch {
          unavailable++;
        }
      }),
    );
  }

  events.sort(
    (a, b) =>
      Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
      a.logIndex - b.logIndex,
  );

  const matches = events.flatMap((event) => {
    const match = evaluate(spec, event, events);

    return match ? [match] : [];
  });

  return {
    verifiedEvents: events.filter((event) => event.valuation !== null).length,
    unavailable,
    matches: matches.slice(-8),
    sampleStart: events[0]?.timestamp ?? null,
    sampleEnd: events.at(-1)?.timestamp ?? null,
  };
}
