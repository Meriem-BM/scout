import { BASE_USDC } from "../erc20";
import { V4_POOL_MANAGER } from "../uniswap/v4";
import { POOLS, TOKENS } from "../uniswap-scope";

import {
  type EventField,
  type Predicate,
  type WatchProgram,
  WatchProgramSchema,
} from "./program";

export type CapabilityState =
  | "AVAILABLE"
  | "AVAILABLE_WITH_PARAMETERS"
  | "REQUIRES_DATA_PIPELINE"
  | "REQUIRES_CLARIFICATION"
  | "UNSUPPORTED";

export type DataCapability = {
  id: string;
  chainId: number;
  eventType: string;
  protocol: string;
  contracts: readonly string[];
  assets: readonly string[];
  fields: Partial<
    Record<
      EventField,
      { status: "AVAILABLE" | "DERIVABLE" | "UNAVAILABLE"; meaning: string }
    >
  >;
  strategies: readonly (
    "REUSE" | "PARAMETERIZE" | "COMPOSE" | "EXTEND" | "GENERATE"
  )[];
  historicalProviders: readonly string[];
};

const commonFields: DataCapability["fields"] = {
  actor: {
    status: "AVAILABLE",
    meaning: "Adapter-defined observed actor, not economic ownership",
  },
  subject: { status: "AVAILABLE", meaning: "Observed contract or token" },
  contract: { status: "AVAILABLE", meaning: "Emitting contract" },
  protocol: {
    status: "AVAILABLE",
    meaning: "Verified decoder protocol identifier",
  },
  eventType: { status: "AVAILABLE", meaning: "Decoded activity kind" },
  transaction: { status: "AVAILABLE", meaning: "Canonical transaction hash" },
  asset: { status: "AVAILABLE", meaning: "Canonical asset address" },
  direction: {
    status: "DERIVABLE",
    meaning: "Asset movement relative to actor",
  },
  amount: {
    status: "AVAILABLE",
    meaning: "Raw integer token units; decimals supplied by adapter",
  },
  valueMicros: {
    status: "DERIVABLE",
    meaning: "Valued amount in millionths, requires explicit valuation source",
  },
  valuationSource: {
    status: "AVAILABLE",
    meaning: "Nominal stablecoin denomination or block-bound price feed",
  },
};

/** Installed acquisition adapters, not a claim that providers are currently healthy. */
export const DATA_CAPABILITIES: readonly DataCapability[] = [
  {
    id: "UNISWAP_V4_LIQUIDITY_CHANGE",
    chainId: 1,
    eventType: "liquidity_change",
    protocol: "uniswap_v4",
    contracts: [V4_POOL_MANAGER],
    assets: [],
    strategies: ["REUSE"],
    historicalProviders: [],
    fields: {
      actor: {
        status: "AVAILABLE",
        meaning: "Canonical transaction initiator; not LP ownership",
      },
      sender: {
        status: "AVAILABLE",
        meaning:
          "PoolManager caller from ModifyLiquidity; may be a position manager",
      },
      subject: {
        status: "DERIVABLE",
        meaning:
          "Pool ID bound to authoritative Initialize evidence; otherwise unknown",
      },
      contract: { status: "AVAILABLE", meaning: "Ethereum PoolManager" },
      protocol: { status: "AVAILABLE", meaning: "Uniswap V4" },
      eventType: { status: "AVAILABLE", meaning: "ModifyLiquidity" },
      transaction: {
        status: "AVAILABLE",
        meaning: "Canonical transaction hash",
      },
      metric: {
        status: "AVAILABLE",
        meaning: "Signed liquidity delta; never token amount or USD value",
      },
      valueMicros: {
        status: "UNAVAILABLE",
        meaning:
          "UNISWAP_V4_LIQUIDITY_VALUE: token amounts and valuation unavailable",
      },
    },
  },
  {
    id: "base-usdc-transfer",
    chainId: 8453,
    eventType: "transfer",
    protocol: "erc20",
    contracts: [BASE_USDC],
    assets: [BASE_USDC],
    fields: {
      ...commonFields,
      sender: {
        status: "AVAILABLE",
        meaning: "Transfer.from, may differ from transaction initiator",
      },
      recipient: { status: "AVAILABLE", meaning: "Transfer.to" },
    },
    strategies: ["PARAMETERIZE"],
    historicalProviders: [],
  },
  {
    id: "ethereum-v3-swaps",
    chainId: 1,
    eventType: "swap",
    protocol: "uniswap_v3",
    contracts: POOLS.map((p) => p.address),
    assets: TOKENS.map((t) => t.address),
    fields: {
      ...commonFields,
      actor: {
        status: "AVAILABLE",
        meaning: "RPC-verified transaction initiator",
      },
      participant: {
        status: "DERIVABLE",
        meaning: "Initiator only when EOA attribution is established",
      },
    },
    strategies: ["COMPOSE"],
    historicalProviders: ["graph-prior-uniswap-v3"],
  },
];

export type CapabilityDependency = {
  capability: string;
  category: "data" | "runtime" | "context" | "chain" | "valuation" | "delivery";
  status: CapabilityState;
  reason: string;
};

export type CapabilityPlan = {
  status:
    | "READY_TO_MONITOR"
    | "NEEDS_CLARIFICATION"
    | "NEEDS_PIPELINE_BUILD"
    | "BUILDING_PIPELINE"
    | "UNSUPPORTED";
  adapterId: string | null;
  dependencies: CapabilityDependency[];
  understood: boolean;
  pipelineGenerationCouldSolve: boolean;
};

