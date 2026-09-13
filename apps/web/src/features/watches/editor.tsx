"use client";

import {
  ArrowLeft as ArrowLeftIcon,
  ArrowRight as ArrowRightIcon,
  ShieldCheck as ShieldCheckIcon,
  X as XMarkIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  DEFAULT_PROMPT,
  defaultSpec,
  describeSpec,
  POOLS,
  TOKENS,
  usd,
  WatchSpecSchema,
} from "@scout/domain";

import { useScoutAuth } from "../account/auth-context";
import { SignInButton } from "../account/sign-in-button";
import { ConnectionControls } from "../connections/connections";
import { api } from "../workspace/api";
import { useDateTime } from "../workspace/formatting";
import {
  buttonClassName,
  inputClassName,
  warningClassName,
} from "../workspace/primitives";
import { TokenPair } from "../workspace/scope";
import { Select } from "../workspace/select";
import { Busy, ErrorNotice, Modal } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { setDraft, useDraft } from "./draft";
import { useSaveWatch } from "./mutations";
import { useWatch } from "./queries";
import { useReviewDraft } from "./review-draft";

import type { Condition, Watch, WatchSpec } from "@scout/domain";

const Interpretation = z.object({
  spec: WatchSpecSchema.nullable(),
  clarification: z.string().nullable(),
  supported: z.boolean(),
});
const Preview = z.object({
  verified: z.object({
    verifiedEvents: z.number(),
    unavailable: z.number(),
    sampleStart: z.number().nullable(),
    sampleEnd: z.number().nullable(),
    matches: z.array(
      z.object({
        timestamp: z.number(),
        totalUsdMicros: z.string(),
        transactionCount: z.number(),
        evidenceIds: z.array(z.string()),
      }),
    ),
  }),
  status: z.string(),
  from: z.number(),
  to: z.number(),
  refreshedAt: z.string(),
  block: z.object({ number: z.number() }),
  sampled: z.number(),
  note: z.string(),
  swaps: z.array(
    z.object({
      id: z.string(),
      timestamp: z.string(),
      amountUSD: z.string(),
      amount0: z.string(),
      amount1: z.string(),
    }),
  ),
});

