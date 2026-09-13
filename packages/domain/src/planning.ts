import {
  BASE_USDC,
  BASE_USDC_EXECUTOR,
  compileErc20,
  type ExecutableWatchSpec,
  isBaseUsdcIntent,
  TRANSFER_SIGNATURE,
} from "./erc20";
import { dataPlanningClarification } from "./intent-clarification";
import { units } from "./money";
import {
  protocolExecution,
  protocolLabel,
  protocolProfileForIntent,
} from "./protocols";
import { type WatchSpec, WatchSpecSchema } from "./spec";
import {
  compileV4Intent,
  isV4LiquidityIntent,
  V4_LIQUIDITY_EXECUTOR,
  V4_PACKAGE,
} from "./uniswap/v4";
import { canonicalUniswapTokenSymbol, POOLS, TOKENS } from "./uniswap-scope";
import {
  type DataRequirementSpec,
  DataRequirementSpecSchema,
  type PackageCandidate,
  type PackageResolution,
  PackageResolutionSchema,
  type PipelinePlan,
  PipelinePlanSchema,
  type WatchIntentSpec,
} from "./workflow";

const VERIFIED_UNISWAP_EXECUTOR = "uniswap-v3-ethereum-swap-v1";
const PINNED_ETHEREUM_PACKAGE = "ethereum-common@v0.3.3";

function numericFilter(intent: WatchIntentSpec, names: string[]) {
  const entry = intent.filters.find((filter) =>
    names.includes(filter.field.toLowerCase().replaceAll(/[^a-z0-9]/g, "")),
  );

  if (!entry) {
    return null;
  }

  const value =
    typeof entry.value === "number" ? String(entry.value) : entry.value;

  return typeof value === "string" &&
    /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value)
    ? value
    : null;
}

