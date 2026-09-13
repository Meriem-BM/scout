import { describe, expect, it } from "vitest";

import {
  canTransition,
  compileWatchSpec,
  createPipelinePlan,
  dataPlanningClarification,
  intentReadiness,
  PackageCandidateSchema,
  planDataRequirements,
  protocolProfiles,
  resolvePipelinePackages,
  substreamsRegistryUrl,
  WatchIntentSpecSchema,
  workflowErrorCategory,
} from "@scout/domain";
import { scorePackageCandidate } from "@scout/integrations/substreams-registry";

const source = <T>(
  value: T,
  kind: "explicit" | "inferred" | "default" | "resolved" = "explicit",
) => ({
  value,
  source: kind,
  confidence: kind === "explicit" ? 1 : 0.9,
});

function intent(blocking = false) {
  return WatchIntentSpecSchema.parse({
    version: 1,
    subject: {
      chain: blocking ? null : source("ethereum"),
      protocol: source("Uniswap"),
      protocolVersion: source("v3"),
      contracts: [source("0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640")],
      tokens: [source("ETH"), source("USDC")],
      wallets: [],
    },
    activity: {
      type: source("swap"),
      event: source("Swap"),
      direction: source("buy"),
    },
    filters: [
      {
        field: "swapUsd",
        operator: "gt",
        value: "100000",
        unit: "USD",
        source: "explicit",
      },
    ],
    temporal: {
      mode: source("continuous", "inferred"),
      comparisonWindowSeconds: null,
      evaluationWindowSeconds: null,
    },
    investigation: [source("prior Uniswap activity")],
    investigationRequirements: [
      {
        kind: "no_prior_activity",
        protocol: "uniswap_v3",
        actor: "transaction_initiator",
        scope: "all_protocol_pools",
      },
    ],
    delivery: [],
    assumptions: ["The test explicitly selects the 0.05% pool."],
    unresolved: blocking
      ? [
          {
            field: "chain",
            classification: "BLOCKING",
            reason: "The network changes the data source.",
          },
        ]
      : [],
  });
}

function walletTransferIntent(protocol: string | null = null) {
  return WatchIntentSpecSchema.parse({
    version: 1,
    subject: {
      chain: source("ethereum"),
      protocol: protocol ? source(protocol) : null,
      protocolVersion: null,
      contracts: [],
      tokens: protocol === "ERC-20" ? [source("USDC")] : [],
      wallets: [source("0x1111111111111111111111111111111111111111")],
    },
    activity: {
      type: source("transfer"),
      event: source("value transfer"),
      direction: source("either"),
    },
    filters: [
      {
        field: "transferUsd",
        operator: "gt",
        value: "250000",
        unit: "USD",
        source: "explicit",
      },
    ],
    temporal: {
      mode: source("continuous", "inferred"),
      comparisonWindowSeconds: null,
      evaluationWindowSeconds: null,
    },
    investigation: [],
    delivery: [],
    assumptions: [],
    unresolved: [],
  });
}

const common = PackageCandidateSchema.parse({
  ref: "ethereum-common@v0.3.3",
  name: "ethereum-common",
  version: "v0.3.3",
  network: "mainnet",
  publisher: "streamingfast",
  modules: [
    {
      name: "index_events",
      kind: "map",
      outputType: "proto:sf.substreams.index.v1.Keys",
      initialBlock: "0",
    },
  ],
  outputs: ["proto:sf.substreams.index.v1.Keys"],
  parameters: ["index_events"],
  dependencies: [],
  packageUrl: "https://spkg.io/v1/packages/ethereum-common/v0.3.3",
  sourceUrl: "https://github.com/streamingfast/substreams-foundational-modules",
  evidence: {
    matchingFields: ["transaction hash", "log index"],
    missingFields: ["token0 amount"],
    networkCompatible: true,
    protocolCompatible: false,
    packageResolved: true,
  },
  trustSignals: {
    publisher: "streamingfast",
    downloads: 1000,
    freshness: "v0.3.3",
    sourceAvailable: true,
  },
  score: 60,
});

