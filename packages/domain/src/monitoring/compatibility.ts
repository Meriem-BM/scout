/** Migration boundary for version-1 stored contracts. New primitives belong in runtime.ts. */
import { type CandidateEvent, CandidateEventSchema } from "../candidate-event";
import { units } from "../money";
import { POOLS, TOKENS } from "../uniswap-scope";

import {
  normalizedEventIdentity,
  type NormalizedOnchainEvent,
  NormalizedOnchainEventSchema,
} from "./event";
import {
  type Predicate,
  type WatchProgram,
  WatchProgramSchema,
} from "./program";

import type { Erc20WatchSpec, ProgramWatchSpec } from "../erc20";
import type { SwapEvent } from "../evidence";
import type { Condition, WatchSpec } from "../spec";

type Provenance = NormalizedOnchainEvent["provenance"];

export const legacyProvenance: Provenance = {
  source: "substreams",
  package: "legacy-unresolved",
  module: "legacy-unresolved",
  decoder: "stored-event-v1",
  pipelineVersion: "legacy-unresolved",
};

export function normalizeCandidate(
  event: CandidateEvent,
  provenance: Provenance,
): NormalizedOnchainEvent {
  event = CandidateEventSchema.parse(event);

  const raw = {
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
    timestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    transactionIndex: null,
    eventIndex: event.eventIndex,
    actor: event.actor.address,
    subject: event.subject.address,
    contract: event.subject.address,
    protocol: event.protocol,
    eventType: event.eventType,
    assets: event.assets.map((asset) => ({
      address: asset.address,
      direction: event.metadata.kind === "transfer" ? "transfer" : "sell",
      rawAmount: asset.amount,
      decimals: asset.decimals,
      valuation: !event.value
        ? null
        : event.value.source === "nominal_usdc"
          ? {
              kind: "nominal_stablecoin",
              valueMicros: event.value.usdMicros,
              source: "nominal_usdc",
            }
          : null,
    })),
    attributes:
      event.metadata.kind === "transfer"
        ? {
            sender: event.metadata.from,
            recipient: event.metadata.to,
            transactionInitiator: event.transaction.initiator,
          }
        : {
            soldToken: event.metadata.soldToken,
            amount0: event.metadata.amount0,
            amount1: event.metadata.amount1,
          },
    provenance,
    finalized: true,
  };

  return NormalizedOnchainEventSchema.parse({
    ...raw,
    id: normalizedEventIdentity(raw),
  });
}

export function normalizeLegacySwap(
  event: SwapEvent,
  provenance: Provenance = {
    ...legacyProvenance,
    decoder: "uniswap-rpc-chainlink-v1",
  },
): NormalizedOnchainEvent {
  if (event.finality !== "finalized") {
    throw new Error("Only finalized events can enter the monitoring runtime");
  }

  const sold = TOKENS.find((t) => t.address === event.sellToken)!;
  const bought = TOKENS.find((t) => t.address !== event.sellToken)!;
  const pool = POOLS.find((p) => p.address === event.pool);

  if (!pool) {
    throw new Error("Unknown legacy swap pool");
  }

  const amountBought = BigInt(
    bought.address === pool.token0.address ? event.amount0 : event.amount1,
  );
  const valuation = event.valuation
    ? {
        kind: "usd_price" as const,
        valueMicros: event.valuation.usdMicros,
        source: "chainlink",
        blockNumber: event.valuation.blockNumber,
        timestamp: event.valuation.updatedAt,
        stale: event.timestamp - event.valuation.updatedAt > sold.heartbeat,
      }
    : null;
  const raw = {
    chainId: event.chainId,
    blockNumber: event.blockNumber,
    blockHash: event.blockHash,
    timestamp: event.timestamp,
    transactionHash: event.transactionHash,
    eventIndex: event.logIndex,
  };

  return NormalizedOnchainEventSchema.parse({
    ...raw,
    id: normalizedEventIdentity(raw),
    transactionIndex: null,
    actor: event.initiator,
    subject: event.pool,
    contract: event.pool,
    protocol: "uniswap_v3",
    eventType: "swap",
    assets: [
      {
        address: sold.address,
        direction: "sell",
        rawAmount: event.sellAmount,
        decimals: sold.decimals,
        valuation,
      },
      {
        address: bought.address,
        direction: "buy",
        rawAmount: (amountBought < 0n
          ? -amountBought
          : amountBought
        ).toString(),
        decimals: bought.decimals,
        valuation,
      },
    ],
    attributes: {
      actorAttributable: event.attributable,
      soldToken: event.sellToken,
      amount0: event.amount0,
      amount1: event.amount1,
      valuationFeed: event.valuation?.feed ?? null,
      valuationRound: event.valuation?.roundId ?? null,
    },
    provenance: { ...provenance, source: event.source },
    finalized: true,
  });
}