function compileUniswapV3Swap(intent: WatchIntentSpec): WatchSpec {
  const normalize = (value: string) =>
    value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  const usdFields = [
    "usd",
    "amountusd",
    "swapusd",
    "swapamountusd",
    "thresholdusd",
  ];
  const countFields = ["count", "transactioncount", "swapcount"];

  for (const filter of intent.filters) {
    const field = normalize(filter.field);

    if (
      !(
        usdFields.includes(field) &&
        filter.operator === "gt" &&
        (!filter.unit || filter.unit.toUpperCase() === "USD")
      ) &&
      !(countFields.includes(field) && filter.operator === "gte")
    ) {
      throw new Error(
        `The executor cannot preserve filter ${filter.field} ${filter.operator}. Scout stopped rather than dropping or changing it.`,
      );
    }
  }

  if (
    intent.filters.filter((filter) =>
      usdFields.includes(normalize(filter.field)),
    ).length !== 1 ||
    intent.filters.filter((filter) =>
      countFields.includes(normalize(filter.field)),
    ).length > 1
  ) {
    throw new Error(
      "The executor requires one USD threshold and at most one transaction-count condition.",
    );
  }

  if (
    intent.subject.wallets.length ||
    intent.temporal.mode.value !== "continuous" ||
    intent.temporal.comparisonWindowSeconds
  ) {
    throw new Error(
      "Wallet-specific, bounded, and comparison-window monitoring require a different executor. These requirements have been preserved; they cannot be silently ignored.",
    );
  }

  if (!intent.activity.direction) {
    throw new Error(
      "This executor supports one swap direction per pipeline. Monitoring both directions requires a bidirectional executor; Scout will not silently choose selling.",
    );
  }

  const requestedPools = intent.subject.contracts.map((contract) =>
    contract.value.toLowerCase(),
  );

  if (
    requestedPools.some(
      (address) => !POOLS.some((pool) => pool.address === address),
    )
  ) {
    throw new Error(
      "The requested contract is outside the verified pool catalog. It needs onchain pool resolution and independent verification before activation.",
    );
  }

  const symbols = intent.subject.tokens.map((token) =>
    canonicalUniswapTokenSymbol(token.value),
  );

  if (
    symbols.length !== 2 ||
    !symbols.includes("WETH") ||
    !symbols.includes("USDC")
  ) {
    throw new Error(
      "Scout's verified Uniswap executor currently supports the WETH / USDC pair. The resolved intent is preserved so another pair executor can be added without changing the workflow.",
    );
  }

  const threshold = numericFilter(intent, [
    "usd",
    "amountusd",
    "swapusd",
    "swapamountusd",
    "thresholdusd",
  ]);

  if (!threshold) {
    throw new Error("A USD threshold is required for this Watch.");
  }

  const direction = intent.activity.direction?.value ?? "either";

  if (!(["buy", "sell", "either"] as const).includes(direction)) {
    throw new Error(
      "The resolved direction is not compatible with Scout's verified Uniswap swap executor.",
    );
  }

  const sellToken = direction === "buy" ? TOKENS[1] : TOKENS[0];
  const conditions: WatchSpec["conditions"] = [
    { kind: "large_swap", usd: threshold },
  ];
  const countText = numericFilter(intent, [
    "count",
    "transactioncount",
    "swapcount",
  ]);
  const count = countText ? Number(countText) : null;
  const windowSeconds = intent.temporal.evaluationWindowSeconds?.value ?? null;

  if ((count !== null) !== (windowSeconds !== null)) {
    throw new Error(
      "A repeated-transaction rule needs both a count and an evaluation window; neither may be dropped.",
    );
  }

  if (count && windowSeconds) {
    conditions.push({
      kind: "repeated_selling",
      minSwapUsd: threshold,
      count,
      cumulativeUsd: null,
      windowSeconds,
    });
  }

  const titleTokens =
    direction === "buy"
      ? "ETH buys"
      : direction === "sell"
        ? "ETH sales"
        : "ETH / USDC swaps";

  if (!requestedPools.length) {
    throw new Error(
      "Explicit supported pool scope is required; ask the poolScope clarification first.",
    );
  }

  if (intent.investigation.length && !intent.investigationRequirements.length) {
    throw new Error(
      "An investigation condition must have a typed executable requirement; prose is not an executable predicate.",
    );
  }

  const requiresFreshInitiator = intent.investigationRequirements.some(
    (item) =>
      item.kind === "no_prior_activity" && item.protocol === "uniswap_v3",
  );
  const name =
    `${Number(threshold).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}+ ${titleTokens}`.slice(
      0,
      72,
    );

  return WatchSpecSchema.parse({
    schemaVersion: 1,
    chainId: 1,
    protocol: "uniswap_v3",
    name,
    pools: [...new Set(requestedPools)],
    sellToken: sellToken.address,
    streamDirection: direction === "either" ? "either" : "selected",
    combine: "all",
    conditions,
    attribution: "transaction_initiator_eoa",
    confirmation: "finalized",
    valuation: "chainlink_at_block",
    unvaluedPolicy: "exclude",
    investigation: { requireNoPriorUniswapSwaps: requiresFreshInitiator },
    notifications: {
      inbox: true,
      telegram: intent.delivery.length
        ? intent.delivery.some((item) => item.value === "telegram")
        : true,
      email: intent.delivery.some((item) => item.value === "email"),
      useDefaults: intent.delivery.length === 0,
    },
    cooldownSeconds: 900,
  });
}

