"use client";

import {
  ArrowDownRight as ArrowDownRightIcon,
  ArrowUpRight as ArrowUpRightIcon,
  Clock as ClockIcon,
  Radio as SignalIcon,
} from "lucide-react";
import Link from "next/link";

import {
  poolByAddress,
  protocolLabel,
  protocolName,
  protocolProfileForIntent,
  unavailableIntentCapability,
  usd,
  watchHealth,
} from "@scout/domain";

import { ConnectionPopover } from "../connections/connections";
import { useClock } from "../workspace/clock";
import { useDateTime } from "../workspace/formatting";
import { ProtocolMark } from "../workspace/protocol-mark";
import { TokenPair } from "../workspace/scope";
import { Status } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { RuleSummary, WatchManagement } from "./management";

import type { Incident, Watch } from "@scout/domain";

function Activity({
  watch,
  incidents,
}: {
  watch: Watch;
  incidents: Incident[];
}) {
  const dateTime = useDateTime();
  const latest = incidents[0];
  const end = latest ? Date.parse(latest.createdAt) : 0;
  const bins = Array.from({ length: 32 }, () => 0);

  for (const incident of incidents) {
    const delta = end - Date.parse(incident.createdAt);

    if (delta >= 0 && delta <= 15 * 60_000) {
      bins[Math.min(31, Math.floor((1 - delta / (15 * 60_000)) * 32))]! += 1;
    }
  }

  const max = Math.max(...bins, 1);
  const context = watchContext(watch);
  const preparing = [
    "preparing",
    "checking",
    "starting",
    "backfilling",
  ].indexOf(watch.status);

  return (
    <div className="watch-preview" data-kind={latest ? "incident" : "quiet"}>
      <div className="preview-context">
        <span>
          {context.showPair ? (
            <TokenPair />
          ) : (
            <span className="protocol-glyph" aria-hidden="true">
              <SignalIcon />
            </span>
          )}
          {context.subject}
        </span>
        <span>
          <ProtocolMark
            protocol={
              watch.spec?.protocol ?? watch.intent?.subject.protocol?.value
            }
            size={18}
          />
          {latest
            ? `Uniswap V3 · ${poolByAddress(latest.detection.pool).feeLabel}`
            : context.scope}
        </span>
      </div>
      {latest ? (
        <>
          <div className="preview-reading">
            <div>
              <span>Latest matched event</span>
              <strong>{usd(latest.detection.totalUsdMicros)}</strong>
            </div>
            <span className="preview-count">
              {latest.detection.transactionCount} qualifying{" "}
              {latest.detection.transactionCount === 1
                ? "transaction"
                : "transactions"}
            </span>
          </div>
          <div
            className="preview-timeline"
            role="img"
            aria-label={`${bins.reduce((a, b) => a + b, 0)} recorded incidents in the 15 minutes ending ${dateTime(latest.createdAt)}; up to six recent incidents loaded.`}
          >
            <div className="activity-bars" aria-hidden="true">
              {bins.map((count, index) => (
                <span
                  key={index}
                  data-empty={!count}
                  style={{
                    height: count ? `${6 + (count / max) * 20}px` : "2px",
                  }}
                />
              ))}
            </div>
            <div className="chart-caption">
              <span>Recent incidents · 15 min</span>
              <span>Up to 6 recorded</span>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="preview-empty">
            <div>
              <strong>
                {preparing >= 0
                  ? [
                      "Preparing your watch",
                      "Validating the sources",
                      "Starting the worker",
                      "Catching up to finalized blocks",
                    ][preparing]
                  : watch.status === "draft"
                    ? "Ready for your review"
                    : watch.status === "paused"
                      ? "Monitoring paused"
                      : watch.status === "archived"
                        ? "Watch archived"
                        : watch.status === "failed"
                          ? "Preparation needs attention"
                          : [
                                "watching",
                                "live",
                                "delayed",
                                "degraded",
                              ].includes(watch.status)
                            ? "Listening for a match"
                            : "Monitoring has not started"}
              </strong>
              <p>
                {watch.lastBlock
                  ? `Last processed block ${Number(watch.lastBlock).toLocaleString("en")}`
                  : watch.status === "draft"
                    ? "Your rule is saved. Activate when you're ready."
                    : "Activity will appear when data arrives."}
              </p>
            </div>
          </div>
          {preparing >= 0 && (
            <div
              className="steps-line"
              aria-label={`Activation: ${["preparing", "validating", "starting", "backfilling"][preparing]}`}
            >
              {["Preparing", "Validating", "Starting"].map((label, index) => (
                <span
                  key={label}
                  title={label}
                  data-done={index <= Math.min(preparing, 2)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

function watchContext(watch: Watch) {
  if (watch.spec?.protocol === "uniswap_v3") {
    return {
      network: "Ethereum mainnet",
      scope: `Uniswap V3 · ${watch.spec.pools
        .map((pool) => poolByAddress(pool).feeLabel)
        .join(" + ")}`,
      showPair: true,
      subject: "WETH / USDC",
    };
  }

  if (watch.intent) {
    const profile = protocolProfileForIntent(watch.intent);
    const tokens = watch.intent.subject.tokens.map((token) => token.value);
    const wallet = watch.intent.subject.wallets[0]?.value;
    const subject = tokens.length
      ? tokens.join(" / ")
      : wallet
        ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
        : titleCase(watch.intent.activity.type.value);
    const network = watch.intent.subject.chain?.value;

    return {
      network: network ? titleCase(network) : "Network being resolved",
      scope: `${
        watch.intent.subject.protocol?.value
          ? [
              protocolName(watch.intent.subject.protocol.value),
              watch.intent.subject.protocolVersion?.value
                .replace(/^uniswap[_ -]?/i, "")
                .toUpperCase(),
            ]
              .filter(Boolean)
              .join(" ")
          : protocolLabel(profile, watch.intent.subject.protocolVersion?.value)
      } · ${titleCase(watch.intent.activity.type.value)}`,
      showPair:
        profile.presentation.subjectVisual === "pair" &&
        tokens.some((token) => /^(?:W?ETH)$/i.test(token)) &&
        tokens.some((token) => /^USDC$/i.test(token)),
      subject,
    };
  }

  return {
    network: "Network being resolved",
    scope: "Resolving protocol and activity",
    showPair: false,
    subject: "Onchain intent",
  };
}

export function WatchCard({
  watch,
  recentIncidents,
}: {
  watch: Watch;
  recentIncidents?: Incident[];
}) {
  const dateTime = useDateTime();
  const { state } = useWorkspace();
  const now = useClock();
  const health = watchHealth(watch, state, now);
  const incidents = (recentIncidents ?? state.incidents)
    .filter((i) => i.watchId === watch.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = incidents[0];
  const context = watchContext(watch);

  return (
    <article
      className="watch-card"
      data-testid="watch-card"
      data-lifecycle={watch.status}
    >
      <Activity watch={watch} incidents={incidents} />
      <div className="watch-card-main">
        <div className="watch-identity">
          <div className="min-w-0 flex-1">
            <h2>
              <Link href={`/watches/${watch.id}`}>{watch.name}</Link>
            </h2>
            <p>{context.network}</p>
          </div>
          <div className="status-wrap">
            <Status status={health.operation} />
          </div>
        </div>
        <p className="watch-rule">
          <RuleSummary watch={watch} />
        </p>
        <div className="latest-outcome">
          <span className="outcome-icon">
            {latest ? <ArrowDownRightIcon /> : <ClockIcon />}
          </span>
          <div>
            {latest ? (
              <>
                <Link
                  href={`/watches/${watch.id}/incidents/${latest.id}`}
                  className="hover:text-[#927fff]"
                >
                  {latest.title === "A sale crossed your threshold"
                    ? "A qualifying event matched this Watch"
                    : latest.title}
                </Link>
                <p>{dateTime(latest.createdAt)}</p>
                {latest.context && (
                  <p>
                    Scout context · {latest.context.sampledSwaps} historical
                    swaps · {latest.context.status}
                  </p>
                )}
              </>
            ) : (
              <>
                <span>
                  {watch.status === "draft"
                    ? "Draft saved"
                    : watch.status === "paused"
                      ? "Your rule and history are preserved"
                      : health.preparing
                        ? "Activation is in progress"
                        : "No matching incidents recorded"}
                </span>
                <p>
                  {watch.lastBlockTime
                    ? `Data received ${dateTime(watch.lastBlockTime)}`
                    : "A match will appear here when there is evidence."}
                </p>
              </>
            )}
          </div>
        </div>
        {(health.needsAttention || health.muted) && (
          <p className="card-notice">
            {(watch.intent &&
              unavailableIntentCapability(watch.intent)?.message) ??
              (watch.error
                ? watch.status === "failed"
                  ? "Scout could not complete this Watch. Open details for the missing condition or next step."
                  : "Monitoring needs attention. Open details for the current connection and recovery status."
                : null) ??
              (health.data === "Delayed"
                ? `Data delayed. Last received ${watch.lastBlockTime ? dateTime(watch.lastBlockTime) : "not yet"}. Check watch health.`
                : health.muted
                  ? "Alerts muted. Monitoring continues."
                  : `Alerts: ${health.delivery.toLowerCase()}. Monitoring is independent of delivery.`)}
          </p>
        )}
      </div>
      <div className="watch-card-footer">
        {watch.spec ? (
          <ConnectionPopover watch={watch} />
        ) : (
          <span className="workflow-card-destinations">
            Destinations after planning
          </span>
        )}
        <Link href={`/watches/${watch.id}`}>
          Details <ArrowUpRightIcon />
        </Link>
        <WatchManagement watch={watch} />
      </div>
    </article>
  );
}
