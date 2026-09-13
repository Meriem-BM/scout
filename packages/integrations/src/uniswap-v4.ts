import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { z } from "zod";

import {
  normalizedEventIdentity,
  NormalizedOnchainEventSchema,
} from "@scout/domain";
import { V4_INITIAL_BLOCK, V4_POOL_MANAGER } from "@scout/domain";

import type { ethereum } from "./ethereum";
import type { NormalizedOnchainEvent } from "@scout/domain";

const hex = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^(0x)?[0-9a-fA-F]{${length}}$`))
    .transform(
      (v) => `0x${v.replace(/^0x/, "").toLowerCase()}` as `0x${string}`,
    );
const integer = z.string().regex(/^-?\d{1,78}$/);

export const ModifyLiquiditySchema = z.object({
  blockNumber: z.string().regex(/^\d+$/),
  blockTimestamp: z.string().regex(/^\d+$/),
  transactionHash: hex(64),
  logIndex: z.number().int().nonnegative().default(0),
  contract: hex(40).refine((v) => v === V4_POOL_MANAGER),
  eventName: z.literal("ModifyLiquidity"),
  poolId: hex(64),
  sender: hex(40),
  tickLower: integer.default("0"),
  tickUpper: integer.default("0"),
  liquidityDelta: integer.default("0"),
  salt: hex(64),
});

// https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol
export const v4Abi = parseAbi([
  "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
  "event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)",
]);

type Rpc = Pick<
  ReturnType<typeof ethereum>,
  "getBlock" | "getTransactionReceipt" | "getLogs" | "getStorageAt"
>;

export type V4PoolEvidence =
  | {
      status: "RESOLVED";
      poolId: `0x${string}`;
      currency0: `0x${string}`;
      currency1: `0x${string}`;
      fee: number;
      tickSpacing: number;
      hooks: `0x${string}`;
      blockNumber: string;
      blockHash: string;
      transactionHash: string;
      logIndex: number;
    }
  | { status: "UNKNOWN"; reason: string };

export async function resolveV4Pool(
  rpc: Rpc,
  poolId: `0x${string}`,
  throughBlock: bigint,
): Promise<V4PoolEvidence> {
  try {
    // StateLibrary fixes pools at slot 6. Slot0's low 160 bits are a nonzero
    // sqrt price after initialization. Use this only to locate the Initialize log.
    const slot = keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32,uint256"), [poolId, 6n]),
    );

    const initialized = async (blockNumber: bigint) => {
      const value = await rpc.getStorageAt({
        address: V4_POOL_MANAGER,
        slot,
        blockNumber,
      });

      if (!value) {
        throw new Error("Historical pool state unavailable");
      }

      return (BigInt(value) & ((1n << 160n) - 1n)) !== 0n;
    };

    if (throughBlock < V4_INITIAL_BLOCK || !(await initialized(throughBlock))) {
      return {
        status: "UNKNOWN",
        reason: "Pool initialization cannot be established at this block.",
      };
    }

    let low = V4_INITIAL_BLOCK;
    let high = throughBlock;

    for (let attempt = 0; low < high && attempt < 64; attempt++) {
      const mid = (low + high) / 2n;

      if (await initialized(mid)) {
        high = mid;
      } else {
        low = mid + 1n;
      }
    }

    if (low !== high) {
      return {
        status: "UNKNOWN",
        reason: "Pool history resolution exceeded its bounded search.",
      };
    }

    const logs = await rpc.getLogs({
      address: V4_POOL_MANAGER,
      event: v4Abi[0],
      args: { id: poolId },
      fromBlock: low,
      toBlock: low,
      strict: true,
    });

    if (logs.length !== 1) {
      return {
        status: "UNKNOWN",
        reason: "Unique canonical Initialize evidence was not returned.",
      };
    }

    const log = logs[0]!;
    const { currency0, currency1, fee, tickSpacing, hooks } = log.args;
    const hash = keccak256(
      encodeAbiParameters(
        parseAbiParameters("address,address,uint24,int24,address"),
        [currency0, currency1, fee, tickSpacing, hooks],
      ),
    );
    const block = await rpc.getBlock({ blockNumber: log.blockNumber });

    if (hash !== poolId || block.hash !== log.blockHash || log.removed) {
      return {
        status: "UNKNOWN",
        reason: "Initialize evidence failed canonical PoolKey verification.",
      };
    }

    return {
      status: "RESOLVED",
      poolId,
      currency0,
      currency1,
      fee,
      tickSpacing,
      hooks,
      blockNumber: log.blockNumber.toString(),
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    };
  } catch {
    return {
      status: "UNKNOWN",
      reason:
        "Initialize history is unavailable; retry with authoritative chain history.",
    };
  }
}

export async function normalizeV4Liquidity(
  input: unknown,
  rpc: Rpc,
  provenance: NormalizedOnchainEvent["provenance"],
  poolEvidence?: V4PoolEvidence,
): Promise<{ event: NormalizedOnchainEvent; pool: V4PoolEvidence }> {
  const raw = ModifyLiquiditySchema.parse(input);
  const [block, receipt, finalized] = await Promise.all([
    rpc.getBlock({ blockNumber: BigInt(raw.blockNumber) }),
    rpc.getTransactionReceipt({ hash: raw.transactionHash }),
    rpc.getBlock({ blockTag: "finalized" }),
  ]);

  if (
    block.number > finalized.number ||
    receipt.blockHash !== block.hash ||
    receipt.blockNumber !== block.number ||
    receipt.status !== "success" ||
    block.timestamp.toString() !== raw.blockTimestamp
  ) {
    throw new Error("V4 event is not verified finalized chain evidence");
  }

  // This package emits transaction-local log indexes. Canonical event identity
  // uses the block-wide index from the independently verified receipt.
  const log = receipt.logs[raw.logIndex];

  if (!log || log.removed || log.address.toLowerCase() !== V4_POOL_MANAGER) {
    throw new Error("V4 package event is missing from canonical receipt");
  }

  const decoded = decodeEventLog({
    abi: v4Abi,
    eventName: "ModifyLiquidity",
    data: log.data,
    topics: log.topics,
    strict: true,
  }).args;

  if (
    decoded.id.toLowerCase() !== raw.poolId ||
    decoded.sender.toLowerCase() !== raw.sender ||
    decoded.tickLower.toString() !== raw.tickLower ||
    decoded.tickUpper.toString() !== raw.tickUpper ||
    decoded.liquidityDelta.toString() !== raw.liquidityDelta ||
    decoded.salt.toLowerCase() !== raw.salt
  ) {
    throw new Error(
      "V4 package output disagrees with canonical ModifyLiquidity log",
    );
  }

  const pool =
    poolEvidence ?? (await resolveV4Pool(rpc, raw.poolId, block.number));

  if (
    pool.status === "RESOLVED" &&
    (pool.poolId !== raw.poolId || BigInt(pool.blockNumber) > block.number)
  ) {
    throw new Error("Pool evidence does not cover this event");
  }

  const event = {
    chainId: 1,
    blockNumber: raw.blockNumber,
    blockHash: block.hash,
    timestamp: Number(block.timestamp),
    transactionHash: raw.transactionHash,
    transactionIndex: receipt.transactionIndex,
    eventIndex: log.logIndex,
    actor: receipt.from.toLowerCase(),
    subject: pool.status === "RESOLVED" ? pool.poolId : null,
    contract: V4_POOL_MANAGER,
    protocol: "uniswap_v4",
    eventType: "liquidity_change",
    assets: [],
    attributes: {
      metric: raw.liquidityDelta,
      metricUnit: "liquidity_units",
      liquidityDelta: raw.liquidityDelta,
      poolId: raw.poolId,
      poolStatus: pool.status,
      sender: raw.sender,
      tickLower: raw.tickLower,
      tickUpper: raw.tickUpper,
      salt: raw.salt,
      actorSemantics: "transaction_initiator",
      valuationStatus: "UNSUPPORTED",
      ...(pool.status === "RESOLVED"
        ? {
            currency0: pool.currency0,
            currency1: pool.currency1,
            fee: String(pool.fee),
            tickSpacing: String(pool.tickSpacing),
            hooks: pool.hooks,
            initializeTransaction: pool.transactionHash,
            initializeBlock: pool.blockNumber,
          }
        : { poolUnknownReason: pool.reason }),
    },
    provenance,
    finalized: true as const,
  };

  return {
    event: NormalizedOnchainEventSchema.parse({
      ...event,
      id: normalizedEventIdentity(event),
    }),
    pool,
  };
}