function compileVolumeRule(intent: WatchIntentSpec): WatchSpec {
  const normalized = (value: string) =>
    value.toLowerCase().replaceAll(/[^a-z]/g, "");
  const ratios = intent.filters.filter((filter) =>
    ["volumemultiplier", "volumeratio"].includes(normalized(filter.field)),
  );
  const floors = intent.filters.filter(
    (filter) => normalized(filter.field) === "volumeusd",
  );

  if (
    ratios.length !== 1 ||
    floors.length > 1 ||
    intent.filters.length !== ratios.length + floors.length ||
    intent.filters.some((filter) => filter.operator !== "gt")
  ) {
    throw new Error(
      "Volume monitoring requires one strict volume-multiplier threshold and optionally one strict volumeUsd floor; other conditions cannot be discarded.",
    );
  }

  const ratio = numericFilter(intent, ["volumemultiplier", "volumeratio"]);
  const floor = floors.length ? numericFilter(intent, ["volumeusd"]) : "0";
  const windowSeconds = intent.temporal.evaluationWindowSeconds?.value;
  const baselineSeconds = intent.temporal.comparisonWindowSeconds?.value;

  if (
    !ratio ||
    BigInt(units(ratio, 6)) <= 1_000_000n ||
    floor === null ||
    !windowSeconds ||
    !baselineSeconds ||
    windowSeconds + baselineSeconds > 7200
  ) {
    throw new Error(
      "Volume rules need a multiplier above 1 and explicit current/baseline windows totaling at most two hours.",
    );
  }

  if (
    floors.some(
      (filter) => filter.unit && filter.unit.toUpperCase() !== "USD",
    ) ||
    ratios.some(
      (filter) =>
        filter.unit &&
        !["x", "times", "ratio"].includes(filter.unit.toLowerCase()),
    )
  ) {
    throw new Error(
      "Volume thresholds must use USD and the multiplier must be a ratio, not a percentage.",
    );
  }

  const spec = compileUniswapV3Swap({
    ...intent,
    filters: [
      {
        field: "swapUsd",
        operator: "gt",
        value: "0",
        unit: "USD",
        source: "resolved",
      },
    ],
    temporal: {
      ...intent.temporal,
      evaluationWindowSeconds: null,
      comparisonWindowSeconds: null,
    },
  });

  return WatchSpecSchema.parse({
    ...spec,
    name: `${ratio}× ${spec.streamDirection === "either" ? "swap" : "directional swap"} volume`,
    conditions: [
      {
        kind: "aggregate",
        description: `USD volume rate above ${ratio}× the preceding ${baselineSeconds / 60}-minute average, measured over ${windowSeconds / 60} minutes${floor !== "0" ? ` and above $${floor}` : ""} per pool`,
        rule: {
          id: "volume_rate",
          predicates: [],
          groupBy: ["pool"],
          aggregate: { operation: "sum", field: "usdMicros" },
          windowSeconds,
          threshold: units(floor, 6).toString(),
          operator: "gt",
          baseline: {
            windowSeconds: baselineSeconds,
            multiplierMicros: units(ratio, 6).toString(),
            minimum: "1",
          },
        },
      },
    ],
  });
}

const watchSpecCompilers: Record<
  string,
  (intent: WatchIntentSpec) => WatchSpec
> = {
  [VERIFIED_UNISWAP_EXECUTOR]: (intent) =>
    intent.activity.type.value === "volume_burst"
      ? compileVolumeRule(intent)
      : compileUniswapV3Swap(intent),
};

export function compileExecutableSpec(
  intent: WatchIntentSpec,
): ExecutableWatchSpec {
  if (isV4LiquidityIntent(intent)) {
    return compileV4Intent(intent);
  }

  return isBaseUsdcIntent(intent)
    ? compileErc20(intent)
    : compileWatchSpec(intent);
}

export function compileWatchSpec(intent: WatchIntentSpec): WatchSpec {
  const profile = protocolProfileForIntent(intent);
  const execution = protocolExecution(profile, intent);
  const compiler = execution.executorId
    ? watchSpecCompilers[execution.executorId]
    : null;

  if (!compiler) {
    throw new Error(
      execution.reason ??
        `Scout does not yet have a verified live executor for ${protocolLabel(profile, intent.subject.protocolVersion?.value)} ${intent.activity.type.value.replaceAll("_", " ")} monitoring.`,
    );
  }

  return compiler(intent);
}