const tokenTransfers = PackageCandidateSchema.parse({
  ...common,
  ref: "erc20-transfers@v1.2.0",
  name: "erc20-transfers",
  version: "v1.2.0",
  publisher: "verified-publisher",
  modules: [
    {
      name: "map_transfers",
      kind: "map",
      outputType: "proto:tokens.v1.Transfers",
      initialBlock: "0",
      dependencyGraphValid: true,
      matchingFields: [
        "token address",
        "from address",
        "to address",
        "amount",
        "transaction hash",
        "log index",
        "block number",
        "block timestamp",
      ],
    },
  ],
  outputs: ["proto:tokens.v1.Transfers"],
  parameters: [],
  evidence: {
    matchingFields: [
      "token address",
      "from address",
      "to address",
      "amount",
      "transaction hash",
      "log index",
      "block number",
      "block timestamp",
    ],
    missingFields: [],
    networkCompatible: true,
    protocolCompatible: true,
    packageResolved: true,
  },
  trustSignals: {
    publisher: "verified-publisher",
    downloads: 500,
    freshness: "v1.2.0",
    sourceAvailable: true,
  },
  score: 94,
});

describe("Watch compiler contracts", () => {
  it("distinguishes blocking clarification from visible defaults", () => {
    expect(intentReadiness(intent()).ready).toBe(true);
    expect(intentReadiness(intent()).defaults).toHaveLength(0);
    expect(intentReadiness(intent(true)).blocking[0]?.field).toBe("chain");
  });

  it("permits durable forward transitions and clarification resume only", () => {
    expect(canTransition("RECEIVED", "DATA_PLANNING")).toBe(true);
    expect(canTransition("NEEDS_CLARIFICATION", "INTENT_RESOLVING")).toBe(true);
    expect(canTransition("LIVE", "BUILDING")).toBe(false);
  });

  it("classifies deployment verification separately from semantic verification", () => {
    expect(workflowErrorCategory("SEMANTIC_VERIFYING")).toBe("VERIFICATION");
    expect(workflowErrorCategory("DEPLOYMENT_VERIFYING")).toBe("DEPLOYMENT");
    expect(workflowErrorCategory("CATCHING_UP")).toBe("STREAM");
    expect(workflowErrorCategory("CODE_GENERATING")).toBe("GENERATION");
  });

  it("keeps thresholds in Scout and composes the inspected package", () => {
    const resolved = intent();
    const spec = compileWatchSpec(resolved);

    expect(spec.sellToken).toMatch(/^0xa0b8/);
    expect(spec.conditions[0]).toEqual({ kind: "large_swap", usd: "100000" });

    const requirements = planDataRequirements(resolved);

    expect(requirements.applicationResponsibilities).toContain(
      "threshold evaluation",
    );

    const resolution = resolvePipelinePackages(requirements, [common]);
    const plan = createPipelinePlan(resolved, requirements, resolution, spec);

    expect(plan.strategy).toBe("COMPOSE");
    expect(plan.dependencies[0]?.packageRef).toBe("ethereum-common@v0.3.3");
    expect(plan.critic.passed).toBe(true);
  });

  it("plans Uniswap liquidity removal as liquidity data rather than swaps", () => {
    const resolved = WatchIntentSpecSchema.parse({
      ...intent(),
      activity: {
        type: source("liquidity_removal"),
        event: source("liquidity removal"),
        direction: null,
      },
      filters: [
        {
          field: "liquidityUsd",
          operator: "gt",
          value: "500000",
          unit: "USD",
          source: "explicit",
        },
      ],
      investigation: [],
    });
    const requirements = planDataRequirements(resolved);

    expect(requirements.protocolProfile).toBe("uniswap");
    expect(requirements.requiredStreams[0]).toMatchObject({
      domain: "dex",
      entity: "liquidity removal",
    });
    expect(requirements.requiredStreams[0]?.entity).not.toBe("swap");
    expect(requirements.execution.status).toBe("planning");

    const v4 = PackageCandidateSchema.parse({
      ...common,
      ref: "uniswap-v4-substreams@v0.1.1",
      name: "uniswap-v4-substreams",
      score: 1000,
      evidence: { ...common.evidence, protocolCompatible: true },
    });
    const resolution = resolvePipelinePackages(requirements, [v4, common]);

    expect(resolution.selectedRef).toBe(common.ref);
    expect(resolution.summary).toContain("Proposed foundation");
    expect(resolution.summary).toContain(
      "must still be implemented and verified",
    );
    expect(() => resolvePipelinePackages(requirements, [v4])).toThrow(
      "No inspected package",
    );
  });

  it("recognizes the verified Uniswap pair when intent tokens are addresses", () => {
    const addressed = WatchIntentSpecSchema.parse({
      ...intent(),
      subject: {
        ...intent().subject,
        tokens: [
          source("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
          source("0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
        ],
      },
    });
    const requirements = planDataRequirements(addressed);
    const spec = compileWatchSpec(addressed);

    expect(requirements.execution).toMatchObject({
      status: "verified",
      executorId: "uniswap-v3-ethereum-swap-v1",
    });
    expect(spec.sellToken).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  });

  it("plans a wallet transfer without forcing Uniswap into the architecture", () => {
    const resolved = walletTransferIntent();
    const requirements = planDataRequirements(resolved);

    expect(requirements.protocolProfile).toBe("generic-evm");
    expect(requirements.requiredStreams[0]).toMatchObject({
      domain: "evm",
      protocol: null,
      entity: "value transfer",
    });
    expect(JSON.stringify(requirements).toLowerCase()).not.toContain("uniswap");
    expect(requirements.execution.status).toBe("planning");
  });

  it("keeps protocol profiles uniquely addressable behind the generic planner", () => {
    expect(protocolProfiles.map((profile) => profile.id)).toEqual([
      "uniswap",
      "erc20",
      "aave",
      "generic-evm",
    ]);
    expect(new Set(protocolProfiles.map((profile) => profile.id)).size).toBe(
      protocolProfiles.length,
    );
  });

  it("preserves an unknown protocol instead of coercing it to Uniswap", () => {
    const resolved = walletTransferIntent("Future Protocol");
    const requirements = planDataRequirements(resolved);

    expect(requirements.protocolProfile).toBe("generic-evm");
    expect(requirements.protocolName).toBe("Future Protocol");
    expect(requirements.packageHints.queries[0]).toContain("Future Protocol");
    expect(requirements.execution.reason).toContain("Future Protocol");
    expect(JSON.stringify(requirements).toLowerCase()).not.toContain("uniswap");
  });

  it("prefers a compatible protocol package and does not invent generated code for reuse", () => {
    const resolved = walletTransferIntent("ERC-20");
    const requirements = planDataRequirements(resolved);
    const resolution = resolvePipelinePackages(requirements, [
      common,
      tokenTransfers,
    ]);
    const plan = createPipelinePlan(resolved, requirements, resolution);

    expect(resolution.selectedRef).toBe("erc20-transfers@v1.2.0");
    expect(resolution.selectedModule).toBe("map_transfers");
    expect(resolution.strategy).toBe("REUSE");
    expect(plan.generatedModules).toEqual([]);
    expect(plan.execution.status).toBe("planning");
  });

  it("links versioned packages without accepting arbitrary URLs", () => {
    expect(substreamsRegistryUrl("ethereum-common@v0.3.3")).toBe(
      "https://substreams.dev/packages/ethereum-common/v0.3.3",
    );
    expect(substreamsRegistryUrl("https://evil.example/package")).toBeNull();
    expect(substreamsRegistryUrl("foo@v1.0/../../admin")).toBeNull();
  });

  it("requires parameterization when a reusable package takes parameters", () => {
    const requirements = planDataRequirements(walletTransferIntent("ERC-20"));
    const resolution = resolvePipelinePackages(requirements, [
      { ...tokenTransfers, parameters: ["map_transfers"] },
    ]);

    expect(resolution.strategy).toBe("PARAMETERIZE");
    expect(
      createPipelinePlan(
        walletTransferIntent("ERC-20"),
        requirements,
        resolution,
      ).generatedModules,
    ).toEqual([]);
  });

  it("never treats legacy package-wide field claims as executable output coverage", () => {
    const candidate = PackageCandidateSchema.parse({
      ...tokenTransfers,
      modules: tokenTransfers.modules.map((module) => ({
        ...module,
        matchingFields: [],
        dependencyGraphValid: false,
      })),
    });

    expect(() =>
      resolvePipelinePackages(
        planDataRequirements(walletTransferIntent("ERC-20")),
        [candidate],
      ),
    ).toThrow("No inspected package");
  });

  it.each(["gte", "lt", "lte", "eq", "in"] as const)(
    "does not change a %s USD condition into greater-than",
    (operator) => {
      const resolved = intent();

      resolved.filters[0]!.operator = operator;
      expect(() => compileWatchSpec(resolved)).toThrow(
        "cannot preserve filter",
      );
    },
  );

  it("does not drop wallet scope and preserves either direction", () => {
    const resolved = intent();

    resolved.subject.wallets = [
      source("0x1111111111111111111111111111111111111111"),
    ];
    expect(() => compileWatchSpec(resolved)).toThrow("Wallet-specific");
    resolved.subject.wallets = [];
    resolved.activity.direction = source("either");
    expect(compileWatchSpec(resolved).streamDirection).toBe("either");
  });

  it("does not default a missing network to Ethereum", () => {
    expect(() => planDataRequirements(intent(true))).toThrow("network");
  });

  it("compiles explicit volume comparisons without discarding direction or baseline", () => {
    const resolved = intent();

    resolved.activity.type = source("volume_burst");
    resolved.activity.direction = source("either");
    resolved.temporal.evaluationWindowSeconds = source(300);
    resolved.temporal.comparisonWindowSeconds = source(3600);
    resolved.filters = [
      {
        field: "volumeMultiplier",
        operator: "gt",
        value: "3",
        unit: "x",
        source: "explicit",
      },
    ];
    expect(dataPlanningClarification(resolved)).toBeNull();

    const spec = compileWatchSpec(resolved);

    expect(spec.streamDirection).toBe("either");
    expect(spec.conditions[0]).toMatchObject({
      kind: "aggregate",
      rule: {
        windowSeconds: 300,
        baseline: { windowSeconds: 3600, multiplierMicros: "3000000" },
      },
    });
    resolved.filters.push({
      field: "unsupported",
      operator: "gt",
      value: "5",
      unit: null,
      source: "explicit",
    });
    expect(() => compileWatchSpec(resolved)).toThrow("cannot be discarded");
  });

  it("asks for a volume source before planning a generic contract stream", () => {
    const resolved = intent();

    resolved.activity.type = source("volume_burst");
    resolved.subject.protocol = null;
    resolved.subject.contracts = [];
    resolved.subject.protocolVersion = null;
    expect(dataPlanningClarification(resolved)?.field).toBe("volumeSource");
    expect(() => planDataRequirements(resolved)).toThrow(
      "Where should Scout measure volume",
    );
  });

  it("ranks deterministic compatibility above a misleading name", () => {
    const compatible = scorePackageCandidate({
      matched: 8,
      required: 9,
      networkCompatible: true,
      protocolCompatible: true,
      trustedPublisher: true,
      sourceAvailable: true,
      downloads: 100,
    });
    const wrongChain = scorePackageCandidate({
      matched: 9,
      required: 9,
      networkCompatible: false,
      protocolCompatible: true,
      trustedPublisher: true,
      sourceAvailable: true,
      downloads: 1_000_000,
    });

    expect(compatible).toBeGreaterThan(wrongChain);
  });
});
