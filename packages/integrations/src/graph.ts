import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  Address,
  ContextSchema,
  decimal,
  FACTORY,
  Hash,
  LIMITS,
  POOLS,
  PriorActivitySchema,
  units,
} from "@scout/domain";

import { assertServer, fetchJson, IntegrationError } from "./http";

import type { Incident, PriorActivity } from "@scout/domain";

export const DEFAULT_SUBGRAPH_ID =
  "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

const Meta = z.object({
  deployment: z.string(),
  hasIndexingErrors: z.boolean(),
  block: z.object({
    number: z.number(),
    hash: z.string().nullable(),
    timestamp: z.number().nullable().optional(),
  }),
});
const GraphSwap = z.object({
  id: z.string(),
  timestamp: z.string(),
  amount0: z.string(),
  amount1: z.string(),
  amountUSD: z.string(),
  sender: Address,
  recipient: Address,
  origin: Address,
  logIndex: z.string(),
  pool: z.object({ id: Address }),
  transaction: z.object({ id: z.string(), blockNumber: z.string() }),
});

export type HistoricalSwap = z.infer<typeof GraphSwap>;

const QueryResult = z.object({
  _meta: Meta,
  pools: z.array(
    z.object({
      id: Address,
      feeTier: z.string(),
      token0: z.object({ id: Address, decimals: z.string() }),
      token1: z.object({ id: Address, decimals: z.string() }),
    }),
  ),
  swaps: z.array(GraphSwap),
});
const QUERY = `query ScoutHistory($pools:[String!]!,$from:BigInt!,$to:BigInt!,$first:Int!){
 _meta { deployment hasIndexingErrors block { number hash timestamp } }
 pools(where:{id_in:$pools}){id feeTier token0{id decimals} token1{id decimals}}
 swaps(first:$first,orderBy:timestamp,orderDirection:desc,where:{pool_in:$pools,timestamp_gte:$from,timestamp_lte:$to}){
 id timestamp amount0 amount1 amountUSD sender recipient origin logIndex pool{id} transaction{id blockNumber}
 }}`;
const PRIOR_QUERY = `query ScoutPriorActivity($origin:Bytes!,$before:BigInt!){
 _meta { deployment hasIndexingErrors block { number hash timestamp } }
 swaps(first:1,orderBy:timestamp,orderDirection:desc,where:{origin:$origin,timestamp_lt:$before}){transaction{id blockNumber} timestamp}
}`;

