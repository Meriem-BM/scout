import { z } from "zod";

import { units } from "./money";
import { Address, Integer, UsdInput } from "./spec";
import { PERMIT2, ROUTERS, tokenByAddress, TOKENS } from "./uniswap-scope";

const SupportedToken = Address.refine(
  (address) => TOKENS.some((token) => token.address === address),
  "Only WETH and USDC on Ethereum are supported.",
);

export const TradeIntentSchema = z
  .object({
    wallet: Address,
    chainId: z.literal(1),
    tokenIn: SupportedToken,
    tokenOut: SupportedToken,
    amount: UsdInput,
    slippageBps: z.number().int().min(5).max(300),
  })
  .refine(
    (value) => value.tokenIn !== value.tokenOut,
    "Choose different tokens.",
  )
  .refine((value) => {
    const token = TOKENS.find((token) => token.address === value.tokenIn);

    if (!token || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value.amount)) {
      return false;
    }

    return units(value.amount, token.decimals) > 0n;
  }, "Amount must be greater than zero.");

export type TradeIntent = z.infer<typeof TradeIntentSchema>;

export const PermitSchema = z.object({
  domain: z.object({
    name: z.literal("Permit2"),
    chainId: z.coerce.number().int(),
    verifyingContract: Address,
  }),
  types: z.record(
    z.string(),
    z.array(z.object({ name: z.string(), type: z.string() })),
  ),
  values: z.object({
    details: z.object({
      token: Address,
      amount: Integer,
      expiration: z.coerce.string().pipe(Integer),
      nonce: z.coerce.string().pipe(Integer),
    }),
    spender: Address,
    sigDeadline: z.coerce.string().pipe(Integer),
  }),
});

export const PERMIT_TYPES = {
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
} as const;

export const QuoteReviewSchema = z.object({
  id: z.string(),
  intent: TradeIntentSchema,
  inputAmount: Integer,
  outputAmount: Integer,
  minimumAmount: Integer,
  gasUsd: z.string().nullable(),
  gasEstimate: Integer.nullable(),
  priceImpact: z.number().nullable(),
  expiresAt: z.string(),
  permit: PermitSchema.nullable(),
  approvalNeeded: z.boolean(),
  approvalAmount: Integer,
  routePools: z.array(Address),
  routing: z.literal("CLASSIC"),
});

export type QuoteReview = z.infer<typeof QuoteReviewSchema>;

export function assertQuoteCurrent(
  quote: QuoteReview,
  intent: TradeIntent,
  now = Date.now(),
) {
  if (new Date(quote.expiresAt).getTime() <= now) {
    throw new Error("Quote expired. Get a fresh quote before signing.");
  }

  if (
    quote.intent.wallet !== intent.wallet ||
    quote.intent.chainId !== intent.chainId ||
    quote.intent.tokenIn !== intent.tokenIn ||
    quote.intent.tokenOut !== intent.tokenOut ||
    quote.intent.amount !== intent.amount ||
    quote.intent.slippageBps !== intent.slippageBps
  ) {
    throw new Error("Wallet, network, or inputs changed. Get a fresh quote.");
  }
}

export function validatePermit(
  permit: z.infer<typeof PermitSchema>,
  intent: TradeIntent,
  now = Date.now(),
) {
  if (
    permit.domain.chainId !== 1 ||
    permit.domain.verifyingContract !== PERMIT2 ||
    !ROUTERS.some((router) => router === permit.values.spender) ||
    permit.values.details.token !== intent.tokenIn ||
    BigInt(permit.values.details.amount) !==
      units(intent.amount, tokenByAddress(intent.tokenIn).decimals)
  ) {
    throw new Error("The permit does not match the reviewed swap.");
  }

  const deadline = Number(permit.values.sigDeadline) * 1000;
  const expiration = Number(permit.values.details.expiration) * 1000;

  if (
    deadline <= now ||
    deadline > now + 31 * 60 * 1000 ||
    expiration <= now ||
    expiration > now + 31 * 86400 * 1000
  ) {
    throw new Error("Unsupported permit expiry.");
  }

  for (const [name, fields] of Object.entries(PERMIT_TYPES)) {
    if (JSON.stringify(permit.types[name]) !== JSON.stringify(fields)) {
      throw new Error("Unsupported Permit2 typed data.");
    }
  }

  if (
    Object.keys(permit.types).some(
      (key) => !["PermitSingle", "PermitDetails", "EIP712Domain"].includes(key),
    )
  ) {
    throw new Error("Unexpected permit type.");
  }
}
