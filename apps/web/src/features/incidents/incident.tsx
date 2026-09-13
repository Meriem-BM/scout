"use client";

import {
  ArrowUpRight as ArrowUpRightIcon,
  CircleCheck as CheckCircleIcon,
  Database as CircleStackIcon,
  Users as UserGroupIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";

import { ExplanationSchema, tokenByAddress, usd } from "@scout/domain";

import { ServiceIcon } from "../connections/connections";
import { useWatchAction } from "../watches/mutations";
import { api } from "../workspace/api";
import { useDateTime } from "../workspace/formatting";
import {
  buttonClassName,
  inputClassName,
  noticeClassName,
  warningClassName,
} from "../workspace/primitives";
import { EvidenceSceneSkeleton } from "../workspace/skeletons";
import { Busy, ErrorNotice, Status } from "../workspace/ui";

import type { Delivery, Incident } from "@scout/domain";

const EvidenceScene = dynamic(() => import("./evidence-scene"), {
  loading: () => <EvidenceSceneSkeleton />,
});

export function DeliveryHistory({ deliveries }: { deliveries: Delivery[] }) {
  const dateTime = useDateTime();

  return (
    <section className="mt-7">
      <h3>Delivery</h3>
      {deliveries.length ? (
        deliveries.map((d) => (
          <div className="connection-detail-row" key={d.id}>
            <ServiceIcon service={d.channel} />
            <div>
              <h3>{d.channel === "telegram" ? "Telegram" : "Email"}</h3>
              <p>
                {d.destination ?? "Connected private chat"} ·{" "}
                {dateTime(d.createdAt)}
              </p>
              {d.error && <p className="tone-error">{d.error}</p>}
              <p>
                {d.status === "delivered"
                  ? "Confirmed by signed provider event: recipient mail server accepted the email."
                  : d.status === "sent"
                    ? "Provider accepted this alert. Human receipt is not confirmed."
                    : d.status === "ambiguous"
                      ? "Send result is unknown. Check the destination before retrying."
                      : `Delivery ${d.status}.`}
              </p>
            </div>
            <Status status={d.status} />
          </div>
        ))
      ) : (
        <p className="text-sm text-neutral-400 mt-2">
          No external delivery was queued for this incident. It remains in watch
          history.
        </p>
      )}
    </section>
  );
}

export function Investigation({
  incident,
  deliveries = [],
}: {
  incident: Incident;
  deliveries?: Delivery[];
}) {
  const dateTime = useDateTime();
  const watchAction = useWatchAction();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const context = incident.context;
  const token = tokenByAddress(incident.spec.sellToken);
  const participantCount = new Set(
    incident.evidence.map((event) => event.initiator),
  ).size;

  return (
    <section className="investigation-panel">
      <div className="evidence-heading">
        <div>
          <span className="eyebrow">
            {context ? "Detected event" : "Gathering historical context"} ·{" "}
            {dateTime(incident.createdAt)}
          </span>
          <h2>
            {incident.title === "A sale crossed your threshold"
              ? "A qualifying event matched this Watch"
              : incident.title}
          </h2>
          <p>Finalized onchain evidence matched this Watch.</p>
        </div>
        <Status
          status={
            incident.status === "retracted"
              ? "retracted"
              : context?.status === "available"
                ? "evidence ready"
                : context
                  ? "partial context"
                  : "gathering context"
          }
        />
      </div>
      <dl className="incident-summary-strip">
        <div>
          <dt>Observed value</dt>
          <dd>{usd(incident.detection.totalUsdMicros)}</dd>
          <span>
            {incident.spec.streamDirection === "either"
              ? "Swap volume · both directions"
              : `${token.symbol} selling`}
          </span>
        </div>
        <div>
          <dt>Transactions</dt>
          <dd>{incident.detection.transactionCount}</dd>
          <span>Distinct qualifying swaps</span>
        </div>
        <div>
          <dt>Participants</dt>
          <dd>{participantCount || "Not available"}</dd>
          <span>Observed initiators</span>
        </div>
      </dl>
      {incident.status === "retracted" && (
        <p className={`${warningClassName} mb-5`}>
          This evidence was retracted following a chain inconsistency. The
          original match must not be treated as established.
        </p>
      )}
      <div className="investigation-analysis">
        <section>
          <div className="analysis-heading">
            <span aria-hidden="true">
              <CheckCircleIcon />
            </span>
            <div>
              <small>Deterministic rule</small>
              <h3>Why this Watch matched</h3>
            </div>
          </div>
          {incident.detection.matches.map((m, i) => (
            <div className="match-row" key={i}>
              <CheckCircleIcon
                className={m.matched ? "tone-success" : "text-neutral-400"}
              />
              <div>
                <strong>{m.rule}</strong>
                <p>
                  Observed {usd(m.observedUsdMicros)} across {m.observedCount}{" "}
                  transactions · {m.matched ? "Matched" : "Not matched"}
                </p>
                {m.aggregation?.baseline !== null &&
                  m.aggregation?.baseline !== undefined && (
                    <details>
                      <summary>Baseline evidence</summary>
                      <p>
                        Preceding-window total:{" "}
                        {incident.spec.conditions.some(
                          (condition) =>
                            condition.kind === "aggregate" &&
                            condition.rule.id === m.aggregation?.ruleId &&
                            condition.rule.aggregate.operation === "sum",
                        )
                          ? usd(m.aggregation.baseline)
                          : m.aggregation.baseline}
                        . The comparison normalizes both windows by their
                        duration.
                      </p>
                      <p>
                        {m.aggregation.baselineEvidenceIds.length} baseline
                        events; {m.aggregation.baselineEvidence?.length ?? 0}{" "}
                        evidence records retained
                        {m.aggregation.baselineEvidenceComplete === false
                          ? " (partial evidence sample)"
                          : ""}
                        .
                      </p>
                      <div className="max-h-64 overflow-auto break-all">
                        {m.aggregation.baselineEvidence?.map((event) => (
                          <p key={event.id}>
                            Block {event.blockNumber} · {event.transactionHash}{" "}
                            · log {event.logIndex}
                          </p>
                        ))}
                      </div>
                    </details>
                  )}
              </div>
            </div>
          ))}
          <p className="analysis-note">
            Conditions combine with{" "}
            {incident.spec.combine === "all" ? "AND" : "OR"}. Values describe
            gross swap input value in this pool. Net flow and liquidity removal
            are not measured here.
          </p>
        </section>
        <section>
          <div className="analysis-heading">
            <span aria-hidden="true">
              <CircleStackIcon />
            </span>
            <div>
              <small>The Graph</small>
              <h3>Historical context</h3>
            </div>
          </div>
          {context ? (
            <>
              <p className="analysis-lead">{context.note}</p>
              <dl className="context-facts">
                <div>
                  <dt>Coverage</dt>
                  <dd>{context.status}</dd>
                </div>
                <div>
                  <dt>Swaps sampled</dt>
                  <dd>{context.sampledSwaps}</dd>
                </div>
                <div>
                  <dt>Range</dt>
                  <dd>
                    {dateTime(context.from)} – {dateTime(context.to)}
                  </dd>
                </div>
                <div>
                  <dt>Refreshed</dt>
                  <dd>{dateTime(context.refreshedAt)}</dd>
                </div>
              </dl>
              {context.priorInitiatorTransactions !== null && (
                <div className="context-participant-note">
                  <UserGroupIcon aria-hidden="true" />
                  <p>
                    {context.priorInitiatorTransactions} prior initiator
                    transactions in this bounded sample.
                  </p>
                </div>
              )}
            </>
          ) : (
            <p>
              Historical enrichment is pending or unavailable. The deterministic
              transaction evidence remains available.
            </p>
          )}
        </section>
      </div>
      <section className="scout-significance">
        <h3>Why Scout flagged it</h3>
        {incident.explanation ? (
          <>
            <p>{incident.explanation.interpretation}</p>
            <p className="support-note">
              Scout’s interpretation of the recorded evidence; it does not
              establish wallet ownership or motive.
            </p>
          </>
        ) : (
          <p>
            No contextual conclusion is recorded yet. The deterministic match
            above explains the detection; historical enrichment may still be
            incomplete.
          </p>
        )}
      </section>
      <EvidenceScene incident={incident} />
      <details className="investigation-disclosure">
        <summary>Evidence & limits</summary>
        <div className="context-grid !mt-2">
          <div>
            <h3>Known</h3>
            {incident.explanation?.facts.map((f, i) => (
              <p key={i}>{f.text}</p>
            )) ?? (
              <p>
                The recorded events satisfy the displayed conditions. Amounts
                use the sale side only and at-block oracle values.
              </p>
            )}
            <h3 className="mt-4">Inferred</h3>
            <p>
              {incident.explanation?.interpretation ??
                "A rule match describes observed activity. It does not establish motive or predict a price move."}
            </p>
          </div>
          <div>
            <h3>Unknown</h3>
            {(
              incident.explanation?.unknowns ?? [
                "The initiator may not be the economic owner.",
                "Routing outside the observed pool events is not reconstructed.",
              ]
            ).map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </div>
      </details>
      <details className="investigation-disclosure">
        <summary>Sources</summary>
        <p className="text-sm text-neutral-400">
          Finalized Ethereum events · Chainlink valuation at event block.{" "}
          {context
            ? `Subgraph ${context.subgraphId} · deployment ${context.deployment ?? "unavailable"} · indexed block ${context.blockNumber ?? "unavailable"}`
            : "Graph enrichment not yet available."}
        </p>
        <div className="space-y-3 mt-4">
          {incident.evidence.map((e) => (
            <details key={e.id} className="text-[13px]">
              <summary>
                {e.transactionHash.slice(0, 14)}… · log {e.logIndex}
              </summary>
              <dl className="grid grid-cols-[100px_1fr] gap-2 [&_dd]:break-all text-neutral-400">
                <dt>Identity</dt>
                <dd>{e.id}</dd>
                <dt>Pool caller</dt>
                <dd>{e.poolCaller}</dd>
                <dt>Recipient</dt>
                <dd>{e.recipient}</dd>
                <dt>Block hash</dt>
                <dd>{e.blockHash}</dd>
                <dt>Attribution</dt>
                <dd>{e.attributionReason}</dd>
                <dt>Oracle feed</dt>
                <dd>{e.valuation?.feed ?? "Unavailable"}</dd>
                <dt>Oracle round</dt>
                <dd>{e.valuation?.roundId ?? "Unavailable"}</dd>
              </dl>
            </details>
          ))}
        </div>
      </details>
      <details className="investigation-disclosure">
        <summary>
          Delivery ·{" "}
          {deliveries.length
            ? `${deliveries.length} delivery records`
            : "No external delivery"}
        </summary>
        <DeliveryHistory deliveries={deliveries} />
      </details>
      <div className="flex flex-wrap gap-2 mt-6 pt-5 border-t border-white/8">
        <Link
          className={buttonClassName()}
          href={`/new?edit=${incident.watchId}`}
        >
          Adjust watch
        </Link>
        <button
          className={buttonClassName()}
          disabled={busy}
          onClick={async () => {
            setBusy(true);

            try {
              await watchAction(incident.watchId, "mute");
              setAnswer(
                "Watch alerts muted for one hour. Monitoring continues.",
              );
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not mute watch.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Mute alerts 1 hour
        </button>
        <Link
          className={buttonClassName("quiet", "ml-auto")}
          href={`/swap?incident=${incident.id}`}
        >
          Review a swap <ArrowUpRightIcon className="size-4" />
        </Link>
      </div>
      <details className="mt-4">
        <summary>Ask about this evidence</summary>
        <form
          className="flex gap-2 mt-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);

            try {
              const result = await api(
                "/api/investigate",
                z.object({
                  explanation: ExplanationSchema,
                  note: z.string().nullable(),
                }),
                { method: "POST", body: { id: incident.id, question } },
              );

              setAnswer(
                [
                  result.note,
                  ...result.explanation.facts.map((f) => f.text),
                  result.explanation.interpretation,
                  ...result.explanation.unknowns,
                ]
                  .filter(Boolean)
                  .join(" "),
              );
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Investigation unavailable.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            className={inputClassName}
            aria-label="Question about the incident"
            placeholder="What can this evidence tell me?"
            value={question}
            maxLength={1000}
            onChange={(e) => setQuestion(e.target.value)}
            required
          />
          <button className={buttonClassName()} disabled={busy}>
            {busy ? <Busy /> : "Ask"}
          </button>
        </form>
      </details>
      <ErrorNotice message={error} />
      {answer && (
        <p className={`${noticeClassName} mt-3`} role="status">
          {answer}
        </p>
      )}
    </section>
  );
}
