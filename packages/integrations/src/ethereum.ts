import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

import {
  ENTRYPOINTS,
  FACTORY,
  poolByAddress,
  tokenByAddress,
  valueUsd,
} from "@scout/domain";

import { assertServer, IntegrationError } from "./http";

import type { SwapEvent } from "@scout/domain";

export const factoryAbi = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);

const poolAbi = parseAbi([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function factory() view returns(address)",
]);
const oracleAbi = parseAbi([
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

export function ethereum(rpcUrl: string) {
  assertServer();

  return createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 12_000, retryCount: 1 }),
  });
}

export type Ethereum = Pick<
  ReturnType<typeof ethereum>,
  | "getChainId"
  | "getBlock"
  | "getBytecode"
  | "readContract"
  | "getBlockNumber"
  | "getTransaction"
  | "getTransactionReceipt"
  | "call"
  | "estimateFeesPerGas"
  | "estimateGas"
  | "getBalance"
>;

function rpcFailure(error: unknown): never {
  const details = error instanceof Error ? error.message.toLowerCase() : "";

  if (
    details.includes("must be authenticated") ||
    details.includes("unauthorized") ||
    details.includes("forbidden") ||
    details.includes("invalid api key")
  ) {
    throw new IntegrationError(
      "RPC_AUTHENTICATION",
      "The Ethereum RPC rejected Scout's credentials. Update ETHEREUM_RPC_URL on the monitoring worker, then retry this Watch.",
    );
  }

  if (
    details.includes("rate limit") ||
    details.includes("too many requests") ||
    details.includes("status: 429")
  ) {
    throw new IntegrationError(
      "RPC_RATE_LIMIT",
      "The Ethereum RPC rate-limited Scout during verification. Configure a dedicated Ethereum RPC endpoint on the monitoring worker, then retry this Watch.",
      30,
    );
  }

  throw new IntegrationError(
    "RPC_UNAVAILABLE",
    "Scout could not validate Ethereum mainnet through the configured RPC. Check that ETHEREUM_RPC_URL supports finalized and historical calls, then retry this Watch.",
    10,
  );
}

export async function validatePools(client: Ethereum, addresses: string[]) {
  try {
    if ((await client.getChainId()) !== 1) {
      throw new IntegrationError(
        "RPC_WRONG_NETWORK",
        "The configured RPC is not Ethereum mainnet. Update ETHEREUM_RPC_URL, then retry this Watch.",
      );
    }

    const block = await client.getBlock({ blockTag: "finalized" });

    for (const address of addresses) {
      const pool = poolByAddress(address);
      const [registered, token0, token1, factory] = await Promise.all([
        client.readContract({
          address: getAddress(FACTORY),
          abi: factoryAbi,
          functionName: "getPool",
          args: [
            getAddress(pool.token0.address),
            getAddress(pool.token1.address),
            pool.fee,
          ],
          blockNumber: block.number,
        }),
        client.readContract({
          address: getAddress(pool.address),
          abi: poolAbi,
          functionName: "token0",
          blockNumber: block.number,
        }),
        client.readContract({
          address: getAddress(pool.address),
          abi: poolAbi,
          functionName: "token1",
          blockNumber: block.number,
        }),
        client.readContract({
          address: getAddress(pool.address),
          abi: poolAbi,
          functionName: "factory",
          blockNumber: block.number,
        }),
      ]);

      if (
        registered.toLowerCase() !== pool.address ||
        token0.toLowerCase() !== pool.token0.address ||
        token1.toLowerCase() !== pool.token1.address ||
        factory.toLowerCase() !== FACTORY
      ) {
        throw new IntegrationError(
          "POOL_VALIDATION",
          "The configured Uniswap pool did not match the verified Ethereum mainnet factory. Activation was stopped.",
        );
      }
    }

    return {
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      timestamp: Number(block.timestamp),
      factory: FACTORY,
      pools: addresses,
    };
  } catch (error) {
    if (error instanceof IntegrationError) {
      throw error;
    }

    return rpcFailure(error);
  }
}

export async function oracleValue(
  client: Ethereum,
  event: Pick<
    SwapEvent,
    "sellToken" | "sellAmount" | "blockNumber" | "timestamp"
  >,
): Promise<SwapEvent["valuation"]> {
  try {
    const token = tokenByAddress(event.sellToken);
    const blockNumber = BigInt(event.blockNumber);
    const [round, decimals] = await Promise.all([
      client.readContract({
        address: getAddress(token.feed),
        abi: oracleAbi,
        functionName: "latestRoundData",
        blockNumber,
      }),
      client.readContract({
        address: getAddress(token.feed),
        abi: oracleAbi,
        functionName: "decimals",
        blockNumber,
      }),
    ]);
    const [roundId, answer, , updatedAt, answeredInRound] = round;

    if (
      answer <= 0n ||
      updatedAt <= 0n ||
      answeredInRound < roundId ||
      Number(updatedAt) > event.timestamp ||
      event.timestamp - Number(updatedAt) > token.heartbeat
    ) {
      return null;
    }

    return {
      source: "chainlink",
      usdMicros: valueUsd(
        event.sellAmount,
        token.decimals,
        answer.toString(),
        decimals,
      ),
      feed: token.feed,
      roundId: roundId.toString(),
      answer: answer.toString(),
      decimals,
      updatedAt: Number(updatedAt),
      blockNumber: event.blockNumber,
    };
  } catch (error) {
    return rpcFailure(error);
  }
}

export async function attributableInitiator(
  client: Ethereum,
  address: string,
  transactionTo: string | null,
  blockNumber: string,
) {
  if (transactionTo && ENTRYPOINTS.includes(transactionTo.toLowerCase())) {
    return {
      attributable: false,
      attributionReason:
        "Account-abstraction entry point: the transaction initiator may be a bundler.",
    };
  }

  const code = await client.getBytecode({
    address: getAddress(address),
    blockNumber: BigInt(blockNumber),
  });

  if (code && code !== "0x") {
    return {
      attributable: false,
      attributionReason:
        "Contract or delegated initiator; economic seller attribution is unavailable.",
    };
  }

  return {
    attributable: true,
    attributionReason:
      "EOA transaction initiator. This identifies who submitted the transaction, not necessarily the owner of the funds.",
  };
}
