import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  createAuthInterceptor,
  createRegistry,
  createRequest,
  createSubstream,
  streamBlocks,
} from "@substreams/core";
import { z } from "zod";

import {
  Address,
  eventId,
  Hash,
  Integer,
  poolByAddress,
  SwapEventSchema,
  tokenByAddress,
  valueUsd,
} from "@scout/domain";

import { attributableInitiator, oracleValue } from "./ethereum";
import { assertServer, fetchJson, IntegrationError } from "./http";

import type { Ethereum } from "./ethereum";
import type { SwapEvent } from "@scout/domain";

export const RawSwapSchema = z.object({
  pool: Address,
  transactionHash: Hash,
  logIndex: z.number().int().default(0),
  initiator: Address,
  transactionTo: Address,
  poolCaller: Address,
  recipient: Address,
  amount0: z.string().regex(/^-?\d+$/),
  amount1: z.string().regex(/^-?\d+$/),
});

export type StreamBlock = {
  type: "block";
  cursor: string;
  number: string;
  hash: string;
  timestamp: number;
  swaps: z.infer<typeof RawSwapSchema>[];
};

export type StreamUndo = {
  type: "undo";
  cursor: string;
  number: string;
  hash: string;
};

export type StreamConfig = {
  outputModule?: string;
  network?: string;
  parameters?: Array<{ module: string; name: string; value: string }>;
  endpoint: string;
  apiKey?: string;
  token?: string;
  packageBytes: Uint8Array;
  startBlock: string;
  cursor?: string;
  stopBlock?: string;
  signal: AbortSignal;
};

export function substreamsProductionMode(stopBlock?: string) {
  return stopBlock === undefined;
}

async function issueAccessToken(apiKey?: string) {
  if (!apiKey) {
    throw new IntegrationError(
      "SUBSTREAMS_SETUP_REQUIRED",
      "A The Graph Substreams data-plane key is required on the monitoring worker.",
    );
  }

  try {
    return z.object({ token: z.string().min(1) }).parse(
      await fetchJson("https://auth.thegraph.market/v1/auth/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
      }),
    ).token;
  } catch (error) {
    if (
      error instanceof IntegrationError &&
      ["HTTP_400", "HTTP_401", "HTTP_403"].includes(error.code)
    ) {
      throw new IntegrationError(
        "SUBSTREAMS_AUTHENTICATION",
        "The Graph rejected the Substreams data-plane key. Create a current key in The Graph Market, set SUBSTREAMS_API_KEY on the monitoring worker, and retry this Watch.",
      );
    }

    throw error;
  }
}

export async function* consumeOutput(
  config: StreamConfig,
): AsyncGenerator<
  (Omit<StreamBlock, "swaps"> & { output: unknown }) | StreamUndo
