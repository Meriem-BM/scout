import { createPublicClient, decodeEventLog, http, parseAbiItem } from "viem";
import { z } from "zod";

import {
  BASE_USDC,
  type CandidateEvent,
  CandidateEventSchema,
  candidateIdentity,
} from "@scout/domain";

import { verifyBlockIdentity } from "./substreams";

import type { Ethereum } from "./ethereum";

export const transferAbi = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export function baseRpc(url: string) {
  return createPublicClient({
    transport: http(url, { timeout: 15000, retryCount: 2 }),
  });
}

const hexBytes = (value: string): `0x${string}` =>
  value.startsWith("0x")
    ? (value as `0x${string}`)
    : `0x${Buffer.from(value, "base64").toString("hex")}`;
const EventOutput = z.object({
  events: z
    .array(
      z.object({
        txHash: z.string(),
        log: z.object({
          address: z.string(),
          topics: z.array(z.string()),
          data: z.string().default(""),
          blockIndex: z.number().int().default(0),
        }),
      }),
    )
    .default([]),
});

export async function normalizeTransfers(
  block: { number: string; hash: string; timestamp: number; output: unknown },
  rpc: Pick<
    ReturnType<typeof baseRpc>,
    "getBlock" | "getTransactionReceipt" | "getBlockReceipts"
  >,
): Promise<CandidateEvent[]> {
  await verifyBlockIdentity(block, rpc);

  const parsed = EventOutput.parse(block.output);
  const receipts = new Map<
    string,
    Awaited<ReturnType<Ethereum["getTransactionReceipt"]>>
  >();

  // One receipt request per block avoids a per-transfer RPC fan-out on dense Base blocks.
  if (parsed.events.length) {
    for (const receipt of await rpc.getBlockReceipts({
      blockNumber: BigInt(block.number),
    })) {
      receipts.set(receipt.transactionHash, receipt);
    }
  }

  const result: CandidateEvent[] = [];

  for (const item of parsed.events) {
    const transactionHash = (
      item.txHash.startsWith("0x") ? item.txHash : `0x${item.txHash}`
    ) as `0x${string}`;
    const address = hexBytes(item.log.address).toLowerCase();

    if (address !== BASE_USDC) {
      throw new Error("Parameterized stream emitted the wrong token");
    }

    let receipt = receipts.get(transactionHash);

    if (!receipt) {
      receipt = await rpc.getTransactionReceipt({ hash: transactionHash });
      receipts.set(transactionHash, receipt);
    }

    if (
      receipt.blockHash.toLowerCase() !== block.hash.toLowerCase() ||
      receipt.status !== "success"
    ) {
      throw new Error("Transfer receipt is not canonical successful evidence");
    }

    const actual = receipt.logs.find(
      (log) => log.logIndex === item.log.blockIndex,
    );
    const topics = item.log.topics.map(hexBytes);

    if (
      !actual ||
      actual.address.toLowerCase() !== address ||
      actual.data.toLowerCase() !== hexBytes(item.log.data).toLowerCase() ||
      JSON.stringify(actual.topics.map((x) => x.toLowerCase())) !==
        JSON.stringify(topics.map((x) => x.toLowerCase()))
    ) {
      throw new Error("Substreams Transfer differs from independent receipt");
    }

    const { args } = decodeEventLog({
      abi: [transferAbi],
      topics: actual.topics,
      data: actual.data,
      strict: true,
    });
    const event = CandidateEventSchema.parse({
      id: "",
      chainId: 8453,
      block: {
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
      },
      transaction: { hash: transactionHash, initiator: receipt.from },
      eventIndex: actual.logIndex,
      actor: { address: args.from, role: "sender" },
      subject: { address, kind: "token" },
      eventType: "transfer",
      protocol: "erc20",
      assets: [{ address, amount: args.value.toString(), decimals: 6 }],
      value: { usdMicros: args.value.toString(), source: "nominal_usdc" },
      metadata: { kind: "transfer", from: args.from, to: args.to },
      finality: "finalized",
      source: "substreams",
    });

    event.id = candidateIdentity(event);
    result.push(event);
  }

  return result;
}
