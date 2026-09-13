import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  assertQuoteCurrent,
  PERMIT2,
  PERMIT_TYPES,
  POOLS,
  ROUTERS,
  TOKENS,
  TradeIntentSchema,
  validatePermit,
} from "@scout/domain";
import { validateSwapTransaction } from "@scout/integrations/uniswap";

import { walletSubmissionError } from "../../apps/web/src/features/trades/wallet-errors";

import type { QuoteReview } from "@scout/domain";
import type { Hex } from "viem";

const NOW = 1788588000000;

it("distinguishes a rejected signature from an ambiguous wallet submission without promising no broadcast", () => {
  expect(
    walletSubmissionError(new Error("User rejected the request. 4001")),
  ).toMatch(/Signature rejected.*not retry/);
  expect(walletSubmissionError(new Error("network timeout"))).toMatch(
    /may already have been broadcast.*not retry/,
  );
});

export function quoteFixture(): QuoteReview {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    intent: {
      chainId: 1,
      wallet: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
      tokenIn: TOKENS[0].address,
      tokenOut: TOKENS[1].address,
      amount: "1",
      slippageBps: 50,
    },
    inputAmount: "1000000000000000000",
    outputAmount: "3200000000",
    minimumAmount: "3184000000",
    gasUsd: null,
    gasEstimate: "150000",
    priceImpact: null,
    expiresAt: new Date(NOW + 30_000).toISOString(),
    permit: null,
    approvalNeeded: false,
    approvalAmount: "1000000000000000000",
    routePools: [POOLS[0].address],
    routing: "CLASSIC",
  };
}

const path: Hex = `0x${TOKENS[0].address.slice(2)}0001f4${TOKENS[1].address.slice(2)}`;
const swapInput = (
  recipient = getAddress(quoteFixture().intent.wallet),
  minimum = 3184000000n,
) =>
  encodeAbiParameters(
    parseAbiParameters("address,uint256,uint256,bytes,bool"),
    [recipient, 1000000000000000000n, minimum, path, true],
  );
const transaction = (
  commands: Hex = "0x00",
  inputs: Hex[] = [swapInput()],
) => ({
  to: ROUTERS[0],
  from: quoteFixture().intent.wallet,
  value: "0",
  chainId: 1,
  data: encodeFunctionData({
    abi: parseAbi([
      "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
    ]),
    functionName: "execute",
    args: [commands, inputs, BigInt(NOW / 1000 + 300)],
  }),
});

describe("quote identity and permission boundaries", () => {
  it("accepts a current, unchanged intent", () =>
    expect(() =>
      assertQuoteCurrent(quoteFixture(), quoteFixture().intent, NOW),
    ).not.toThrow());
  it("rejects expiration at the boundary", () =>
    expect(() =>
      assertQuoteCurrent(quoteFixture(), quoteFixture().intent, NOW + 30_000),
    ).toThrow(/expired/));
  it.each([
    { wallet: TOKENS[0].address },
    { amount: "2" },
    { slippageBps: 100 },
    { tokenIn: TOKENS[1].address },
  ])("invalidates changed intent %j", (patch) =>
    expect(() =>
      assertQuoteCurrent(
        quoteFixture(),
        { ...quoteFixture().intent, ...patch },
        NOW,
      ),
    ).toThrow(/changed/),
  );
  it("rejects unsupported networks and native input", () => {
    expect(
      TradeIntentSchema.safeParse({
        ...quoteFixture().intent,
        chainId: 11155111,
      }).success,
    ).toBe(false);
    expect(
      TradeIntentSchema.safeParse({
        ...quoteFixture().intent,
        tokenIn: "0x0000000000000000000000000000000000000000",
      }).success,
    ).toBe(false);
  });
  it("validates narrow Permit2 permissions and rejects unlimited approval", () => {
    const permit = {
      domain: {
        name: "Permit2" as const,
        chainId: 1,
        verifyingContract: PERMIT2,
      },
      types: JSON.parse(JSON.stringify(PERMIT_TYPES)),
      values: {
        details: {
          token: TOKENS[0].address,
          amount: "1000000000000000000",
          expiration: String(NOW / 1000 + 300),
          nonce: "0",
        },
        spender: ROUTERS[0],
        sigDeadline: String(NOW / 1000 + 300),
      },
    };

    expect(() =>
      validatePermit(permit, quoteFixture().intent, NOW),
    ).not.toThrow();
    permit.values.details.amount = (2n ** 160n - 1n).toString();
    expect(() => validatePermit(permit, quoteFixture().intent, NOW)).toThrow(
      /does not match/,
    );
  });
});
describe("classic onchain calldata inspection", () => {
  it("accepts the intended direct exact-input wallet-funded route", () =>
    expect(() =>
      validateSwapTransaction(transaction(), quoteFixture(), NOW),
    ).not.toThrow());
  it.each([
    { to: TOKENS[0].address },
    { from: TOKENS[0].address },
    { chainId: 10 },
    { value: "1" },
  ])("rejects changed transaction intent %j", (patch) =>
    expect(() =>
      validateSwapTransaction(
        { ...transaction(), ...patch },
        quoteFixture(),
        NOW,
      ),
    ).toThrow(/Untrusted/),
  );
  it("rejects unknown router commands and partial-fill flags", () => {
    expect(() =>
      validateSwapTransaction(transaction("0x21"), quoteFixture(), NOW),
    ).toThrow(/Unsupported/);
    expect(() =>
      validateSwapTransaction(transaction("0x80"), quoteFixture(), NOW),
    ).toThrow(/Unsupported/);
  });
  it("rejects a different recipient", () =>
    expect(() =>
      validateSwapTransaction(
        transaction("0x00", [swapInput(getAddress(TOKENS[0].address))]),
        quoteFixture(),
        NOW,
      ),
    ).toThrow(/recipient/));
  it("rejects an insufficient minimum", () =>
    expect(() =>
      validateSwapTransaction(
        transaction("0x00", [swapInput(undefined, 1n)]),
        quoteFixture(),
        NOW,
      ),
    ).toThrow(/minimum/));
  it("supports a single final output sweep and rejects inflated repeated sweep minimums", () => {
    const self = "0x0000000000000000000000000000000000000002";
    const sweep = encodeAbiParameters(
      parseAbiParameters("address,address,uint256"),
      [
        getAddress(TOKENS[1].address),
        getAddress(quoteFixture().intent.wallet),
        3184000000n,
      ],
    );

    expect(() =>
      validateSwapTransaction(
        transaction("0x0004", [swapInput(self), sweep]),
        quoteFixture(),
        NOW,
      ),
    ).not.toThrow();
    expect(() =>
      validateSwapTransaction(
        transaction("0x000404", [swapInput(self), sweep, sweep]),
        quoteFixture(),
        NOW,
      ),
    ).toThrow(/one final/);
  });
  it("rejects an expired transaction deadline", () =>
    expect(() =>
      validateSwapTransaction(transaction(), quoteFixture(), NOW + 301_000),
    ).toThrow(/deadline/));
});