const text = (
  field: "asset" | "direction" | "contract" | "valuationSource",
  values: string[],
): Predicate => ({ kind: "text", field, operator: "in", values });

export function transferProgram(spec: Erc20WatchSpec): WatchProgram {
  return WatchProgramSchema.parse({
    version: 1,
    source: {
      chainId: spec.chainId,
      eventType: "transfer",
      protocol: spec.protocol,
      contracts: [spec.token],
    },
    asset: spec.token,
    filter: text("valuationSource", [spec.valuation]),
    window: { kind: "event" },
    metrics: [{ id: "amount", operation: "sum", field: "valueMicros" }],
    condition: {
      kind: "metric",
      metric: "amount",
      operator: spec.operator,
      value: spec.thresholdMicros,
    },
    history: [],
    decision: "alert_on_match",
    delivery: delivery(spec.notifications),
  });
}

function delivery(value: WatchSpec["notifications"]): WatchProgram["delivery"] {
  return {
    channels: [
      "inbox",
      ...(value.telegram ? ["telegram" as const] : []),
      ...(value.email ? ["email" as const] : []),
    ],
    useDefaults: value.useDefaults,
  };
}

export function swapConditionProgram(
  spec: WatchSpec,
  condition: Exclude<Condition, { kind: "aggregate" }>,
): WatchProgram {
  const predicates: Predicate[] = [text("valuationSource", ["chainlink"])];

  if (spec.streamDirection !== "either") {
    predicates.push(text("direction", ["sell"]));
  }

  if (condition.kind === "repeated_selling") {
    predicates.push({
      kind: "number",
      field: "valueMicros",
      operator: "gt",
      value: units(condition.minSwapUsd, 6).toString(),
    });
  }

  const terms: WatchProgram["condition"][] = [];

  if (condition.kind === "large_swap") {
    terms.push({
      kind: "metric",
      metric: "value",
      operator: "gt",
      value: units(condition.usd, 6).toString(),
    });
  } else {
    if (condition.cumulativeUsd !== null) {
      terms.push({
        kind: "metric",
        metric: "value",
        operator: "gt",
        value: units(condition.cumulativeUsd, 6).toString(),
      });
    }

    if (condition.kind === "repeated_selling" && condition.count !== null) {
      terms.push({
        kind: "metric",
        metric: "transactions",
        operator: "gte",
        value: String(condition.count),
      });
    }
  }

  return WatchProgramSchema.parse({
    version: 1,
    source: {
      chainId: spec.chainId,
      eventType: "swap",
      protocol: spec.protocol,
      contracts: spec.pools,
    },
    asset: spec.sellToken,
    filter: { kind: "all", terms: predicates },
    window:
      condition.kind === "large_swap"
        ? { kind: "event" }
        : {
            kind: "rolling",
            seconds: condition.windowSeconds,
            groupBy:
              condition.kind === "repeated_selling"
                ? ["contract", "participant"]
                : ["contract"],
          },
    metrics:
      condition.kind === "large_swap"
        ? [{ id: "value", operation: "sum", field: "valueMicros" }]
        : [
            { id: "value", operation: "sum", field: "valueMicros" },
            {
              id: "transactions",
              operation: "unique_count",
              field: "transaction",
            },
          ],
    condition: terms.length === 1 ? terms[0] : { kind: "any", terms },
    history: spec.investigation.requireNoPriorUniswapSwaps
      ? [
          {
            id: "prior_activity",
            kind: "prior_activity",
            subject: "actor",
            protocol: "uniswap_v3",
            before: "current_transaction",
            expected: "none",
            application: "candidate",
          },
        ]
      : [],
    decision: "alert_on_match",
    delivery: delivery(spec.notifications),
  });
}

/** Unsupported legacy multi-window rules stay on their existing reader during migration. */
export function migrateExecutableProgram(
  spec: Erc20WatchSpec | WatchSpec | ProgramWatchSpec,
): WatchProgram | null {
  if (spec.protocol === "program") {
    return WatchProgramSchema.parse(spec.program);
  }

  if (spec.protocol === "erc20") {
    return transferProgram(spec);
  }

  if (
    spec.conditions.length !== 1 ||
    spec.conditions[0]!.kind === "aggregate"
  ) {
    return null;
  }

  return swapConditionProgram(spec, spec.conditions[0]!);
}