export function planDataRequirements(
  intent: WatchIntentSpec,
): DataRequirementSpec {
  if (
    !intent.subject.chain ||
    intent.unresolved.some((field) => field.classification === "BLOCKING")
  ) {
    throw new Error(
      "Resolve the network and blocking intent questions before data planning.",
    );
  }

  const profile = protocolProfileForIntent(intent);
  const activity = intent.activity.type.value;
  const clarification = dataPlanningClarification(intent);

  if (clarification) {
    throw new Error(clarification.question);
  }

  const v4 = isV4LiquidityIntent(intent);
  const blueprint = v4
    ? {
        domain: "dex",
        entity: "ModifyLiquidity",
        fields: [
          "poolId",
          "liquidityDelta",
          "sender",
          "tickLower",
          "tickUpper",
          "salt",
          "transactionHash",
          "logIndex",
          "blockNumber",
          "blockTimestamp",
        ],
        deterministicDerivedFields: [
          "canonical event id",
          "signed liquidity change",
          "PoolKey from Initialize",
          "transaction initiator from receipt",
        ],
        historicalQueries: ["authoritative pool Initialize event"],
        applicationResponsibilities: [
          "signed-delta filtering",
          "pool and actor scope filtering",
          "generic findings and delivery",
        ],
      }
    : profile.data[activity];

  if (!blueprint) {
    throw new Error(
      `Scout understood this as ${protocolLabel(profile, intent.subject.protocolVersion?.value)} ${activity.replaceAll("_", " ")}, but the protocol profile has no safe data contract for that activity.`,
    );
  }

  const historicalQueries = blueprint.historicalQueries.filter(
    (query) =>
      intent.investigation.length > 0 ||
      !/(?:prior|previous).*(?:wallet|address|swap|position)/i.test(query),
  );
  const version = intent.subject.protocolVersion?.value ?? null;
  const explicitProtocol = intent.subject.protocol?.value.trim() || null;
  const protocolName = explicitProtocol ?? profile.name;
  const activityQuery = `${protocolName} ${version ?? ""} ${blueprint.entity}`
    .replaceAll(/\s+/g, " ")
    .trim();
  const execution = protocolExecution(profile, intent);

  if (profile.id === "generic-evm" && explicitProtocol) {
    execution.reason = `Scout understood the ${explicitProtocol} intent and produced a generic EVM data plan, but no verified ${explicitProtocol} executor is registered yet.`;
  }

  return DataRequirementSpecSchema.parse({
    version: 1,
    chain: intent.subject.chain!.value,
    protocolProfile: profile.id,
    protocolName,
    protocolVersion: version,
    requiredStreams: [
      {
        domain: blueprint.domain,
        protocol:
          profile.id === "generic-evm"
            ? (explicitProtocol?.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-") ??
              null)
            : profile.id,
        entity: blueprint.entity,
        fields: blueprint.fields,
      },
    ],
    deterministicDerivedFields: blueprint.deterministicDerivedFields,
    historicalQueries,
    realtimeRequirements: {
      continuous: intent.temporal.mode.value === "continuous",
      reorgAware: true,
      finality: "finalized",
    },
    applicationResponsibilities: blueprint.applicationResponsibilities,
    packageHints: {
      queries: [activityQuery, ...profile.packageHints.queries],
      compatibilityTerms: [
        ...(explicitProtocol ? [explicitProtocol] : []),
        ...profile.packageHints.compatibilityTerms,
      ],
    },
    execution,
    verificationFields: v4 ? blueprint.fields : profile.verificationFields,
  });
}

function supportsPinnedEthereumFoundation(candidate: PackageCandidate) {
  return (
    candidate.ref === PINNED_ETHEREUM_PACKAGE &&
    candidate.modules.some(
      (module) =>
        module.name.endsWith("index_events") &&
        module.outputType === "proto:sf.substreams.index.v1.Keys",
    ) &&
    candidate.evidence.networkCompatible &&
    candidate.evidence.packageResolved
  );
}

function reusableModule(
  candidate: PackageCandidate,
  requirements: DataRequirementSpec,
) {
  const wanted = [
    ...new Set(requirements.requiredStreams.flatMap((stream) => stream.fields)),
  ];

  return candidate.modules.find(
    (module) =>
      module.kind === "map" &&
      module.outputType &&
      module.dependencyGraphValid &&
      wanted.every((field) => module.matchingFields.includes(field)),
  );
}

