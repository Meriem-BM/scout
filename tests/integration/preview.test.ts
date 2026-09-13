import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defaultSpec, POOLS, ROUTERS } from "@scout/domain";
import { previewMatches } from "@scout/integrations/preview";

import type { HistoricalSwap } from "@scout/integrations/graph";

const wallet = "0x1111111111111111111111111111111111111111";
const blockHash = `0x${"ab".repeat(32)}`;
const transactionHash = `0x${"cd".repeat(32)}`;
const timestamp = 1_780_000_000;
const swapAbi = parseAbi([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
const sample: HistoricalSwap = {
  id: "controlled-graph-event",
  timestamp: String(timestamp),
  amount0: "-999999999",
  amount1: "999999999",
  amountUSD: "999999999999",
  sender: ROUTERS[0],
  recipient: wallet,
  origin: wallet,
  logIndex: "20",
  pool: { id: POOLS[0].address },
  transaction: { id: transactionHash, blockNumber: "100" },
};

type Scenario =
  | "valid"
  | "reverted"
  | "missing-log"
  | "stale-price"
  | "wrong-chain"
  | "changed-origin";

function controlledRpc(scenario: Scenario) {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const request = z
      .object({
        id: z.number(),
        method: z.string(),
        params: z.array(z.unknown()).default([]),
      })
      .parse(JSON.parse(String(init?.body)));
    let result: unknown;

    if (request.method === "eth_chainId") {
      result = scenario === "wrong-chain" ? "0xa" : "0x1";
    } else if (request.method === "eth_getBlockByNumber") {
      result = {
        number: "0x64",
        hash: blockHash,
        timestamp: toHex(timestamp),
        transactions: [],
      };
    } else if (request.method === "eth_getTransactionByHash") {
      result = {
        hash: transactionHash,
        blockHash,
        blockNumber: "0x64",
        from: scenario === "changed-origin" ? ROUTERS[0] : wallet,
        to: ROUTERS[0],
        type: "0x2",
        gas: "0x5208",
        nonce: "0x0",
        value: "0x0",
        input: "0x",
        transactionIndex: "0x0",
        chainId: "0x1",
      };
    } else if (request.method === "eth_getTransactionReceipt") {
      result = {
        transactionHash,
        blockHash,
        blockNumber: "0x64",
        status: scenario === "reverted" ? "0x0" : "0x1",
        type: "0x2",
        gasUsed: "0x5208",
        cumulativeGasUsed: "0x5208",
        effectiveGasPrice: "0x1",
        transactionIndex: "0x0",
        from: wallet,
        to: ROUTERS[0],
        contractAddress: null,
        logs:
          scenario === "missing-log"
            ? []
            : [
                {
                  address: POOLS[0].address,
                  logIndex: "0x14",
                  transactionIndex: "0x0",
                  transactionHash,
                  blockHash,
                  blockNumber: "0x64",
                  removed: false,
                  topics: encodeEventTopics({
                    abi: swapAbi,
                    eventName: "Swap",
                    args: { sender: ROUTERS[0], recipient: wallet },
                  }),
                  data: encodeAbiParameters(
                    [
                      { type: "int256" },
                      { type: "int256" },
                      { type: "uint160" },
                      { type: "uint128" },
                      { type: "int24" },
                    ],
                    [-57600n * 10n ** 6n, 18n * 10n ** 18n, 1n, 1n, 0],
                  ),
                },
              ],
      };
    } else if (request.method === "eth_getCode") {
      result = "0x";
    } else if (request.method === "eth_call") {
      const call = z.object({ data: z.string() }).parse(request.params[0]);

      result =
        call.data === "0x313ce567"
          ? encodeAbiParameters([{ type: "uint8" }], [8])
          : encodeAbiParameters(
              [
                { type: "uint80" },
                { type: "int256" },
                { type: "uint256" },
                { type: "uint256" },
                { type: "uint80" },
              ],
              [
                1n,
                3200n * 10n ** 8n,
                BigInt(timestamp - 30),
                BigInt(timestamp - (scenario === "stale-price" ? 7200 : 30)),
                1n,
              ],
            );
    } else {
      throw new Error(`Unexpected controlled RPC method ${request.method}`);
    }

    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });

  vi.stubGlobal("fetch", fetcher);

  return fetcher;
}

afterEach(() => vi.unstubAllGlobals());
describe("bounded Graph preview with actual receipt and oracle decoding", () => {
  it("uses the pool receipt amount, not inflated subgraph USD or token amounts", async () => {
    controlledRpc("valid");

    const spec = defaultSpec();

    spec.conditions = [{ kind: "large_swap", usd: "50000" }];

    const result = await previewMatches(
      spec,
      [sample],
      "http://controlled.invalid",
    );

    expect(result.verifiedEvents).toBe(1);
    expect(result.unavailable).toBe(0);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.totalUsdMicros).toBe("57600000000");
  });
  it.each([
    "reverted",
    "missing-log",
    "stale-price",
    "changed-origin",
  ] as const)("excludes %s evidence from USD matches", async (scenario) => {
    controlledRpc(scenario);

    const result = await previewMatches(
      defaultSpec(),
      [sample],
      "http://controlled.invalid",
    );

    expect(result.verifiedEvents).toBe(0);
    expect(result.unavailable).toBe(1);
    expect(result.matches).toEqual([]);
  });
  it("rejects another network before reading historical events", async () => {
    const fetcher = controlledRpc("wrong-chain");

    await expect(
      previewMatches(defaultSpec(), [sample], "http://controlled.invalid"),
    ).rejects.toThrow("mainnet");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