export function requiredProgramFields(program: WatchProgram): Set<EventField> {
  const fields = new Set<EventField>();

  function predicate(p: Predicate) {
    if (p.kind === "all" || p.kind === "any") {
      p.terms.forEach(predicate);
    } else if (p.kind === "not") {
      predicate(p.term);
    } else {
      fields.add(p.field);
    }
  }

  if (program.filter) {
    predicate(program.filter);
  }

  program.metrics.forEach((metric) => {
    if (metric.field) {
      fields.add(metric.field);
    }
  });

  if (program.window.kind === "rolling") {
    program.window.groupBy.forEach((field) => fields.add(field));
  }

  program.history.forEach((req) => fields.add(req.subject));

  return fields;
}

export function planProgramCapabilities(
  input: WatchProgram,
  proof?: {
    pipelineVerified: boolean;
    acceptanceVerified: boolean;
    healthyStream: boolean;
  },
  registry = DATA_CAPABILITIES,
): CapabilityPlan {
  const program = WatchProgramSchema.parse(input);
  const dependencies: CapabilityDependency[] = [];
  const add = (
    category: CapabilityDependency["category"],
    capability: string,
    status: CapabilityState,
    reason: string,
  ) => dependencies.push({ category, capability, status, reason });
  const adapter = registry.find(
    (a) =>
      a.chainId === program.source.chainId &&
      a.eventType === program.source.eventType &&
      a.protocol === program.source.protocol &&
      program.source.contracts.length > 0 &&
      program.source.contracts.every((c) => a.contracts.includes(c)) &&
      (!program.asset || a.assets.includes(program.asset)),
  );

  add(
    "chain",
    `chain:${program.source.chainId}`,
    registry.some((a) => a.chainId === program.source.chainId)
      ? "AVAILABLE"
      : "UNSUPPORTED",
    "Only installed, validated chain adapters can acquire live data.",
  );

  if (!program.source.contracts.length) {
    add(
      "data",
      "source_scope",
      "REQUIRES_CLARIFICATION",
      "Specify or resolve the complete contract scope; no arbitrary pool is selected.",
    );
  } else {
    add(
      "data",
      adapter?.id ?? `${program.source.eventType}:source`,
      adapter ? "AVAILABLE_WITH_PARAMETERS" : "REQUIRES_DATA_PIPELINE",
      adapter
        ? "The installed adapter can normalize this scope; package execution still requires verification."
        : "No installed adapter guarantees this source and scope. A decoder and acquisition verification are required.",
    );
  }

  const fields = requiredProgramFields(program);

  for (const field of fields) {
    const available = adapter?.fields[field];

    add(
      "data",
      `field:${field}`,
      available && available.status !== "UNAVAILABLE"
        ? "AVAILABLE"
        : "REQUIRES_DATA_PIPELINE",
      available?.meaning ??
        "This field's semantics are not guaranteed by the selected source.",
    );
  }

  if (
    !program.asset &&
    [...fields].some((f) =>
      ["amount", "valueMicros", "direction", "asset"].includes(f),
    )
  ) {
    add(
      "data",
      "asset_projection",
      "REQUIRES_CLARIFICATION",
      "Resolve one asset before comparing its amount, direction, or value.",
    );
  }

  for (const metric of program.metrics) {
    add(
      "runtime",
      `aggregate:${metric.operation}`,
      "AVAILABLE",
      "Deterministic exact-integer evaluator; no model in the event path.",
    );
  }

  add(
    "runtime",
    `window:${program.window.kind}`,
    "AVAILABLE",
    "Event-time evaluation requires explicit complete coverage for rolling windows.",
  );

  for (const req of program.history) {
    const supported =
      req.protocol === "uniswap_v3" &&
      req.subject === "actor" &&
      adapter?.historicalProviders.includes("graph-prior-uniswap-v3");

    add(
      "context",
      `${req.kind}:${req.protocol}`,
      supported ? "AVAILABLE" : "UNSUPPORTED",
      supported
        ? "Hash-bound Graph history; absence requires proven coverage. Unknown remains pending."
        : "No provider can currently establish this historical predicate with coverage.",
    );
  }

  if (fields.has("valueMicros")) {
    add(
      "valuation",
      "explicit_valuation",
      adapter ? "AVAILABLE_WITH_PARAMETERS" : "UNSUPPORTED",
      adapter?.id === "base-usdc-transfer"
        ? "Canonical USDC nominal denomination, not an oracle-backed USD price."
        : "Requires a block-bound, non-stale price source; missing prices never become zero.",
    );
  }

  for (const channel of program.delivery.channels) {
    add(
      "delivery",
      channel,
      "AVAILABLE_WITH_PARAMETERS",
      channel === "inbox"
        ? "Persisted findings."
        : "Requires the account's configured and verified destination.",
    );
  }

  const unsupported = dependencies.some((d) => d.status === "UNSUPPORTED");
  const clarify = dependencies.some(
    (d) => d.status === "REQUIRES_CLARIFICATION",
  );
  const missing = dependencies.some(
    (d) => d.status === "REQUIRES_DATA_PIPELINE",
  );

  return {
    status: unsupported
      ? "UNSUPPORTED"
      : clarify
        ? "NEEDS_CLARIFICATION"
        : missing ||
            !proof?.pipelineVerified ||
            !proof.acceptanceVerified ||
            !proof.healthyStream
          ? "NEEDS_PIPELINE_BUILD"
          : "READY_TO_MONITOR",
    adapterId: adapter?.id ?? null,
    dependencies,
    understood: true,
    pipelineGenerationCouldSolve: missing && !unsupported,
  };
}