function selectedModule(
  candidate: PackageCandidate,
  requirements: DataRequirementSpec,
) {
  return (
    reusableModule(candidate, requirements)?.name ??
    candidate.modules
      .filter((module) => module.kind === "map" && module.dependencyGraphValid)
      .sort((a, b) => b.matchingFields.length - a.matchingFields.length)[0]
      ?.name ??
    null
  );
}

function alternatives(
  selected: PackageCandidate,
  candidates: PackageCandidate[],
) {
  return candidates
    .filter((candidate) => candidate.ref !== selected.ref)
    .slice(0, 4)
    .map((candidate) => ({
      ref: candidate.ref,
      reason: candidate.evidence.networkCompatible
        ? candidate.evidence.protocolCompatible
          ? `${candidate.evidence.matchingFields.length} required fields matched; the selected architecture has stronger verified execution compatibility.`
          : "A valid lower-level fallback, but it requires more Scout-owned decoding."
        : "The package network does not match the resolved Watch network.",
      score: candidate.score,
    }));
}

export function resolvePipelinePackages(
  requirements: DataRequirementSpec,
  candidates: PackageCandidate[],
): PackageResolution {
  const eligible = candidates
    .filter(
      (candidate) =>
        candidate.evidence.networkCompatible &&
        candidate.evidence.packageResolved,
    )
    .sort((left, right) => right.score - left.score);

  if (requirements.execution.executorId === BASE_USDC_EXECUTOR) {
    const common = eligible.find(
      (candidate) =>
        candidate.ref === PINNED_ETHEREUM_PACKAGE &&
        candidate.modules.some(
          (module) =>
            module.name === "filtered_events" &&
            module.dependencyGraphValid &&
            module.outputType === "proto:sf.substreams.ethereum.v1.Events",
        ),
    );

    if (!common) {
      throw new Error(
        "No inspected portable event-filter package satisfies the Base executor contract.",
      );
    }

    return PackageResolutionSchema.parse({
      selectedRef: common.ref,
      selectedModule: "filtered_events",
      strategy: "PARAMETERIZE",
      summary:
        "Parameterize the existing event filter for native USDC Transfer logs on Base; no WASM generation.",
      reasons: [
        "Inspected EVM log output includes transaction identity and canonical event index.",
        "Token and event-signature bindings are consumed by the provider request.",
        "Base receipt verification checks transfer decoding independently.",
      ],
      alternatives: alternatives(common, eligible),
      candidates,
    });
  }

  if (requirements.execution.executorId === VERIFIED_UNISWAP_EXECUTOR) {
    const common = eligible.find(supportsPinnedEthereumFoundation);

    if (!common) {
      throw new Error(
        "No inspected Ethereum event package exposes the checksum-pinned index_events module required by Scout's verified Uniswap decoder.",
      );
    }

    const protocolCandidates = eligible.filter(
      (candidate) => candidate.evidence.protocolCompatible,
    );
    const ordered = [common, ...protocolCandidates, ...eligible].filter(
      (candidate, index, all) =>
        all.findIndex((entry) => entry.ref === candidate.ref) === index,
    );

    return PackageResolutionSchema.parse({
      selectedRef: common.ref,
      selectedModule: "index_events",
      strategy: "COMPOSE",
      summary:
        "Compose a checksum-pinned Ethereum event stream with Scout's verified Uniswap V3 normalization module.",
      reasons: [
        "Protocol-specific candidates are inspected first for decoded Uniswap semantics.",
        "The selected foundation preserves the transaction attribution and signed amount fields required by Scout's verified runtime.",
        "USD thresholds, history checks, cooldowns, investigation, and delivery stay in the application layer.",
      ],
      alternatives: alternatives(common, ordered),
      candidates,
    });
  }

  // Descriptors currently prove fields, not protocol deployment versions.
  // A name or retrieval score cannot authorize reuse for a versioned request.
  if (requirements.execution.executorId === V4_LIQUIDITY_EXECUTOR) {
    const selected = eligible.find(
      (c) =>
        c.ref === V4_PACKAGE &&
        c.modules.some(
          (m) =>
            m.name === "map_events" &&
            m.outputType === "proto:uniswap.v4.Events" &&
            m.dependencyGraphValid &&
            [
              "pool_id",
              "liquidity_delta",
              "sender",
              "tick_lower",
              "tick_upper",
              "salt",
              "transaction_hash",
              "log_index",
              "block_number",
              "block_timestamp",
            ].every((field) =>
              m.outputFields.includes(`modify_liquidity_events.${field}`),
            ),
        ),
    );

    if (!selected) {
      throw new Error(
        "The inspected V4 ModifyLiquidity package/module is unavailable.",
      );
    }

    return PackageResolutionSchema.parse({
      selectedRef: selected.ref,
      selectedModule: "map_events",
      strategy: "REUSE",
      summary:
        "Reuse the published V4 event decoder. Liquidity deltas have no token/USD valuation.",
      reasons: [
        "Inspected ModifyLiquidity fields match the installed adapter. Deployment still requires checksum, canonical receipt and Initialize verification.",
      ],
      alternatives: alternatives(selected, eligible),
      candidates,
    });
  }

  const protocolSpecific = eligible.find(
    (candidate) =>
      requirements.protocolVersion === null &&
      candidate.evidence.protocolCompatible &&
      !!reusableModule(candidate, requirements) &&
      candidate.trustSignals.sourceAvailable,
  );
  const selected =
    protocolSpecific ?? eligible.find(supportsPinnedEthereumFoundation);

  if (!selected) {
    throw new Error(
      `No inspected package is compatible with ${requirements.chain} and the resolved ${requirements.protocolName} data requirements.`,
    );
  }

  const directReuse = selected === protocolSpecific;

  return PackageResolutionSchema.parse({
    selectedRef: selected.ref,
    selectedModule: selectedModule(selected, requirements),
    strategy: directReuse
      ? selected.parameters.length
        ? "PARAMETERIZE"
        : "REUSE"
      : "COMPOSE",
    summary: directReuse
      ? `Proposed reuse of ${selected.ref}. Descriptor fields match; event semantics and executable integration remain unverified.`
      : `Proposed foundation: ${selected.ref}. Protocol decoding, valuation, and executable integration must still be implemented and verified.`,
    reasons: [
      `${selected.evidence.matchingFields.length} required fields were confirmed in the inspected package descriptors.`,
      directReuse
        ? "No custom protocol decoder is planned."
        : "A foundation stream does not prove the requested protocol events or their valuation. Missing acquisition semantics require implementation and verification.",
      requirements.execution.reason ??
        "A verified executor will be required before deployment.",
    ],
    alternatives: alternatives(selected, eligible).map((candidate) => ({
      ...candidate,
      reason:
        "Not selected: protocol deployment compatibility and executable event semantics have not been established.",
    })),
    candidates,
  });
}