export class GraphAdapter {
  constructor(
    private readonly apiKey: string,
    public readonly subgraphId = DEFAULT_SUBGRAPH_ID,
  ) {
    assertServer();

    if (!/^[A-Za-z0-9]{20,100}$/.test(subgraphId)) {
      throw new Error("Invalid subgraph identity.");
    }
  }
  async history(
    pools: string[],
    from: number,
    to: number,
    first: number = LIMITS.previewSwaps,
  ) {
    if (
      pools.length < 1 ||
      pools.length > 2 ||
      pools.some(
        (address) => !POOLS.some((pool) => pool.address === address),
      ) ||
      to < from ||
      to - from > 86400 ||
      first > 250 ||
      first < 1 ||
      ![from, to, first].every(Number.isSafeInteger) ||
      from < 0
    ) {
      throw new Error("Historical query is outside Scout's budget.");
    }

    const response = await fetchJson(
      `https://gateway.thegraph.com/api/${encodeURIComponent(this.apiKey)}/subgraphs/id/${this.subgraphId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: QUERY,
          variables: { pools, from: String(from), to: String(to), first },
        }),
      },
    );
    const envelope = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      })
      .parse(response);

    if (envelope.errors?.length) {
      throw new IntegrationError(
        "GRAPH_QUERY",
        "Historical data is unavailable: the subgraph rejected the bounded query.",
      );
    }

    const data = QueryResult.parse(envelope.data);

    if (data._meta.hasIndexingErrors) {
      throw new IntegrationError(
        "GRAPH_INDEXING",
        "The subgraph reports indexing errors.",
      );
    }

    for (const address of pools) {
      const expected = POOLS.find((pool) => pool.address === address);
      const actual = data.pools.find((pool) => pool.id === address);

      if (
        !expected ||
        !actual ||
        actual.token0.id !== expected.token0.address ||
        actual.token1.id !== expected.token1.address ||
        actual.feeTier !== String(expected.fee) ||
        actual.token0.decimals !== String(expected.token0.decimals) ||
        actual.token1.decimals !== String(expected.token1.decimals)
      ) {
        throw new IntegrationError(
          "GRAPH_SCOPE",
          "Subgraph coverage does not match the selected Ethereum v3 pool.",
        );
      }
    }

    return {
      ...data,
      refreshedAt: new Date().toISOString(),
      from,
      to,
      partial: data.swaps.length === first,
      subgraphId: this.subgraphId,
    };
  }
  async context(incident: Incident) {
    const to = incident.detection.timestamp;
    const result = await this.history(
      [incident.detection.pool],
      to - 86400,
      to,
    );
    // Subgraph USD values are contextual estimates, never deterministic threshold inputs.
    const volume = result.swaps.reduce((sum, swap) => {
      const parts = swap.amountUSD.split(".");

      return (
        sum +
        units(
          `${parts[0] || "0"}.${(parts[1] ?? "").slice(0, 6).padEnd(6, "0")}`,
          6,
        )
      );
    }, 0n);
    const anchor = incident.evidence.find(
      (event) =>
        event.initiator === incident.detection.initiator &&
        event.timestamp === to,
    );
    const prior =
      incident.spec.investigation.requireNoPriorUniswapSwaps && anchor
        ? await this.checkPriorActivity(anchor)
        : undefined;

    return ContextSchema.parse({
      status: result.partial ? "partial" : "available",
      subgraphId: this.subgraphId,
      deployment: result._meta.deployment,
      blockNumber: result._meta.block.number,
      blockHash: result._meta.block.hash,
      refreshedAt: result.refreshedAt,
      from: result.from,
      to,
      sampledSwaps: result.swaps.length,
      volumeUsd: decimal(volume, 6),
      priorInitiatorTransactions:
        prior?.status === "FOUND"
          ? 1
          : prior?.status === "NONE_WITH_PROVEN_COVERAGE"
            ? 0
            : null,
      priorActivity: prior,
      priorActivityCoverage: prior?.reason,
      note: `${result.partial ? "Latest 250 swaps only; volume context is incomplete." : "Bounded 24-hour pool context."} Prior initiator activity is checked independently across the indexed Uniswap v3 subgraph. An initiator is not necessarily the ultimate asset owner.`,
    });
  }

  async checkPriorActivity(anchor: {
    initiator: string;
    transactionHash: string;
    blockNumber: string;
    blockHash: string;
    timestamp: number;
    logIndex: number;
  }): Promise<PriorActivity> {
    const result = (
      status: PriorActivity["status"],
      reason: string,
      deployment: string | null = null,
      evidenceTransaction: string | null = null,
    ) =>
      PriorActivitySchema.parse({
        status,
        reason,
        deployment,
        evidenceTransaction,
        protocol: "uniswap_v3",
        actor: anchor.initiator,
        beforeTransaction: anchor.transactionHash,
        throughBlock: anchor.blockNumber,
        blockHash: anchor.blockHash,
        ...(status === "NONE_WITH_PROVEN_COVERAGE"
          ? {
              coverage: {
                fromBlock: "12369621",
                throughBlock: anchor.blockNumber,
                blockHash: anchor.blockHash,
                complete: true,
              },
            }
          : {}),
      });

    try {
      const query = `query ScoutPriorAtBlock($origin:Bytes!,$hash:Bytes!,$time:BigInt!){
        _meta(block:{hash:$hash}) { deployment hasIndexingErrors block { number hash timestamp } }
        earlier:swaps(block:{hash:$hash},first:1,where:{origin:$origin,timestamp_lt:$time}){transaction{id} logIndex}
        same:swaps(block:{hash:$hash},first:1000,where:{origin:$origin,timestamp:$time}){transaction{id} logIndex}
      }`;
      const envelope = await fetchJson(
        `https://gateway.thegraph.com/api/${encodeURIComponent(this.apiKey)}/subgraphs/id/${this.subgraphId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query,
            variables: {
              origin: anchor.initiator,
              hash: anchor.blockHash,
              time: String(anchor.timestamp),
            },
          }),
        },
      );
      const shape = z
        .object({
          errors: z.array(z.unknown()).optional(),
          data: z
            .object({
              _meta: Meta,
              earlier: z.array(
                z.object({
                  transaction: z.object({ id: Hash }),
                  logIndex: z.string(),
                }),
              ),
              same: z.array(
                z.object({
                  transaction: z.object({ id: Hash }),
                  logIndex: z.string(),
                }),
              ),
            })
            .optional(),
        })
        .parse(envelope);
      const data = shape.data;

      if (
        shape.errors?.length ||
        !data ||
        data._meta.hasIndexingErrors ||
        data._meta.block.number !== Number(anchor.blockNumber) ||
        (data._meta.block.hash !== null &&
          data._meta.block.hash.toLowerCase() !==
            anchor.blockHash.toLowerCase())
      ) {
        return result(
          "UNKNOWN",
          `The Graph did not prove coverage of the candidate's canonical block (errors=${shape.errors?.length ?? 0}, indexed=${data?._meta.block.number ?? "missing"}, hash=${data?._meta.block.hash ?? "missing"}).`,
        );
      }

      const previous =
        data.earlier[0] ??
        data.same.find(
          (event) =>
            event.transaction.id !== anchor.transactionHash &&
            BigInt(event.logIndex) < BigInt(anchor.logIndex),
        );

      if (previous) {
        return result(
          "FOUND",
          "Earlier activity exists in indexed Uniswap V3 history, excluding the current transaction.",
          data._meta.deployment,
          previous.transaction.id,
        );
      }

      if (data.same.length === 1000) {
        return result(
          "UNKNOWN",
          "Same-block history exceeded the bounded query.",
          data._meta.deployment,
        );
      }

      await this.verifyHistoryManifest(data._meta.deployment);

      return result(
        "NONE_WITH_PROVEN_COVERAGE",
        "No earlier transaction in Uniswap V3: factory-origin manifest coverage and canonical candidate block verified; current transaction excluded.",
        data._meta.deployment,
      );
    } catch {
      return result(
        "UNKNOWN",
        "Required historical coverage is unavailable or could not be verified.",
      );
    }
  }

  private async verifyHistoryManifest(deployment: string) {
    if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(deployment)) {
      throw new Error("Unsupported deployment CID");
    }

    const response = await fetch(
      `https://api.thegraph.com/ipfs/api/v0/cat?arg=${deployment}`,
      { signal: AbortSignal.timeout(15_000) },
    );

    if (!response.ok) {
      throw new Error("Manifest unavailable");
    }

    const text = await response.text();

    if (text.length > 1_000_000) {
      throw new Error("Manifest exceeds budget");
    }

    const manifest = z
      .object({
        dataSources: z.array(
          z.object({
            network: z.string(),
            source: z.object({ address: Address, startBlock: z.number() }),
            mapping: z.object({
              eventHandlers: z.array(z.object({ event: z.string() })),
            }),
          }),
        ),
        templates: z.array(
          z.object({
            mapping: z.object({
              eventHandlers: z.array(z.object({ event: z.string() })),
            }),
          }),
        ),
      })
      .parse(parseYaml(text));
    const factory = manifest.dataSources.find(
      (source) =>
        source.network === "mainnet" &&
        source.source.address === FACTORY &&
        source.source.startBlock <= 12369621 &&
        source.mapping.eventHandlers.some((handler) =>
          handler.event.startsWith("PoolCreated("),
        ),
    );

    if (
      !factory ||
      !manifest.templates.some((template) =>
        template.mapping.eventHandlers.some((handler) =>
          handler.event.startsWith("Swap("),
        ),
      )
    ) {
      throw new Error("Manifest does not establish full V3 factory history");
    }
  }

  async priorUniswapActivity(origin: string, before: number) {
    Address.parse(origin);

    if (!Number.isSafeInteger(before) || before < 0) {
      throw new Error("Prior-activity query is outside Scout's budget.");
    }

    const response = await fetchJson(
      `https://gateway.thegraph.com/api/${encodeURIComponent(this.apiKey)}/subgraphs/id/${this.subgraphId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: PRIOR_QUERY,
          variables: { origin, before: String(before) },
        }),
      },
    );
    const envelope = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      })
      .parse(response);

    if (envelope.errors?.length) {
      throw new IntegrationError(
        "GRAPH_PRIOR_QUERY",
        "The Subgraph could not verify prior Uniswap activity.",
      );
    }

    const data = z
      .object({
        _meta: Meta,
        swaps: z
          .array(
            z.object({
              timestamp: z.string(),
              transaction: z.object({ id: Hash, blockNumber: z.string() }),
            }),
          )
          .max(1),
      })
      .parse(envelope.data);

    if (data._meta.hasIndexingErrors) {
      throw new IntegrationError(
        "GRAPH_INDEXING",
        "The Subgraph reports indexing errors during prior-activity verification.",
      );
    }

    return data;
  }
}