function RuleEditor({ watch }: { watch?: Watch }) {
  const dateTime = useDateTime();
  const { signedIn, state } = useWorkspace();
  const save = useSaveWatch();
  const draft = useDraft();
  const router = useRouter();
  const auth = useScoutAuth();
  const params = useSearchParams();
  const auto = useRef(false);
  const [stored, persist] = useReviewDraft(`live:${watch?.id ?? "new"}`);
  const [localSpec, setLocalSpec] = useState<WatchSpec>(
    (watch?.spec?.protocol === "uniswap_v3" ? watch.spec : null) ?? {
      ...defaultSpec(),
      cooldownSeconds: state.preferences.cooldownSeconds,
      notifications: { inbox: true, ...state.preferences, useDefaults: true },
    },
  );
  const spec = stored ?? localSpec;
  const [step, setStep] = useState(watch ? 1 : 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);
  const [preview, setPreview] = useState<z.infer<typeof Preview> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const original = watch?.prompt ?? draft;

  const change = (patch: Partial<WatchSpec>) => {
    const next = { ...spec, ...patch };

    setLocalSpec(next);
    persist(next);
    setPreview(null);
  };

  const condition = (index: number, patch: Partial<Condition>) =>
    change({
      conditions: spec.conditions.map((c, i) =>
        i === index ? Object.assign({}, c, patch) : c,
      ),
    });

  async function interpret() {
    setError(null);
    setClarification(null);

    if (!signedIn) {
      auth.login("/new?review=1");

      return;
    }

    setBusy("interpret");

    try {
      const prompt = draft.trim() || DEFAULT_PROMPT;

      setDraft(prompt);

      const result = await api("/api/interpret", Interpretation, {
        method: "POST",
        body: { prompt },
      });

      if (result.spec) {
        change({
          ...result.spec,
          cooldownSeconds: state.preferences.cooldownSeconds,
          notifications: {
            inbox: true,
            telegram: state.preferences.telegram,
            email: state.preferences.email,
            useDefaults: true,
          },
        });
        setStep(1);
      } else {
        setClarification(result.clarification);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not interpret your draft.",
      );
    } finally {
      setBusy(null);
    }
  }

  // Start interpretation once after the composer draft has hydrated; never on polling/rerenders.
  useEffect(() => {
    if (!auto.current && params.get("review") === "1" && draft && !watch) {
      auto.current = true;
      void interpret();
    }
  }, [draft, params, watch]); // eslint-disable-line react-hooks/exhaustive-deps

  async function activate(asDraft = false) {
    setBusy(asDraft ? "draft" : "activate");
    setError(null);

    try {
      if (!signedIn) {
        auth.login("/new?review=1");

        return;
      }

      const valid = WatchSpecSchema.parse({
        ...spec,
        notifications: spec.notifications.useDefaults
          ? {
              inbox: true,
              telegram: state.preferences.telegram,
              email: state.preferences.email,
              useDefaults: true,
            }
          : spec.notifications,
      });
      const id = await save(
        valid,
        original || DEFAULT_PROMPT,
        watch?.id,
        asDraft,
      );

      persist(null);
      setDraft("");
      router.push(`/watches?created=${id}`);
    } catch (e) {
      setError(
        e instanceof z.ZodError
          ? e.issues.map((i) => i.message).join(" ")
          : e instanceof Error
            ? e.message
            : "Could not save your watch.",
      );
    } finally {
      setBusy(null);
    }
  }

  const connected =
    ((spec.notifications.useDefaults
      ? state.preferences.telegram
      : spec.notifications.telegram) &&
      state.telegram.connected) ||
    ((spec.notifications.useDefaults
      ? state.preferences.email
      : spec.notifications.email) &&
      state.emailConnection.verified &&
      state.emailConnection.enabled &&
      !state.emailConnection.suppressed);

  return (
    <section className="max-w-5xl mx-auto">
      <Link className="detail-back" href="/watches">
        <ArrowLeftIcon />
        Your watches
      </Link>
      <div className="page-heading">
        <div>
          <h1>{watch ? "Adjust your watch" : "Review your watch"}</h1>
          <p>
            {step === 0
              ? "A sentence becomes a precise, editable rule."
              : "Here is exactly what Scout will look for."}
          </p>
        </div>
        <span className="meta-chip">
          {step === 0 ? "1 · Describe" : "2 · Review & activate"}
        </span>
      </div>
      {step === 0 ? (
        <div className="panel space-y-5">
          <label className="block" htmlFor="review-prompt">
            What would you like Scout to watch?
          </label>
          <textarea
            id="review-prompt"
            className={`${inputClassName} min-h-28`}
            maxLength={2000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <ErrorNotice message={error} />
          {clarification && (
            <div className={warningClassName}>{clarification}</div>
          )}
          <div className="flex gap-3 flex-wrap">
            <button
              className={buttonClassName("primary")}
              disabled={!!busy}
              onClick={() => void interpret()}
            >
              {busy ? (
                <Busy label="Interpreting your rule" />
              ) : (
                "Review my watch"
              )}
            </button>
            <button className={buttonClassName()} onClick={() => setStep(1)}>
              Edit exact rule
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_310px] items-start">
          <div className="panel">
            <div className="flex items-center gap-3 mb-6">
              <TokenPair />
              <div>
                <h2>Where to look</h2>
                <p className="text-sm text-neutral-400">
                  Ethereum · Uniswap v3
                </p>
              </div>
            </div>
            <label className="block text-sm mb-2" htmlFor="watch-name">
              Watch name
            </label>
            <input
              className={inputClassName}
              id="watch-name"
              value={spec.name}
              maxLength={72}
              onChange={(e) => change({ name: e.target.value })}
            />
            <div className="rule-section">
              <div className="inline-rule">
                Watch{" "}
                <Select
                  aria-label="Token being sold"
                  value={
                    spec.streamDirection === "either"
                      ? "either"
                      : spec.sellToken
                  }
                  onValueChange={(value) =>
                    change(
                      value === "either"
                        ? { streamDirection: "either" }
                        : { sellToken: value, streamDirection: "selected" },
                    )
                  }
                >
                  <option value="either">Both directions</option>
                  {TOKENS.map((t) => (
                    <option key={t.address} value={t.address}>
                      {t.symbol}
                    </option>
                  ))}
                </Select>{" "}
                sales in
              </div>
              <div className="flex flex-wrap gap-4 mt-3">
                {POOLS.map((pool) => (
                  <label
                    key={pool.address}
                    className="inline-flex gap-2 items-center text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={spec.pools.includes(pool.address)}
                      onChange={(e) =>
                        change({
                          pools: e.target.checked
                            ? [...spec.pools, pool.address]
                            : spec.pools.filter((p) => p !== pool.address),
                        })
                      }
                    />
                    WETH / USDC · {pool.feeLabel}
                  </label>
                ))}
              </div>
            </div>
            {spec.conditions.map((c, i) => (
              <div className="rule-section" key={i}>
                <div className="flex justify-between gap-3 items-center mb-3">
                  <span className="eyebrow">
                    {i === 0
                      ? "Match when"
                      : spec.combine === "all"
                        ? "And also"
                        : "Or when"}
                  </span>
                  <button
                    aria-label={`Remove condition ${i + 1}`}
                    className="p-2 text-neutral-400"
                    onClick={() =>
                      change({
                        conditions: spec.conditions.filter((_, j) => i !== j),
                      })
                    }
                  >
                    <XMarkIcon className="size-4" />
                  </button>
                </div>
                <div className="inline-rule">
                  {c.kind === "aggregate" ? (
                    <p>{c.description}</p>
                  ) : c.kind === "large_swap" ? (
                    <>
                      A sale is above $
                      <input
                        aria-label={`Sale threshold ${i + 1}`}
                        inputMode="decimal"
                        value={c.usd}
                        onChange={(e) => condition(i, { usd: e.target.value })}
                      />
                    </>
                  ) : c.kind === "pool_selling" ? (
                    <>
                      Pool sales exceed $
                      <input
                        aria-label={`Pool threshold ${i + 1}`}
                        inputMode="decimal"
                        value={c.cumulativeUsd}
                        onChange={(e) =>
                          condition(i, { cumulativeUsd: e.target.value })
                        }
                      />
                      in{" "}
                      <input
                        aria-label={`Window minutes ${i + 1}`}
                        type="number"
                        min={1}
                        max={60}
                        value={c.windowSeconds / 60}
                        onChange={(e) =>
                          condition(i, {
                            windowSeconds: Number(e.target.value) * 60,
                          })
                        }
                      />
                      minutes
                    </>
                  ) : (
                    <>
                      <input
                        aria-label={`Transaction count ${i + 1}`}
                        type="number"
                        min={2}
                        max={100}
                        value={c.count ?? ""}
                        onChange={(e) =>
                          condition(i, {
                            count: e.target.value
                              ? Number(e.target.value)
                              : null,
                          })
                        }
                      />
                      transactions from the <strong>same initiator</strong>,
                      each above $
                      <input
                        aria-label={`Minimum sale ${i + 1}`}
                        value={c.minSwapUsd}
                        onChange={(e) =>
                          condition(i, { minSwapUsd: e.target.value })
                        }
                      />
                      in{" "}
                      <input
                        aria-label={`Window minutes ${i + 1}`}
                        type="number"
                        min={1}
                        max={60}
                        value={c.windowSeconds / 60}
                        onChange={(e) =>
                          condition(i, {
                            windowSeconds: Number(e.target.value) * 60,
                          })
                        }
                      />
                      minutes
                      <label className="block text-sm w-full">
                        Or cumulative sales above ${" "}
                        <input
                          aria-label={`Cumulative alternative ${i + 1}`}
                          placeholder="Optional"
                          value={c.cumulativeUsd ?? ""}
                          onChange={(e) =>
                            condition(i, {
                              cumulativeUsd: e.target.value || null,
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
              </div>
            ))}
            <div className="flex gap-3 flex-wrap mt-4">
              {spec.conditions.length < 3 && (
                <Select
                  aria-label="Add condition"
                  className="sort-select"
                  value=""
                  onValueChange={(value) => {
                    const kind = value as Exclude<
                      Condition["kind"],
                      "aggregate"
                    >;

                    change({
                      conditions: [
                        ...spec.conditions,
                        kind === "large_swap"
                          ? { kind, usd: "50000" }
                          : kind === "repeated_selling"
                            ? {
                                kind,
                                minSwapUsd: "50000",
                                count: 3,
                                cumulativeUsd: null,
                                windowSeconds: 900,
                              }
                            : {
                                kind,
                                cumulativeUsd: "500000",
                                windowSeconds: 1800,
                              },
                      ],
                    });
                  }}
                >
                  <option value="" disabled>
                    Add condition
                  </option>
                  <option value="large_swap">Large sale</option>
                  <option value="repeated_selling">Repeated selling</option>
                  <option value="pool_selling">Pool total</option>
                </Select>
              )}
              {spec.conditions.length > 1 && (
                <Select
                  className="sort-select"
                  aria-label="Combine conditions"
                  value={spec.combine}
                  onValueChange={(value) =>
                    change({ combine: value as "all" | "any" })
                  }
                >
                  <option value="all">Match all · AND</option>
                  <option value="any">Match any · OR</option>
                </Select>
              )}
            </div>
            <div className="rule-section">
              <h3>Observed initiator, not assumed ownership</h3>
              <p className="text-sm text-neutral-400 mt-2">
                Same-address rules use attributable EOA transaction initiators.
                A router caller is not treated as the owner. Routed activity and
                asset ownership may remain unknown.
              </p>
              <label className="mt-5 block text-sm">
                Group related activity in{" "}
                <Select
                  aria-label="Incident grouping window"
                  className="sort-select ml-2"
                  value={spec.cooldownSeconds}
                  onValueChange={(value) =>
                    change({ cooldownSeconds: Number(value) })
                  }
                >
                  {[300, 900, 1800, 3600].map((s) => (
                    <option key={s} value={s}>
                      {s / 60} minutes
                    </option>
                  ))}
                </Select>
              </label>
              <p className="text-[13px] text-neutral-400 mt-2">
                One first alert per initiator (or pool) per fixed UTC bucket.
                Later matches update the same incident. New buckets can alert
                again.
              </p>
            </div>
            <div className="rule-section">
              <h3>A bounded look back</h3>
              <p className="text-sm text-neutral-400 mt-2">
                Preview the rule against recent Graph activity verified with
                finalized receipts and at-block oracle values. This sample is
                not a complete backtest.
              </p>
              <button
                className={buttonClassName("default", "mt-4")}
                disabled={!!busy}
                onClick={async () => {
                  setBusy("preview");
                  setPreviewError(null);

                  try {
                    setPreview(
                      await api("/api/preview", Preview, {
                        method: "POST",
                        body: WatchSpecSchema.parse(spec),
                      }),
                    );
                  } catch (e) {
                    setPreviewError(
                      e instanceof Error ? e.message : "Preview unavailable.",
                    );
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "preview" ? (
                  <Busy label="Querying historical evidence" />
                ) : (
                  "Preview recent activity"
                )}
              </button>
              <ErrorNotice message={previewError} />
              {preview && (
                <div className="connection-note">
                  <strong>
                    {preview.verified.matches.length} matches in{" "}
                    {preview.verified.verifiedEvents} verified events
                  </strong>
                  <p>{preview.note}</p>
                  <p>
                    Range {dateTime(preview.from)} – {dateTime(preview.to)}.
                    Refreshed {dateTime(preview.refreshedAt)}. Indexed block{" "}
                    {preview.block.number}. {preview.verified.unavailable}{" "}
                    checks unavailable.
                  </p>
                  {preview.verified.matches.map((m, i) => (
                    <p key={i}>
                      {usd(m.totalUsdMicros)} · {m.transactionCount}{" "}
                      transactions · {dateTime(m.timestamp)}
                    </p>
                  ))}
                </div>
              )}
            </div>
            <details>
              <summary className="text-sm">Sources & safeguards</summary>
              <p className="text-sm text-neutral-400">
                Finalized blocks only. Chainlink USD valuation at the event
                block; unvalued events are excluded. Conditions evaluate
                separately per pool. Distinct transactions are counted once, and
                routed hops across pools are not added together. Finality adds
                latency.
              </p>
            </details>
          </div>
          <aside className="panel lg:sticky lg:top-6">
            <h2>Ready to watch</h2>
            <p
              className="text-sm text-neutral-300 mt-4"
              data-testid="rules-summary"
            >
              {WatchSpecSchema.safeParse(spec).success
                ? describeSpec(spec)
                : "Complete the rule fields to continue."}
            </p>
            <div className="mt-6 border-t border-white/8 pt-5">
              <h3>Alert destinations</h3>
              <label className="flex gap-2 items-center text-sm mt-3">
                <input
                  type="checkbox"
                  checked={spec.notifications.useDefaults}
                  onChange={(e) =>
                    change({
                      notifications: {
                        ...spec.notifications,
                        useDefaults: e.target.checked,
                      },
                    })
                  }
                />
                Use account defaults
              </label>
              {(["telegram", "email"] as const).map((channel) => (
                <label
                  className="flex gap-2 items-center text-sm mt-3"
                  key={channel}
                >
                  <input
                    type="checkbox"
                    checked={
                      spec.notifications.useDefaults
                        ? state.preferences[channel]
                        : spec.notifications[channel]
                    }
                    disabled={spec.notifications.useDefaults}
                    onChange={(e) =>
                      change({
                        notifications: {
                          ...spec.notifications,
                          [channel]: e.target.checked,
                        },
                      })
                    }
                  />
                  {channel === "telegram" ? "Telegram" : "Email"}
                </label>
              ))}
              <Modal
                title="Connect your alerts"
                description="Verify a destination before activating this watch."
                trigger={
                  <button className={buttonClassName("default", "mt-4")}>
                    Manage connections
                  </button>
                }
              >
                <ConnectionControls />
              </Modal>
              {!connected && (
                <p className="card-notice">
                  Connect and enable at least one verified destination to
                  activate. You can save a draft now.
                </p>
              )}
            </div>
            <p className="text-[13px] text-neutral-400 mt-5">
              <ShieldCheckIcon className="size-4 inline mr-1" />
              {watch && watch.status !== "draft"
                ? "Your current version keeps watching until the replacement is validated and ready."
                : "The card shows real preparation progress. Watching begins only after the worker confirms readiness."}
            </p>
            <ErrorNotice message={error} />
            <button
              className={buttonClassName("primary", "w-full mt-5")}
              disabled={!!busy || !connected}
              onClick={() => void activate()}
            >
              {busy === "activate" ? (
                <Busy label="Saving watch" />
              ) : (
                <>
                  {watch && watch.status !== "draft"
                    ? "Save replacement"
                    : "Activate watch"}
                  <ArrowRightIcon className="size-4" />
                </>
              )}
            </button>
            {(!watch || watch.status === "draft") && (
              <button
                className={buttonClassName("quiet", "w-full mt-2")}
                disabled={!!busy}
                onClick={() => void activate(true)}
              >
                {busy === "draft" ? (
                  <Busy label="Saving draft" />
                ) : (
                  "Save as draft"
                )}
              </button>
            )}
            <Link
              className="block text-center mt-4 text-[13px] text-neutral-400"
              href="/watches"
            >
              Back to watches
            </Link>
          </aside>
        </div>
      )}
    </section>
  );
}

export function WatchEditor() {
  const id = useSearchParams().get("edit");
  const { state, signedIn } = useWorkspace();
  const query = useWatch(id, signedIn);
  const watch = query.data ?? state.watches.find((w) => w.id === id);

  if (id && !watch) {
    return (
      <div>
        <h1>Watch not available</h1>
        <ErrorNotice message={query.error?.message} />
        <SignInButton
          destination={`/new?edit=${id}`}
          className={buttonClassName("primary", "mt-5")}
        >
          Sign in to the owning account
        </SignInButton>
      </div>
    );
  }

  return <RuleEditor key={id ?? "new"} watch={watch} />;
}