function createVerifiedUniswapPlan(
  intent: WatchIntentSpec,
  requirements: DataRequirementSpec,
  resolution: PackageResolution,
  spec: WatchSpec | null,
) {
  const critical: Array<{ severity: "critical"; message: string }> = [];

  if (!spec) {
    critical.push({
      severity: "critical",
      message: "The verified Uniswap executor requires a compiled Watch spec.",
    });
  }

  if (requirements.chain !== "ethereum") {
    critical.push({
      severity: "critical",
      message:
        "The verified Uniswap executor is not compatible with this chain.",
    });
  }

  if (resolution.selectedRef !== PINNED_ETHEREUM_PACKAGE) {
    critical.push({
      severity: "critical",
      message:
        "The package ref does not match Scout's checksum-pinned Ethereum common build input.",
    });
  }

  const compiled = spec ?? {
    pools: [],
    sellToken: "",
  };

  return PipelinePlanSchema.parse({
    version: 1,
    chain: requirements.chain,
    protocol: {
      profileId: requirements.protocolProfile,
      name: requirements.protocolName,
      version: requirements.protocolVersion,
      activity: intent.activity.type.value,
    },
    execution: requirements.execution,
    strategy: resolution.strategy,
    dependencies: [
      {
        packageRef: resolution.selectedRef,
        module: resolution.selectedModule ?? "index_events",
        purpose:
          "Filter finalized Ethereum logs for the resolved Uniswap V3 pool scope.",
      },
    ],
    parameters: [
      {
        module: "index_events",
        name: "query",
        value: "resolved pool addresses + Uniswap V3 Swap signature",
      },
      {
        module: "map_watch",
        name: "scope",
        value: `${compiled.pools.join(",")};${spec?.streamDirection === "either" ? "*" : compiled.sellToken}`,
      },
    ],
    generatedModules: [
      {
        name: "map_swaps",
        kind: "map",
        inputs: ["sf.ethereum.type.v2.Block"],
        outputType: "proto:scout.v1.Swaps",
        purpose:
          "Decode the Uniswap V3 Swap event and preserve transaction context in Scout's canonical schema.",
      },
      {
        name: "map_watch",
        kind: "map",
        inputs: ["params", "map_swaps"],
        outputType: "proto:scout.v1.Swaps",
        purpose:
          "Apply pool and direction parameters before the durable consumer.",
      },
    ],
    protoMessages: ["scout.v1.Swap", "scout.v1.Swaps"],
    requiredArtifacts: [
      "Cargo.toml",
      "Cargo.lock",
      "substreams.yaml",
      "proto/scout.proto",
      "src/lib.rs",
      "scout.spkg",
    ],
    startBlock: null,
    sink: {
      type: "scout-consumer",
      config: { cursorPersistence: true, finalizedOnly: true },
    },
    applicationRules: requirements.applicationResponsibilities,
    verificationPlan: requirements.verificationFields.map(
      (field) => `Compare ${field} with an independent Uniswap data source.`,
    ),
    selectionReasons: resolution.reasons,
    critic: {
      passed: critical.length === 0,
      findings: critical.length
        ? critical
        : [
            {
              severity: "info",
              message:
                "Every required Uniswap swap field has an implementation boundary.",
            },
            {
              severity: "info",
              message:
                "Deterministic rules, Graph context, investigation, and delivery remain outside WASM.",
            },
            {
              severity: "info",
              message: "No stateful Substreams store is required.",
            },
          ],
    },
  });
}

