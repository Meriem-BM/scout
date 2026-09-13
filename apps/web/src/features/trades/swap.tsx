"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ExternalLink, Wallet } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { getAddress } from "viem";
import {
  useAccount,
  useConfig,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSendTransaction,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { getAccount } from "wagmi/actions";
import { z } from "zod";

import {
  assertQuoteCurrent,
  decimal,
  PERMIT2,
  PERMIT_TYPES,
  QuoteReviewSchema,
  TOKENS,
  TradeIntentSchema,
} from "@scout/domain";
import {
  buttonClassName,
  fieldClassName,
  noticeClassName,
  warningClassName,
} from "@/features/workspace/primitives";
import { queryKeys } from "@/lib/query/keys";

import { SignInButton } from "../account/sign-in-button";
import { useIncident } from "../incidents/queries";
import { api, Ok } from "../workspace/api";
import { shortAddress, useDateTime } from "../workspace/formatting";
import { Select } from "../workspace/select";
import { Busy, ErrorNotice, Status } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { walletSubmissionError } from "./wallet-errors";

import type { QuoteReview } from "@scout/domain";

const Transaction = z.object({
  to: z.custom<`0x${string}`>(
    (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
  ),
  from: z.string(),
  data: z.custom<`0x${string}`>(
    (value) => typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value),
  ),
  value: z.string(),
  chainId: z.literal(1),
  gasLimit: z.string().optional(),
  maxFeePerGas: z.string().optional(),
  maxPriorityFeePerGas: z.string().optional(),
});
const History = z.object({
  trades: z.array(
    z.object({
      id: z.string(),
      intent: TradeIntentSchema,
      state: z.string(),
      transaction_hash: z.string().nullable(),
      created_at: z.string(),
      expires_at: z.string(),
    }),
  ),
});
const Pending = z.object({
  id: z.string().uuid(),
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const subscribeClock = (listener: () => void) => {
  const id = setInterval(listener, 1000);

  return () => clearInterval(id);
};

function useNow() {
  return useSyncExternalStore(
    subscribeClock,
    () => Math.floor(Date.now() / 1000),
    () => 0,
  );
}

function explainWalletError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "The wallet operation failed.";

  if (/reject|denied/i.test(message)) {
    return "Signature rejected. Nothing else will be submitted. Review again only if you choose.";
  }

  if (/insufficient funds/i.test(message)) {
    return "Insufficient token balance or ETH for network fees.";
  }

  return message.slice(0, 550);
}

export function Swap() {
  const dateTime = useDateTime();
  const incidentId = useSearchParams().get("incident");
  const { incident } = useIncident(incidentId);
  const walletConfig = useConfig();
  const { signedIn, userId } = useWorkspace();
  // Signed transaction identities are an owner-scoped recovery journal, not a
  // private query cache. Preserve them through logout to avoid duplicate sends.
  const pendingSwapKey = `scout.transaction.${userId ?? "anonymous"}.swap`;
  const pendingApprovalKey = `scout.transaction.${userId ?? "anonymous"}.approval`;
  const account = useAccount();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const sender = useSendTransaction();
  const signer = useSignTypedData();
  const publicClient = usePublicClient({ chainId: 1 });
  const now = useNow();
  const [tokenIn, setTokenIn] = useState<string>(TOKENS[0].address);
  const tokenOut = tokenIn === TOKENS[0].address ? TOKENS[1] : TOKENS[0];
  const inputToken = tokenIn === TOKENS[0].address ? TOKENS[0] : TOKENS[1];
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("50");
  const [review, setReview] = useState<QuoteReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const history = useQuery({
    queryKey: queryKeys.trades,
    queryFn: () => api("/api/trades", History),
    enabled: signedIn,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const valid =
    review &&
    review.intent.wallet === account.address?.toLowerCase() &&
    account.chainId === 1 &&
    review.intent.tokenIn === tokenIn &&
    review.intent.amount === amount &&
    review.intent.slippageBps === Number(slippage) &&
    Date.parse(review.expiresAt) > now * 1000;

  const busyAction = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setMessage(null);

    try {
      await fn();
    } catch (error) {
      setError(explainWalletError(error));
    } finally {
      setBusy(null);
    }
  };

  const quote = () =>
    busyAction("Requesting quote", async () => {
      const intent = TradeIntentSchema.parse({
        wallet: account.address?.toLowerCase(),
        chainId: account.chainId,
        tokenIn,
        tokenOut: tokenOut.address,
        amount,
        slippageBps: Number(slippage),
      });
      const response = await api(
        "/api/trades",
        z.object({ review: QuoteReviewSchema }),
        { method: "POST", body: { action: "quote", intent } },
      );

      setReview(response.review);
      setAccepted(false);
      setSubmitted(false);
      await history.refetch();
    });
  const approve = () =>
    busyAction("Review approval in wallet", async () => {
      if (!review || !valid || !publicClient) {
        throw new Error(
          "Get a fresh quote for the current account and network.",
        );
      }

      const response = await api(
        "/api/trades",
        z.object({ transaction: Transaction.nullable() }),
        { method: "POST", body: { action: "approval", id: review.id } },
      );

      if (!response.transaction) {
        setMessage("Allowance is already sufficient. Get a fresh quote.");

        return;
      }

      const tx = response.transaction;
      const latest = getAccount(walletConfig);

      if (
        latest.address?.toLowerCase() !== review.intent.wallet ||
        latest.chainId !== 1
      ) {
        throw new Error("Wallet or network changed. Request a fresh quote.");
      }

      // Once handed to a wallet, an uncertain response must not enable a blind retry.
      setSubmitted(true);

      const hash = await sender
        .mutateAsync({
          account: getAddress(review.intent.wallet),
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value),
          chainId: 1,
        })
        .catch((error: unknown) => {
          throw new Error(walletSubmissionError(error));
        });

      sessionStorage.setItem(pendingApprovalKey, hash);
      setMessage(
        `Approval pending: ${hash}. Wait for confirmation before requesting a new quote.`,
      );

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 2,
        timeout: 180_000,
      });

      if (receipt.status !== "success") {
        throw new Error(`Approval reverted: ${hash}`);
      }

      sessionStorage.removeItem(pendingApprovalKey);
      setReview(null);
      setMessage(
        "Exact-amount approval confirmed. Request a fresh quote before reviewing and signing the swap.",
      );
    });
  const execute = () =>
    busyAction("Review permissions and swap", async () => {
      if (!review || !valid || !accepted || submitted) {
        throw new Error(
          "Review a fresh quote and confirm the checks before signing.",
        );
      }

      const intent = TradeIntentSchema.parse({
        wallet: account.address?.toLowerCase(),
        chainId: account.chainId,
        tokenIn,
        tokenOut: tokenOut.address,
        amount,
        slippageBps: Number(slippage),
      });

      assertQuoteCurrent(review, intent);

      let signature: string | null = null;

      if (review.permit) {
        const permit = review.permit;

        signature = await signer.mutateAsync({
          account: getAddress(review.intent.wallet),
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
        });
      }

      assertQuoteCurrent(review, intent);

      const { transaction: tx } = await api(
        "/api/trades",
        z.object({ transaction: Transaction }),
        {
          method: "POST",
          body: { action: "prepare", id: review.id, signature },
        },
      );

      assertQuoteCurrent(review, intent);

      const latest = getAccount(walletConfig);

      if (tx.from !== latest.address?.toLowerCase() || latest.chainId !== 1) {
        throw new Error("The prepared account changed.");
      }

      setMessage(
        "Simulation passed. Inspect the exact transaction in your wallet before signing.",
      );
      setSubmitted(true);
      setAccepted(false);

      const hash = await sender
        .mutateAsync({
          account: getAddress(review.intent.wallet),
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value),
          chainId: 1,
          gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
          maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas
            ? BigInt(tx.maxPriorityFeePerGas)
            : undefined,
        })
        .catch((error: unknown) => {
          throw new Error(walletSubmissionError(error));
        });
      const pending = { id: review.id, hash };

      try {
        sessionStorage.setItem(pendingSwapKey, JSON.stringify(pending));
      } catch {
        setMessage(
          `Submitted transaction ${hash}. Save this hash; browser recovery storage is unavailable.`,
        );
      }

      await api("/api/trades", Ok, {
        method: "POST",
        body: { action: "register", ...pending },
      });
      sessionStorage.removeItem(pendingSwapKey);
      setMessage(
        `Transaction submitted: ${hash}. Scout will show success only after its confirmed receipt is reconciled.`,
      );
      await history.refetch();
    });
  const recover = () =>
    busyAction("Checking pending identity", async () => {
      const raw = sessionStorage.getItem(pendingSwapKey);
      const approvalHash = sessionStorage.getItem(pendingApprovalKey);

      if (raw) {
        const pending = Pending.parse(JSON.parse(raw));

        await api("/api/trades", Ok, {
          method: "POST",
          body: { action: "register", ...pending },
        });
        sessionStorage.removeItem(pendingSwapKey);
        setMessage(
          "Existing transaction registered for reconciliation. Nothing was submitted again.",
        );
        await history.refetch();
      } else if (approvalHash && publicClient) {
        const hash = z
          .custom<`0x${string}`>(
            (value) =>
              typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
          )
          .parse(approvalHash);
        const receipt = await publicClient.getTransactionReceipt({ hash });

        setMessage(
          `Approval ${receipt.status === "success" ? "mined" : "reverted"}: ${hash}. Get a fresh quote to recheck the current allowance.`,
        );
        sessionStorage.removeItem(pendingApprovalKey);
      } else {
        setMessage(
          "No unregistered transaction identity is stored on this device. Persisted transaction history is shown below.",
        );
      }
    });

  return (
    <section className="mx-auto max-w-xl">
      <Link
        className="mb-6 inline-flex min-h-10 items-center gap-2 text-sm text-neutral-400 transition-colors hover:text-white"
        href={
          incident
            ? `/watches/${incident.watchId}/incidents/${incident.id}`
            : "/watches"
        }
      >
        <ArrowLeft width={13} height={13} />{" "}
        {incident ? "Back to incident" : "Watches"}
      </Link>
      <div className="mb-8 [&_p]:mt-2 [&_p]:text-sm [&_p]:text-neutral-400 max-sm:flex-wrap max-sm:gap-5">
        <div className="mb-2 text-xs font-medium tracking-wide text-neutral-400">
          A decision, not an instruction
        </div>
        <h1 className="mt-5">Review a swap</h1>
        <p>
          Uniswap v3 · Ethereum mainnet
          <br />
          Direct WETH / USDC pools only. Your wallet signs; Scout never holds
          your funds.
        </p>
      </div>
      <ErrorNotice message={error} />
      {message && (
        <div className={`${noticeClassName} mt-5`} role="status">
          {message}
        </div>
      )}
      <div className="my-5 rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 sm:p-6">
        <label className={fieldClassName} htmlFor="swap-amount">
          You pay
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_110px] gap-2 [&_input]:w-full [&_input]:min-w-0 [&_input]:rounded-md [&_input]:border [&_input]:border-neutral-700 [&_input]:bg-neutral-950 [&_input]:p-3 [&_input]:text-xl [&_select]:rounded-md [&_select]:border [&_select]:border-neutral-700 [&_select]:bg-neutral-950 [&_select]:p-2 [&_select]:text-sm">
            <input
              id="swap-amount"
              disabled={Boolean(busy)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setReview(null);
                setAccepted(false);
              }}
            />
            <Select
              aria-label="Input token"
              disabled={Boolean(busy)}
              value={tokenIn}
              onValueChange={(value) => {
                setTokenIn(value);
                setReview(null);
                setAccepted(false);
              }}
            >
              {TOKENS.map((token) => (
                <option value={token.address} key={token.address}>
                  {token.symbol}
                </option>
              ))}
            </Select>
          </div>
        </label>
        <div className="mx-auto my-3 flex size-9 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-950 text-neutral-400">
          <ArrowDown width={18} height={18} />
        </div>
        <div className="flex items-center gap-3 justify-between">
          <span className="text-sm leading-6 text-neutral-400">
            You receive
          </span>
          <strong>{tokenOut.symbol}</strong>
        </div>
        <p className="mt-5 text-3xl font-medium tabular-nums tracking-tight">
          {review
            ? decimal(review.outputAmount, tokenOut.decimals, 6)
            : "Not available"}
        </p>
        <p className="text-sm leading-6 text-neutral-400">
          {review
            ? "Expected output, before market movement"
            : "Request a quote for expected output"}
        </p>
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className={fieldClassName} htmlFor="slippage">
          Maximum slippage
          <Select
            id="slippage"
            disabled={Boolean(busy)}
            value={slippage}
            onValueChange={(value) => {
              setSlippage(value);
              setReview(null);
              setAccepted(false);
            }}
          >
            <option value="10">0.10%</option>
            <option value="50">0.50%</option>
            <option value="100">1.00%</option>
            <option value="300">3.00%</option>
          </Select>
        </label>
        <div className={fieldClassName}>
          <span>Route</span>
          <div className={noticeClassName}>Classic onchain · v3 only</div>
        </div>
      </div>
      {!signedIn ? (
        <SignInButton
          className={buttonClassName("primary", "w-full mt-5")}
          destination={`/swap${incidentId ? `?incident=${incidentId}` : ""}`}
        >
          Sign in to request a quote
        </SignInButton>
      ) : !account.isConnected ? (
        <div className="flex flex-col gap-3 mt-5">
          <button
            className={buttonClassName("primary", "w-full")}
            disabled={connect.isPending || !connect.connectors.length}
            onClick={() =>
              void busyAction("Connecting wallet", async () => {
                const connector = connect.connectors[0];

                if (!connector) {
                  throw new Error(
                    "Install an Ethereum wallet with an injected provider.",
                  );
                }

                await connect.mutateAsync({ connector });
              })
            }
          >
            <Wallet width={16} height={16} /> Connect Ethereum wallet
          </button>
          <p className="text-sm leading-6 text-neutral-400">
            Use a browser with an injected Ethereum wallet. WalletConnect and
            smart-account routes are not supported in this MVP.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 justify-between mt-5">
            <span className="font-mono text-xs break-all">
              {shortAddress(account.address ?? "")}
            </span>
            <button
              className={buttonClassName("quiet")}
              onClick={() => {
                disconnect.mutate();
                setReview(null);
              }}
            >
              Disconnect
            </button>
          </div>
          {account.chainId !== 1 ? (
            <button
              className={buttonClassName("primary", "w-full")}
              disabled={Boolean(busy)}
              onClick={() =>
                void busyAction("Switching network", async () => {
                  await switchChain.mutateAsync({ chainId: 1 });
                  setReview(null);
                })
              }
            >
              Switch wallet to Ethereum mainnet
            </button>
          ) : (
            <button
              className={buttonClassName("primary", "w-full")}
              disabled={Boolean(busy)}
              onClick={() => void quote()}
            >
              {busy ? (
                <Busy label={busy} />
              ) : review ? (
                "Get a fresh quote"
              ) : (
                "Get Uniswap quote"
              )}
            </button>
          )}
        </>
      )}
      {review && (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5 [&>h2]:mb-4 mt-5">
          <h2>Review before signing</h2>
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm [&_dt]:text-neutral-400 [&_dd]:min-w-0 [&_dd]:break-words sm:grid-cols-[140px_minmax(0,1fr)] mt-5">
            <dt>Minimum received</dt>
            <dd className="font-medium tabular-nums tracking-tight">
              {decimal(review.minimumAmount, tokenOut.decimals, 6)}{" "}
              {tokenOut.symbol}
            </dd>
            <dt>Network fee estimate</dt>
            <dd>
              {review.gasUsd
                ? `$${review.gasUsd}`
                : review.gasEstimate
                  ? `${review.gasEstimate} gas units; USD unavailable`
                  : "Not supplied"}
            </dd>
            <dt>Price impact</dt>
            <dd>
              {review.priceImpact !== null
                ? `${review.priceImpact}%`
                : "Not supplied by this quote"}
            </dd>
            <dt>Quote validity</dt>
            <dd>
              {valid
                ? `${Math.max(0, Math.ceil(Date.parse(review.expiresAt) / 1000 - now))} seconds remaining`
                : "Expired or inputs changed"}
            </dd>
            <dt>Recipient</dt>
            <dd className="font-mono text-xs break-all">
              {shortAddress(review.intent.wallet)}
            </dd>
            <dt>ERC-20 allowance</dt>
            <dd>
              {review.approvalNeeded
                ? `Approval for exactly ${review.intent.amount} ${inputToken.symbol}`
                : "Existing allowance sufficient"}
            </dd>
            <dt>Permit2 permission</dt>
            <dd>
              {review.permit
                ? `Exact input amount. Expires ${dateTime(Number(review.permit.values.details.expiration))}.`
                : "No new permit requested"}
            </dd>
          </dl>
          <p className="text-sm leading-6 text-neutral-400 mt-5">
            An approval allows Permit2 to spend the exact input amount; it is a
            separate, gas-paying transaction. A scoped Permit2 signature permits
            the allowlisted router. Neither is automatic.
          </p>
          {!valid && (
            <div className={`${warningClassName} mt-5`}>
              Quote expired, or wallet / network / inputs changed. Requote
              before signing.
            </div>
          )}
          {review.approvalNeeded ? (
            <button
              className={buttonClassName("default", "w-full mt-5")}
              disabled={!valid || Boolean(busy) || submitted}
              onClick={() => void approve()}
            >
              Review exact-amount approval in wallet
            </button>
          ) : (
            <>
              <label className="flex min-h-11 items-start gap-3 text-sm leading-6 [&_input]:mt-1.5 [&_input]:size-4 [&_input]:shrink-0 [&_input]:accent-white mt-5">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />{" "}
                I reviewed the tokens, amount, recipient, slippage, and
                permissions.
              </label>
              <button
                className={buttonClassName("primary", "w-full mt-5")}
                disabled={!valid || !accepted || Boolean(busy) || submitted}
                onClick={() => void execute()}
              >
                {busy ? (
                  <Busy label={busy} />
                ) : submitted ? (
                  "Signing attempt used · check wallet history"
                ) : (
                  "Review permission & sign swap"
                )}
              </button>
            </>
          )}
        </section>
      )}
      {signedIn && (
        <section className="space-y-5 mt-5">
          <details open={Boolean(history.data?.trades.length)}>
            <summary>Transaction history & recovery</summary>
            <p className="text-sm leading-6 text-neutral-400 mt-5">
              A pending transaction is never submitted again by Scout. The
              worker checks confirmed receipts; a refresh does not execute
              anything.
            </p>
            <button
              className={buttonClassName("quiet")}
              disabled={Boolean(busy)}
              onClick={() => void recover()}
            >
              Recover an already-submitted transaction
            </button>
            <ErrorNotice message={history.error?.message} />
            {history.data?.trades.map((trade) => (
              <div
                className="mt-7 border-t border-neutral-800 pt-6 [&>h2]:mb-4 [&>h3]:mb-4 [&>p]:text-sm [&>p]:text-neutral-400"
                key={trade.id}
              >
                <div className="flex items-center gap-3 justify-between">
                  <span className="text-sm leading-6">
                    {trade.intent.amount}{" "}
                    {trade.intent.tokenIn === TOKENS[0].address
                      ? "WETH"
                      : "USDC"}
                  </span>
                  <Status status={trade.state} />
                </div>
                <p className="text-sm leading-6 text-neutral-400">
                  {dateTime(trade.created_at)}
                </p>
                {trade.state === "prepared" && !trade.transaction_hash && (
                  <p className="text-sm leading-6 text-neutral-400">
                    A signing attempt was prepared. Its submission result is not
                    recorded. Check your wallet before starting another; Scout
                    cannot infer a broadcast from preparation.
                  </p>
                )}
                {trade.transaction_hash && (
                  <a
                    href={`https://etherscan.io/tx/${trade.transaction_hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonClassName(
                      "quiet",
                      "inline-flex items-center gap-2",
                    )}
                  >
                    {shortAddress(trade.transaction_hash)}{" "}
                    <ExternalLink width={12} height={12} />
                  </a>
                )}
              </div>
            ))}
          </details>
        </section>
      )}
    </section>
  );
}
