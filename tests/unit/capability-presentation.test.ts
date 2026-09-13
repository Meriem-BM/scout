import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CapabilityCatalogSchema,
  compileExecutableSpec,
  compileUniswapProgram,
  DATA_CAPABILITIES,
  explainWatchCapabilities,
  getCapabilityCatalog,
  migrateExecutableProgram,
  POOLS,
  resolveWatchStarter,
  TOKENS,
  unavailableIntentCapability,
  WATCH_STARTERS,
} from "@scout/domain";

import {
  capabilityStatus,
  toCapabilityViewModel,
  toWatchCapabilityViewModel,
} from "../../apps/web/src/features/capabilities/view-model";

const intent = (n: number) => resolveWatchStarter(WATCH_STARTERS[n]!.prompt)!;

describe("one capability registry, safe public projection", () => {
  it("projects installed adapters and never treats generic understanding as protocol support", () => {
    const catalog = CapabilityCatalogSchema.parse(getCapabilityCatalog());

    expect(catalog.protocols.map((p) => p.id)).toEqual(
      DATA_CAPABILITIES.map((p) => p.id),
    );
    expect(
      catalog.protocols.find((p) => p.protocol === "ERC-20")?.chains,
    ).toEqual(["Base"]);
    expect(catalog.protocols.some((p) => p.protocol === "Aave")).toBe(false);
    expect(JSON.stringify(catalog.protocols)).not.toMatch(
      /historicalProviders|packageRef|0x[0-9a-f]{40}/,
    );
  });
  it("derives examples through executable validation, and removes withdrawn adapters", () => {
    const catalog = getCapabilityCatalog();

    for (const example of catalog.examples) {
      expect(
        migrateExecutableProgram(
          compileExecutableSpec(resolveWatchStarter(example.prompt)!),
        ),
      ).not.toBeNull();
    }

    expect(getCapabilityCatalog([])).toMatchObject({
      protocols: [],
      examples: [],
      chains: [],
    });

    const changed = DATA_CAPABILITIES.map((a) => ({
      ...a,
      status: "UNSUPPORTED" as const,
    }));

    expect(getCapabilityCatalog(changed).examples).toEqual([]);
  });
  it("reflects registry status changes without editing page or docs data", () => {
    const changed = DATA_CAPABILITIES.map((a) => ({
      ...a,
      status: "VERIFIED" as const,
    }));

    expect(
      getCapabilityCatalog(changed)
        .protocols.map(toCapabilityViewModel)
        .every((p) => p.status.label === "Ready"),
    ).toBe(true);
    expect(
      getCapabilityCatalog()
        .protocols.map(toCapabilityViewModel)
        .some((p) => p.status.label === "Limited"),
    ).toBe(true);
  });
  it("does not call a Watch ready when its source still needs to be built", () => {
    const changed = DATA_CAPABILITIES.map((a) => ({
      ...a,
      status: "REQUIRES_PIPELINE" as const,
    }));

    expect(explainWatchCapabilities(intent(0), null, changed).state).toBe(
      "MISSING",
    );
    expect(getCapabilityCatalog(changed).examples).toEqual([]);
  });
  it("keeps support arrays and raw registry reads out of public components", () => {
    for (const file of [
      "communication/landing.tsx",
      "communication/docs.tsx",
      "communication/intent-preview.tsx",
      "workspace/scope.tsx",
      "watches/composer.tsx",
      "workflow/workflow-outcome.tsx",
    ]) {
      expect(readFileSync(`apps/web/src/features/${file}`, "utf8")).not.toMatch(
        /WATCH_STARTERS|DATA_CAPABILITIES|supportedProtocols|supportedChains/,
      );
    }
  });
});
describe("plain-language Watch explanations", () => {
  it("maps every registry status without leaking the enum", () => {
    expect(Object.values(capabilityStatus).map((s) => s.label)).toEqual([
      "Ready",
      "Available",
      "Limited",
      "Can be built",
      "Not available yet",
    ]);
  });
  it.each([0, 1])(
    "shows installed data and tools for supported setup %i without claiming live",
    (n) => {
      const result = explainWatchCapabilities(intent(n));

      expect(result.state).toBe("READY_TO_BUILD");
      expect(result.requirements.every((r) => r.status === "available")).toBe(
        true,
      );
      expect(toWatchCapabilityViewModel(result).description).toContain(
        "Verification",
      );
    },
  );
  it("shows actual composed program requirements", () => {
    const result = compileUniswapProgram({
      version: "v3",
      activity: "swap",
      scope: { kind: "pool", address: POOLS[0].address },
      direction: "sell",
      subjectAsset: TOKENS[0].address,
      valueOperator: "gt",
      minimumValueMicros: null,
      distinctActors: 3,
      windowSeconds: 600,
      priorProtocolActivity: "not_required",
    });

    expect(result.program).not.toBeNull();

    const display = toWatchCapabilityViewModel(
      explainWatchCapabilities(null, result.program),
    );

    expect(display.available.map((r) => r.title)).toEqual(
      expect.arrayContaining([
        "Count unique wallets",
        "10-minute window",
        "Group by token",
      ]),
    );
  });
  it("preserves USD liquidity request and explains exactly what is missing, including older version spelling", () => {
    const request = intent(2);

    request.subject.protocolVersion!.value = "uniswap_v4";
    request.filters = [
      {
        field: "liquidityUsd",
        operator: "gt",
        value: "500000",
        unit: "USD",
        source: "explicit",
      },
    ];

    const before = structuredClone(request);
    const display = toWatchCapabilityViewModel(
      explainWatchCapabilities(request),
    );

    expect(display.available.map((r) => r.title)).toEqual(
      expect.arrayContaining([
        "Uniswap V4 liquidity changes",
        "Observed wallet",
        "Pool or token identity",
      ]),
    );
    expect(display.missing).toEqual([
      expect.objectContaining({
        title: "USD value of removed liquidity",
        explanation: expect.stringContaining("cannot yet reliably calculate"),
      }),
    ]);
    expect(request).toEqual(before);
  });
  it("explains unsupported protocol before unnecessary clarification", () => {
    const request = intent(0);

    request.subject.protocol!.value = "aave";
    request.subject.protocolVersion = null;
    request.activity.type.value = "liquidation_risk";
    expect(unavailableIntentCapability(request)?.message).toContain(
      "Aave data is not currently available",
    );

    const display = toWatchCapabilityViewModel(
      explainWatchCapabilities(request),
    );

    expect(display.missing[0]?.title).toContain("Aave data");
    expect(display.description).not.toMatch(/UNSUPPORTED|EXECUTOR|IR|protobuf/);
  });
  it("explains composed intent before a program has been built", () => {
    const request = intent(0);

    request.subject.contracts = [];
    request.filters = [
      {
        field: "uniqueActorCount",
        operator: "gte",
        value: "3",
        unit: null,
        source: "explicit",
      },
      {
        field: "groupBy",
        operator: "eq",
        value: "asset",
        unit: null,
        source: "explicit",
      },
    ];
    request.temporal.evaluationWindowSeconds = {
      value: 600,
      source: "explicit",
      confidence: 1,
    };

    const result = explainWatchCapabilities(request);

    expect(result.state).toBe("NEEDS_DETAIL");
    expect(
      result.requirements
        .filter((r) => r.status === "available")
        .map((r) => r.title),
    ).toEqual(
      expect.arrayContaining([
        "Count unique wallets",
        "Group by token",
        "10-minute window",
      ]),
    );
  });
  it("does not mark withdrawn data or absent fields available in an incomplete request", () => {
    const request = intent(2);

    request.filters = [
      {
        field: "liquidityUsd",
        operator: "gt",
        value: "500000",
        unit: "USD",
        source: "explicit",
      },
    ];

    const registry = DATA_CAPABILITIES.map((a) => ({
      ...a,
      status: "UNSUPPORTED" as const,
      fields: {},
    }));
    const result = explainWatchCapabilities(request, null, registry);

    expect(result.state).toBe("MISSING");
    expect(result.requirements.some((r) => r.status === "available")).toBe(
      false,
    );
  });
  it("uses registry liquidity fields for the early capability gate", () => {
    const request = intent(2);

    request.filters = [
      {
        field: "liquidityUsd",
        operator: "gt",
        value: "500000",
        unit: "USD",
        source: "explicit",
      },
    ];

    const updated = DATA_CAPABILITIES.map((a) => ({
      ...a,
      fields: {
        ...a.fields,
        valueMicros: {
          status: "AVAILABLE" as const,
          meaning: "Verified USD amount",
        },
      },
    }));

    expect(unavailableIntentCapability(request)?.code).toBe(
      "LIQUIDITY_USD_UNAVAILABLE",
    );
    expect(unavailableIntentCapability(request, updated)).toBeNull();
  });
});

describe("explicit scope stays binding", () => {
  it("treats a missing pool as clarification, not missing monitoring tools", () => {
    const request = intent(0);

    request.subject.contracts = [];

    const display = toWatchCapabilityViewModel(
      explainWatchCapabilities(request),
    );

    expect(display.missing).toEqual([]);
    expect(display.details).toHaveLength(1);
  });
});