function createPlanningOnlyPlan(
  intent: WatchIntentSpec,
  requirements: DataRequirementSpec,
  resolution: PackageResolution,
) {
  const generatedModules = ["REUSE", "PARAMETERIZE"].includes(
    resolution.strategy,
  )
    ? []
    : [
        {
          name: "map_normalized_events",
          kind: "map" as const,
          inputs: [resolution.selectedModule ?? "selected package output"],
          outputType: "proto:scout.v1.OnchainEvents",
          purpose:
            "Normalize only the fields missing from the selected package into Scout's generic event contract.",
        },
      ];

  return PipelinePlanSchema.parse({
    version: 1,
    chain: requirements.chain,
    protocol: {
      profileId: requirements.protocolProfile,
      name: requirements.protocolName,
      version: requirements.protocolVersion,
      activity: intent.activity.type.value,
    },
    execution: requirements.execution,
    strategy: resolution.strategy,
    dependencies: [
      {
        packageRef: resolution.selectedRef,
        module: resolution.selectedModule ?? "module pending selection",
        purpose: `Provide the resolved ${requirements.requiredStreams[0]?.entity ?? "onchain event"} fields.`,
      },
    ],
    parameters: [],
    generatedModules,
    protoMessages: generatedModules.length
      ? ["scout.v1.OnchainEvent", "scout.v1.OnchainEvents"]
      : [],
    requiredArtifacts: generatedModules.length
      ? [
          "Cargo.toml",
          "substreams.yaml",
          "proto/scout.proto",
          "src/lib.rs",
          "scout.spkg",
        ]
      : [],
    startBlock: null,
    sink: {
      type: "scout-consumer",
      config: { cursorPersistence: true, finalizedOnly: true },
    },
    applicationRules: requirements.applicationResponsibilities,
    verificationPlan: requirements.verificationFields.map(
      (field) => `Compare ${field} with an independent chain data source.`,
    ),
    selectionReasons: resolution.reasons,
    critic: {
      passed: true,
      findings: [
        {
          severity: "info",
          message:
            "This is a proposed architecture, not verified field coverage or executable code.",
        },
        {
          severity: "warning",
          message:
            requirements.execution.reason ??
            "Deployment is blocked until this plan has a verified executor.",
        },
      ],
    },
  });
}

