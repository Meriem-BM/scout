import { expect, it } from "vitest";

import {
  BASE_USDC,
  CandidateEventSchema,
  compileExecutableSpec,
  Erc20WatchSpecSchema,
  evaluateTransfer,
  planDataRequirements,
  verifyTransferAcceptance,
  WatchIntentSpecSchema,
} from "@scout/domain";

const spec = Erc20WatchSpecSchema.parse({
  schemaVersion: 1,
  protocol: "erc20",
  chainId: 8453,
  name: "Base USDC transfers",
  token: BASE_USDC,
  thresholdMicros: "500000000000",
  operator: "gte",
  valuation: "nominal_usdc",
  confirmation: "finalized",
  notifications: {
    inbox: true,
    telegram: false,
    email: false,
    useDefaults: true,
  },
});
const address = "0x" + "1".repeat(40);
const hash = "0x" + "a".repeat(64);
const event = CandidateEventSchema.parse({
  id: "8453:controlled:1",
  chainId: 8453,
  block: { number: "123", hash, timestamp: 123 },
  transaction: { hash, initiator: address },
  eventIndex: 1,
  actor: { address, role: "sender" },
  subject: { address: BASE_USDC, kind: "token" },
  eventType: "transfer",
  protocol: "erc20",
  assets: [{ address: BASE_USDC, amount: "500000000000", decimals: 6 }],
  value: { usdMicros: "500000000000", source: "nominal_usdc" },
  metadata: { kind: "transfer", from: address, to: address },
  finality: "finalized",
  source: "substreams",
});

it("includes the explicit inclusive threshold and rejects smaller transfers", () => {
  expect(evaluateTransfer(spec, event)).not.toBeNull();
  expect(
    evaluateTransfer(spec, {
      ...event,
      value: { ...event.value!, usdMicros: "499999999999" },
    }),
  ).toBeNull();
});
it("rejects a wrong token or chain", () => {
  expect(
    evaluateTransfer(spec, { ...event, subject: { address, kind: "token" } }),
  ).toBeNull();
  expect(evaluateTransfer(spec, { ...event, chainId: 1 })).toBeNull();
});
it("passes the transfer acceptance suite", () =>
  expect(verifyTransferAcceptance(spec, event).status).toBe(
    "INTENT_ACCEPTANCE_VERIFIED",
  ));
it("compiles a structured transfer intent without matching prompt text", () => {
  const sourced = <T>(value: T) => ({
    value,
    source: "explicit" as const,
    confidence: 1,
  });
  const intent = WatchIntentSpecSchema.parse({
    version: 1,
    subject: {
      chain: sourced("base"),
      protocol: sourced("ERC20"),
      protocolVersion: null,
      contracts: [],
      tokens: [sourced("USDC")],
      wallets: [],
    },
    activity: {
      type: sourced("transfer"),
      event: sourced("Transfer"),
      direction: null,
    },
    filters: [
      {
        field: "transferUsd",
        operator: "gte",
        value: "500000",
        unit: "USD",
        source: "explicit" as const,
      },
    ],
    temporal: {
      mode: sourced("continuous"),
      comparisonWindowSeconds: null,
      evaluationWindowSeconds: null,
    },
    investigation: [],
    delivery: [],
    assumptions: [],
    unresolved: [],
  });

  expect(compileExecutableSpec(intent).protocol).toBe("erc20");
  expect(() =>
    compileExecutableSpec({
      ...intent,
      subject: { ...intent.subject, protocol: sourced("aave") },
    }),
  ).toThrow();
  expect(() =>
    compileExecutableSpec({
      ...intent,
      activity: { ...intent.activity, direction: sourced("buy") },
    }),
  ).toThrow();

  expect(planDataRequirements(intent).execution.executorId).toBe(
    "erc20-base-usdc-v1",
  );
});