> {
  assertServer();

  const token = config.token ?? (await issueAccessToken(config.apiKey));
  const pkg = createSubstream(config.packageBytes);

  if (config.network) {
    pkg.network = config.network;
  }

  for (const binding of config.parameters ?? []) {
    const selectedModule = pkg.modules?.modules.find(
      (item) => item.name === binding.module,
    );
    const input = selectedModule?.inputs.find(
      (item) => item.input.case === "params",
    );

    if (!input || input.input.case !== "params") {
      throw new Error("Parameter binding does not name a parameterized module");
    }

    input.input.value.value = binding.value;
  }

  const registry = createRegistry(pkg);
  const transport = createGrpcTransport({
    baseUrl: config.endpoint,
    interceptors: [createAuthInterceptor(token)],
    jsonOptions: { typeRegistry: registry },
    httpVersion: "2",
  });
  const request = createRequest({
    substreamPackage: pkg,
    outputModule: config.outputModule ?? "map_watch",
    // Production mode prepares work in large parallel segments. That is right
    // for the unbounded monitor, but it can turn a small verification range
    // into a much larger tier-two job and delay the first response. Bounded
    // verification uses developer mode so the requested blocks execute
    // directly and the stream closes at stopBlock.
    productionMode: substreamsProductionMode(config.stopBlock),
    finalBlocksOnly: true,
    startBlockNum: BigInt(config.startBlock),
    stopBlockNum: config.stopBlock ? BigInt(config.stopBlock) : 0n,
    startCursor: config.cursor,
  });
  let blocks = 0;

  try {
    for await (const response of streamBlocks(transport, request, {
      signal: config.signal,
    })) {
      const message = response.message;

      if (message.case === "fatalError") {
        throw new Error(`Substreams module failed: ${message.value.module}`);
      }

      if (message.case === "blockUndoSignal") {
        const ref = message.value.lastValidBlock;

        if (!ref) {
          throw new Error("Undo is missing a valid block.");
        }

        yield {
          type: "undo",
          cursor: message.value.lastValidCursor,
          number: ref.number.toString(),
          hash: ref.id.startsWith("0x") ? ref.id : `0x${ref.id}`,
        };
      }

      if (message.case === "blockScopedData") {
        const data = message.value;
        const clock = data.clock;

        if (!clock?.timestamp || !data.cursor) {
          throw new Error("Substreams omitted clock or cursor.");
        }

        const unpacked = data.output?.mapOutput?.unpack(registry);

        blocks++;
        yield {
          type: "block",
          cursor: data.cursor,
          number: clock.number.toString(),
          hash: clock.id.startsWith("0x") ? clock.id : `0x${clock.id}`,
          timestamp: Number(clock.timestamp.seconds),
          output: unpacked?.toJson() ?? {},
        };
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /concurrent stream limit|resource_exhausted/i.test(error.message)
    ) {
      throw new IntegrationError(
        "SUBSTREAMS_CAPACITY",
        "The provider has no free Substreams session. Scout will retry when capacity is available.",
        30,
      );
    }

    throw error;
  }

  if (blocks === 0 && !config.signal.aborted) {
    throw new Error(
      "Substreams ended without any blocks. Check data-plane authentication and range.",
    );
  }

  if (!config.stopBlock && !config.signal.aborted) {
    throw new Error("Substreams disconnected.");
  }
}

export async function* consume(
  config: StreamConfig,
): AsyncGenerator<StreamBlock | StreamUndo> {
  for await (const block of consumeOutput(config)) {
    if (block.type === "undo") {
      yield block;
    } else {
      yield {
        ...block,
        swaps: z
          .object({ swaps: z.array(RawSwapSchema).default([]) })
          .parse(block.output).swaps,
      };
    }
  }
}

export async function normalizeBlock(
  block: StreamBlock,
  rpc: Ethereum,
  onDegraded: (code: string) => void,
): Promise<SwapEvent[]> {
  await verifyBlockIdentity(block, rpc);

  const canonicalTransactions = new Map<
    string,
    Awaited<ReturnType<Ethereum["getTransaction"]>>
  >();
  const result: SwapEvent[] = [];
  const prices = new Map<string, SwapEvent["valuation"]>();
  const attributions = new Map<
    string,
    Awaited<ReturnType<typeof attributableInitiator>>
  >();

  for (const raw of block.swaps) {
    let transaction = canonicalTransactions.get(raw.transactionHash);

    if (!transaction) {
      transaction = await rpc.getTransaction({
        hash: raw.transactionHash as `0x${string}`,
      });
      canonicalTransactions.set(raw.transactionHash, transaction);
    }

    if (
      transaction.blockHash?.toLowerCase() !== block.hash.toLowerCase() ||
      transaction.from.toLowerCase() !== raw.initiator ||
      transaction.to?.toLowerCase() !== raw.transactionTo
    ) {
      throw new Error(
        "Substreams initiator/transaction disagrees with canonical RPC evidence.",
      );
    }

    const pool = poolByAddress(raw.pool);
    const a0 = BigInt(raw.amount0);
    const a1 = BigInt(raw.amount1);

    if (!((a0 > 0n && a1 < 0n) || (a1 > 0n && a0 < 0n))) {
      throw new Error("Unsupported swap direction semantics.");
    }

    const sold = a0 > 0n ? pool.token0 : pool.token1;
    const amount = (a0 > 0n ? a0 : a1).toString();
    const event: SwapEvent = {
      ...raw,
      id: "",
      chainId: 1,
      blockNumber: block.number,
      blockHash: block.hash,
      timestamp: block.timestamp,
      sellToken: sold.address,
      sellAmount: amount,
      attributable: false,
      attributionReason: "Attribution unavailable.",
      valuation: null,
      finality: "finalized",
      source: "substreams",
    };

    if (!prices.has(sold.address)) {
      try {
        prices.set(sold.address, await oracleValue(rpc, event));
      } catch {
        prices.set(sold.address, null);
        onDegraded("ORACLE_UNAVAILABLE");
      }
    }

    const price = prices.get(sold.address);

    if (price) {
      event.valuation = {
        ...price,
        usdMicros: valueUsd(
          amount,
          tokenByAddress(sold.address).decimals,
          price.answer,
          price.decimals,
        ),
      };
    }

    const attributionKey = `${raw.initiator}:${raw.transactionTo}`;

    if (!attributions.has(attributionKey)) {
      try {
        attributions.set(
          attributionKey,
          await attributableInitiator(
            rpc,
            raw.initiator,
            raw.transactionTo,
            block.number,
          ),
        );
      } catch {
        onDegraded("ATTRIBUTION_UNAVAILABLE");
      }
    }

    const attribution = attributions.get(attributionKey);

    if (attribution) {
      Object.assign(event, attribution);
    }

    event.id = eventId(event);
    result.push(SwapEventSchema.parse(event));
  }

  return result;
}

export async function verifyBlockIdentity(
  block: Pick<StreamBlock, "number" | "hash" | "timestamp">,
  rpc: Pick<Ethereum, "getBlock">,
) {
  Integer.parse(block.number);
  Hash.parse(block.hash);

  const canonical = await rpc.getBlock({ blockNumber: BigInt(block.number) });

  if (canonical.hash.toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error("Provider block identity disagrees with Ethereum RPC.");
  }

  if (
    Number(canonical.timestamp) !== block.timestamp ||
    canonical.number !== BigInt(block.number)
  ) {
    throw new Error("Provider block time disagrees with Ethereum RPC.");
  }
}
