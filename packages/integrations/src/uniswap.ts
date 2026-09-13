import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  parseAbiParameters,
  recoverTypedDataAddress,
} from "viem";
import { z } from "zod";

import {
  Address,
  assertQuoteCurrent,
  Integer,
  PERMIT2,
  PERMIT_TYPES,
  PermitSchema,
  POOLS,
  QuoteReviewSchema,
  ROUTERS,
  tokenByAddress,
  TradeIntentSchema,
  units,
  validatePermit,
} from "@scout/domain";

import { assertServer, fetchJson } from "./http";

import type { Ethereum } from "./ethereum";
import type { QuoteReview, TradeIntent } from "@scout/domain";
import type { Hex } from "viem";

export const HexSchema = z.custom<Hex>(
  (value) => typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value),
);

export const TransactionSchema = z.object({
  to: Address,
  from: Address,
  data: HexSchema,
  value: Integer,
  chainId: z.coerce.number().int(),
  gasLimit: Integer.optional(),
  maxFeePerGas: Integer.optional(),
  maxPriorityFeePerGas: Integer.optional(),
  gasPrice: Integer.optional(),
});

export type PreparedTransaction = z.infer<typeof TransactionSchema>;

const Token = z
  .object({
    address: Address,
    chainId: z.number().int(),
    decimals: z.string().or(z.number()).optional(),
  })
  .passthrough();