export function createPipelinePlan(
  intent: WatchIntentSpec,
  requirements: DataRequirementSpec,
  resolution: PackageResolution,
  spec: ExecutableWatchSpec | null = null,
): PipelinePlan {
  if (requirements.execution.executorId === V4_LIQUIDITY_EXECUTOR) {
    compileV4Intent(intent);

    return PipelinePlanSchema.parse({
      version: 1,
      chain: "ethereum",
      protocol: {
        profileId: "uniswap",
        name: "Uniswap",
        version: "v4",
        activity: intent.activity.type.value,
      },
      execution: requirements.execution,
      strategy: "REUSE",
      dependencies: [
        {
          packageRef: resolution.selectedRef,
          module: "map_events",
          purpose: "V4 PoolManager event decoder",
        },
      ],
      parameters: [],
      generatedModules: [],
      protoMessages: [],
      requiredArtifacts: ["package.spkg"],
      startBlock: null,
      sink: {
        type: "scout-consumer",
        config: { executorId: V4_LIQUIDITY_EXECUTOR },
      },
      applicationRules: requirements.applicationResponsibilities,
      verificationPlan: [
        "Canonical ModifyLiquidity receipt and Initialize evidence",
        "Generic signed-delta, scope, replay and unknown acceptance",
      ],
      selectionReasons: resolution.reasons,
      critic: {
        passed: true,
        findings: [
          {
            severity: "info",
            message:
              "Deployment requires independent pipeline and Watch acceptance verification.",
          },
        ],
      },
    });
  }

  if (requirements.execution.executorId === BASE_USDC_EXECUTOR) {
    const spec = compileErc20(intent);

    return PipelinePlanSchema.parse({
      version: 1,
      chain: "base",
      protocol: {
        profileId: "erc20",
        name: "ERC20",
        version: null,
        activity: "transfer",
      },
      execution: requirements.execution,
      strategy: "PARAMETERIZE",
      dependencies: [
        {
          packageRef: resolution.selectedRef,
          module: "filtered_events",
          purpose: "Portable EVM event stream",
        },
      ],
      parameters: [
        {
          module: "filtered_events",
          name: "query",
          value: `evt_addr:${BASE_USDC} && evt_sig:${TRANSFER_SIGNATURE}`,
        },
      ],
      generatedModules: [],
      protoMessages: [],
      requiredArtifacts: ["package.spkg"],
      startBlock: null,
      sink: {
        type: "scout-consumer",
        config: { executorId: BASE_USDC_EXECUTOR, token: spec.token },
      },
      applicationRules: requirements.applicationResponsibilities,
      verificationPlan: [
        "Compare canonical Transfer logs with Base RPC receipts",
        "Check inclusive/exclusive threshold, wrong token, and duplicate identity",
      ],
      selectionReasons: resolution.reasons,
      critic: {
        passed: true,
        findings: [
          {
            severity: "info",
            message:
              "Fixed parameter binding contract; deployment still requires pipeline and intent acceptance checks.",
          },
        ],
      },
    });
  }

  const plan =
    requirements.execution.executorId === VERIFIED_UNISWAP_EXECUTOR
      ? createVerifiedUniswapPlan(
          intent,
          requirements,
          resolution,
          spec?.protocol === "uniswap_v3" ? spec : null,
        )
      : createPlanningOnlyPlan(intent, requirements, resolution);

  if (!plan.critic.passed) {
    throw new Error(
      plan.critic.findings.map((finding) => finding.message).join(" "),
    );
  }

  return plan;
}
