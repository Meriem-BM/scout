import { describe, expect, it } from "vitest";

import {
  compileV4Intent,
  compileV4LiquidityProgram,
  dataPlanningClarification,
  evaluateWatchProgram,
  NormalizedOnchainEventSchema,
  planDataRequirements,
  V4_CAPABILITIES,
  validateIntentAddresses,
  validateProgram,
  WatchIntentSpecSchema,
} from "@scout/domain";

import { verifyLiquidityAcceptance } from "../../apps/worker/src/pipeline/v4";
import fixture from "../fixtures/v4-liquidity.json";

const negative = NormalizedOnchainEventSchema.parse(fixture.negative);
const positive = NormalizedOnchainEventSchema.parse(fixture.positive);
const request = {
  version: "v4" as const,
  chainId: 1 as const,
  change: "decrease" as const,
  poolId: negative.subject,
  transactionInitiator: null,
  minimumUsd: null,
};

function program(input = request) {
  const result = compileV4LiquidityProgram(input);

  if (result.status !== "COMPILED") {
    throw new Error(result.reason);
  }

  return result.program;
}

describe("V4 ModifyLiquidity semantics", () => {
  it("evaluates actual opposite liquidity deltas without fabricating asset amounts", () => {
    expect(validateProgram(program()).status).toBe("PROGRAM_VALIDATED");
    expect(evaluateWatchProgram(program(), negative).status).toBe("MATCH");
    expect(evaluateWatchProgram(program(), positive).status).toBe("NO_MATCH");
    expect(negative.assets).toEqual([]);
    expect(negative.attributes.metricUnit).toBe("liquidity_units");
  });
  it("rejects the wrong pool and preserves unknown identity", () => {
    expect(
      evaluateWatchProgram(
        program({ ...request, poolId: `0x${"f".repeat(64)}` }),
        negative,
      ).status,
    ).toBe("NO_MATCH");
    expect(
      evaluateWatchProgram(program(), { ...negative, subject: null }).status,
    ).toBe("INSUFFICIENT_DATA");
  });
  it("keeps replay decisions identical", () => {
    expect(
      evaluateWatchProgram(program(), negative, [negative, negative]),
    ).toEqual(evaluateWatchProgram(program(), negative));
  });
  it("rejects USD valuation and does not default V3 to V4", () => {
    expect(
      compileV4LiquidityProgram({ ...request, minimumUsd: "500000" }),
    ).toMatchObject({
      status: "UNSUPPORTED",
      missingCapability: "UNISWAP_V4_LIQUIDITY_VALUE",
    });
    expect(V4_CAPABILITIES.UNISWAP_V4_LIQUIDITY_VALUE).toBe("UNSUPPORTED");
    expect(() =>
      compileV4LiquidityProgram({ ...request, version: "v3" as "v4" }),
    ).toThrow();
  });
});

const source = (value: string) => ({
  value,
  source: "explicit",
  confidence: 1,
});

function intent() {
  return WatchIntentSpecSchema.parse({
    version: 1,
    subject: {
      chain: source("ethereum"),
      protocol: source("uniswap_v4"),
      protocolVersion: source("v4"),
      contracts: [],
      tokens: [],
      wallets: [],
    },
    activity: {
      type: source("liquidity_removal"),
      event: source("ModifyLiquidity"),
      direction: null,
    },
    filters: [],
    temporal: {
      mode: source("continuous"),
      comparisonWindowSeconds: null,
      evaluationWindowSeconds: null,
    },
    investigation: [],
    investigationRequirements: [],
    delivery: [],
    assumptions: [],
    unresolved: [],
  });
}

it("compiles a resolved V4 intent without promising token amounts or USD", () => {
  const resolved = intent();

  expect(compileV4Intent(resolved).program.source.protocol).toBe("uniswap_v4");

  const data = planDataRequirements(resolved);

  expect(data.execution.status).toBe("verified");
  expect(data.requiredStreams[0]?.fields).toContain("liquidityDelta");
  expect(data.deterministicDerivedFields).not.toContain("USD value");
  resolved.subject.protocolVersion = null;
  expect(dataPlanningClarification(resolved)?.field).toBe("protocolVersion");
  expect(() => compileV4Intent(resolved)).toThrow();
});
it("requires an explicit actor role and preserves caller filtering", () => {
  const resolved = intent();

  resolved.subject.wallets = [
    source(
      String(negative.attributes.sender),
    ) as (typeof resolved.subject.wallets)[number],
  ];
  expect(dataPlanningClarification(resolved)?.field).toBe("actorRole");
  resolved.subject.actorRole = {
    value: "contract_caller",
    source: "explicit",
    confidence: 1,
  };

  const program = compileV4Intent(resolved).program;

  expect(evaluateWatchProgram(program, negative).status).toBe("MATCH");
  expect(
    evaluateWatchProgram(program, {
      ...negative,
      attributes: { ...negative.attributes, sender: "0x" + "1".repeat(40) },
    }).status,
  ).toBe("NO_MATCH");
});
it("accepts only user-supplied V4 pool IDs at the model boundary", () => {
  const resolved = intent();

  resolved.subject.contracts = [
    { value: negative.subject!, source: "explicit", confidence: 1 },
  ];
  expect(() =>
    validateIntentAddresses(resolved, [negative.subject!]),
  ).not.toThrow();
  expect(() => validateIntentAddresses(resolved, ["all pools"])).toThrow(
    "pool ID",
  );
});

it("generates scope acceptance checks from the compiled program", () => {
  const checks = verifyLiquidityAcceptance(program(), negative);

  expect(checks.cases).toContainEqual({
    name: "wrong_subject_rejected",
    passed: true,
  });
  expect(checks.cases.every((test) => test.passed)).toBe(true);

  const resolved = intent();

  resolved.subject.wallets = [
    {
      value: String(negative.attributes.sender),
      source: "explicit",
      confidence: 1,
    },
  ];
  resolved.subject.actorRole = {
    value: "contract_caller",
    source: "explicit",
    confidence: 1,
  };
  expect(
    verifyLiquidityAcceptance(compileV4Intent(resolved).program, negative)
      .cases,
  ).toContainEqual({ name: "wrong_sender_rejected", passed: true });
});