const Classic = z
  .object({
    input: z.object({ amount: Integer, token: Address }),
    output: z.object({
      amount: Integer,
      token: Address,
      recipient: Address.optional(),
      minimumAmount: Integer.optional(),
    }),
    swapper: Address,
    chainId: z.number().int(),
    tradeType: z.literal("EXACT_INPUT"),
    slippage: z.number(),
    quoteId: z.string(),
    gasFeeUSD: z.string().optional(),
    gasUseEstimate: Integer.optional(),
    priceImpact: z.number().optional(),
    route: z
      .array(
        z.array(
          z
            .object({
              type: z.literal("v3-pool"),
              address: Address,
              tokenIn: Token,
              tokenOut: Token,
              fee: z.string().or(z.number()),
              amountIn: Integer.optional(),
              amountOut: Integer.optional(),
            })
            .passthrough(),
        ),
      )
      .min(1),
    aggregatedOutputs: z
      .array(
        z
          .object({
            recipient: Address,
            token: Address.optional(),
            amount: Integer.optional(),
            minAmount: Integer.optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const StoredQuoteSchema = z.object({
  raw: z.record(z.string(), z.unknown()),
  review: QuoteReviewSchema,
});

export type StoredQuote = z.infer<typeof StoredQuoteSchema>;

const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const THIS = "0x0000000000000000000000000000000000000002";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";

/** Only direct v3 exact-input paths in the two supported pools are accepted. */
export function validateSwapTransaction(
  transaction: PreparedTransaction,
  review: QuoteReview,
  now = Date.now(),
  expectedSignature?: string | null,
) {
  if (
    transaction.chainId !== 1 ||
    transaction.from !== review.intent.wallet ||
    !ROUTERS.some((router) => router === transaction.to) ||
    BigInt(transaction.value) !== 0n
  ) {
    throw new Error("Untrusted swap destination, account, chain, or value.");
  }

  const decoded = decodeFunctionData({
    abi: routerAbi,
    data: transaction.data,
  });
  const [commands, inputs, deadline] = decoded.args;

  if (
    Number(deadline) * 1000 <= now ||
    Number(deadline) * 1000 > now + 360_000
  ) {
    throw new Error("Invalid transaction deadline.");
  }

  const bytes = commands.slice(2).match(/.{2}/g) ?? [];

  if (bytes.length !== inputs.length || bytes.length > 8) {
    throw new Error("Unsupported router command sequence.");
  }

  let inputSum = 0n;
  let minimumDirect = 0n;
  let minimumSweep = 0n;
  let routedToSelf = false;
  let permitCount = 0;
  let sweepCount = 0;

  for (const [index, byte] of bytes.entries()) {
    const input = inputs[index];

    if (!input) {
      throw new Error("Missing router input.");
    }

    const command = Number.parseInt(byte, 16);

    if (command === 0) {
      const [recipient, amountIn, minimum, path, payerIsUser] =
        decodeAbiParameters(
          parseAbiParameters("address,uint256,uint256,bytes,bool"),
          input,
        );

      if (!payerIsUser || path.length !== 88) {
        throw new Error("Only direct, wallet-funded v3 routes are supported.");
      }

      const inputToken = `0x${path.slice(2, 42)}`.toLowerCase();
      const fee = Number.parseInt(path.slice(42, 48), 16);
      const outputToken = `0x${path.slice(48)}`.toLowerCase();

      if (
        inputToken !== review.intent.tokenIn ||
        outputToken !== review.intent.tokenOut ||
        !POOLS.some(
          (pool) =>
            pool.fee === fee && review.routePools.includes(pool.address),
        )
      ) {
        throw new Error(
          "Router path differs from the reviewed tokens or pools.",
        );
      }

      const target = recipient.toLowerCase();

      if (target === THIS) {
        routedToSelf = true;
      } else if (target === review.intent.wallet || target === MSG_SENDER) {
        minimumDirect += minimum;
      } else {
        throw new Error("Untrusted output recipient.");
      }

      inputSum += amountIn;
    } else if (command === 10) {
      permitCount++;

      if (permitCount > 1 || inputSum > 0n || sweepCount > 0) {
        throw new Error("Permit must occur once before swaps.");
      }

      const [permit, signature] = decodeAbiParameters(
        parseAbiParameters(
          "((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline),bytes",
        ),
        input,
      );
      const expected = review.permit;

      if (
        !expected ||
        permit.details.token.toLowerCase() !== expected.values.details.token ||
        permit.details.amount !== BigInt(expected.values.details.amount) ||
        permit.details.expiration !==
          Number(expected.values.details.expiration) ||
        permit.details.nonce !== Number(expected.values.details.nonce) ||
        permit.spender.toLowerCase() !== transaction.to ||
        permit.sigDeadline !== BigInt(expected.values.sigDeadline) ||
        (expectedSignature !== undefined &&
          signature.toLowerCase() !== expectedSignature?.toLowerCase())
      ) {
        throw new Error(
          "Calldata permit does not match the signed permission.",
        );
      }
    } else if (command === 4) {
      sweepCount++;

      if (
        sweepCount > 1 ||
        index !== bytes.length - 1 ||
        !routedToSelf ||
        minimumDirect > 0n
      ) {
        throw new Error(
          "Only one final sweep of router-held output is supported.",
        );
      }

      const [token, recipient, minimum] = decodeAbiParameters(
        parseAbiParameters("address,address,uint256"),
        input,
      );

      if (
        token.toLowerCase() !== review.intent.tokenOut ||
        ![review.intent.wallet, MSG_SENDER].includes(recipient.toLowerCase())
      ) {
        throw new Error("Untrusted sweep recipient or token.");
      }

      minimumSweep += minimum;
    } else {
      throw new Error(
        `Unsupported router command ${command}. No signature requested.`,
      );
    }
  }

  if (
    inputSum !== BigInt(review.inputAmount) ||
    permitCount !== (review.permit ? 1 : 0) ||
    (routedToSelf && minimumDirect > 0n) ||
    minimumDirect + minimumSweep < BigInt(review.minimumAmount) ||
    (routedToSelf && minimumSweep === 0n)
  ) {
    throw new Error("Swap amount or minimum output does not match the review.");
  }
}

export class UniswapAdapter {
  constructor(
    private readonly key: string,
    private readonly rpc: Ethereum,
  ) {
    assertServer();
  }
  private request(path: "quote" | "check_approval" | "swap", body: unknown) {
    return fetchJson(
      `https://trade-api.gateway.uniswap.org/v1/${path}`,
      {
        method: "POST",
        headers: {
          "x-api-key": this.key,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      15_000,
    );
  }
  async quote(input: TradeIntent, id: string): Promise<StoredQuote> {
    const intent = TradeIntentSchema.parse(input);
    const amount = units(
      intent.amount,
      tokenByAddress(intent.tokenIn).decimals,
    ).toString();
    const result = z
      .object({
        routing: z.literal("CLASSIC"),
        quote: z.record(z.string(), z.unknown()),
        permitData: PermitSchema.nullable(),
      })
      .parse(
        await this.request("quote", {
          type: "EXACT_INPUT",
          tokenInChainId: 1,
          tokenOutChainId: 1,
          tokenIn: intent.tokenIn,
          tokenOut: intent.tokenOut,
          swapper: intent.wallet,
          recipient: intent.wallet,
          amount,
          slippageTolerance: intent.slippageBps / 100,
          protocols: ["V3"],
          routingPreference: "BEST_PRICE",
          permitAmount: "EXACT",
        }),
      );
    const quote = Classic.parse(result.quote);

    if (
      quote.chainId !== 1 ||
      quote.swapper !== intent.wallet ||
      quote.input.token !== intent.tokenIn ||
      quote.output.token !== intent.tokenOut ||
      quote.input.amount !== amount ||
      quote.slippage !== intent.slippageBps / 100 ||
      (quote.output.recipient && quote.output.recipient !== intent.wallet) ||
      quote.aggregatedOutputs?.some(
        (out) =>
          out.recipient !== intent.wallet ||
          (out.token && out.token !== intent.tokenOut),
      )
    ) {
      throw new Error("The returned quote does not match your intent.");
    }

    const routePools: string[] = [];

    for (const route of quote.route) {
      if (route.length !== 1) {
        throw new Error(
          "This quote uses a multi-hop route outside Scout's direct-pool execution scope.",
        );
      }

      const hop = route[0];

      if (
        !hop ||
        !POOLS.some(
          (pool) =>
            pool.address === hop.address && pool.fee === Number(hop.fee),
        ) ||
        hop.tokenIn.address !== intent.tokenIn ||
        hop.tokenOut.address !== intent.tokenOut ||
        hop.tokenIn.chainId !== 1 ||
        hop.tokenOut.chainId !== 1
      ) {
        throw new Error("Quote route is outside the supported pools.");
      }

      routePools.push(hop.address);
    }

    const minimum = (
      (BigInt(quote.output.amount) * BigInt(10_000 - intent.slippageBps)) /
      10_000n
    ).toString();

    if (
      quote.output.minimumAmount &&
      BigInt(quote.output.minimumAmount) < BigInt(minimum)
    ) {
      throw new Error(
        "Quote minimum output is below the selected slippage limit.",
      );
    }

    if (result.permitData) {
      validatePermit(result.permitData, intent);

      const narrow = String(Math.floor(Date.now() / 1000) + 300);

      result.permitData.values.details.expiration = String(
        Math.min(
          Number(result.permitData.values.details.expiration),
          Number(narrow),
        ),
      );
      result.permitData.values.sigDeadline = String(
        Math.min(Number(result.permitData.values.sigDeadline), Number(narrow)),
      );
    }

    const allowance = await this.rpc.readContract({
      address: getAddress(intent.tokenIn),
      abi: erc20Abi,
      functionName: "allowance",
      args: [getAddress(intent.wallet), getAddress(PERMIT2)],
    });

    return {
      raw: result.quote,
      review: {
        id,
        intent,
        inputAmount: amount,
        outputAmount: quote.output.amount,
        minimumAmount: quote.output.minimumAmount ?? minimum,
        gasUsd: quote.gasFeeUSD ?? null,
        gasEstimate: quote.gasUseEstimate ?? null,
        priceImpact: quote.priceImpact ?? null,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        permit: result.permitData,
        approvalNeeded: allowance < BigInt(amount),
        approvalAmount: amount,
        routePools,
        routing: "CLASSIC",
      },
    };
  }
  async approval(stored: StoredQuote): Promise<PreparedTransaction | null> {
    const { review } = stored;

    assertQuoteCurrent(review, review.intent);

    const result = z
      .object({
        approval: TransactionSchema.nullable(),
        cancel: TransactionSchema.nullable().optional(),
      })
      .parse(
        await this.request("check_approval", {
          walletAddress: review.intent.wallet,
          token: review.intent.tokenIn,
          amount: review.inputAmount,
          chainId: 1,
          tokenOut: review.intent.tokenOut,
          tokenOutChainId: 1,
        }),
      );

    if (!result.approval) {
      return null;
    }

    const tx = result.approval;
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });

    if (
      tx.to !== review.intent.tokenIn ||
      tx.from !== review.intent.wallet ||
      tx.chainId !== 1 ||
      BigInt(tx.value) !== 0n ||
      decoded.functionName !== "approve" ||
      decoded.args[0].toLowerCase() !== PERMIT2
    ) {
      throw new Error("Untrusted token approval.");
    }

    // Build an independently reviewed, exact-amount ERC-20 approval. Never modify API swap calldata.
    return {
      ...tx,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [getAddress(PERMIT2), BigInt(review.inputAmount)],
      }),
    };
  }
  async prepare(
    stored: StoredQuote,
    signature: string | null,
  ): Promise<PreparedTransaction> {
    const { review } = stored;

    assertQuoteCurrent(review, review.intent);

    if (review.permit) {
      if (!signature) {
        throw new Error("Sign the scoped Permit2 permission first.");
      }

      validatePermit(review.permit, review.intent);

      const permit = review.permit;
      const signer = await recoverTypedDataAddress({
        domain: {
          name: "Permit2",
          chainId: 1,
          verifyingContract: getAddress(PERMIT2),
        },
        types: PERMIT_TYPES,
        primaryType: "PermitSingle",
        message: {
          details: {
            token: getAddress(permit.values.details.token),
            amount: BigInt(permit.values.details.amount),
            expiration: Number(permit.values.details.expiration),
            nonce: Number(permit.values.details.nonce),
          },
          spender: getAddress(permit.values.spender),
          sigDeadline: BigInt(permit.values.sigDeadline),
        },
        signature: HexSchema.parse(signature),
      });

      if (signer.toLowerCase() !== review.intent.wallet) {
        throw new Error(
          "Permit signature does not match the connected wallet.",
        );
      }
    } else if (signature) {
      throw new Error("This quote does not need a permit signature.");
    }

    const balance = await this.rpc.readContract({
      address: getAddress(review.intent.tokenIn),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(review.intent.wallet)],
    });

    if (balance < BigInt(review.inputAmount)) {
      throw new Error("Insufficient token balance.");
    }

    const result = z.object({ swap: TransactionSchema }).parse(
      await this.request("swap", {
        quote: stored.raw,
        ...(review.permit ? { permitData: review.permit, signature } : {}),
        deadline: Math.floor(Date.now() / 1000) + 300,
        refreshGasPrice: true,
        simulateTransaction: true,
      }),
    );

    validateSwapTransaction(result.swap, review, Date.now(), signature);

    const tx = {
      account: getAddress(result.swap.from),
      to: getAddress(result.swap.to),
      data: result.swap.data,
      value: BigInt(result.swap.value),
    };

    await this.rpc.call(tx);

    const gas = await this.rpc.estimateGas(tx);
    const fees = await this.rpc.estimateFeesPerGas();
    const native = await this.rpc.getBalance({ address: tx.account });

    if (native < gas * fees.maxFeePerGas) {
      throw new Error("Insufficient ETH for the estimated network fee.");
    }

    return {
      ...result.swap,
      gasLimit: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    };
  }
}
