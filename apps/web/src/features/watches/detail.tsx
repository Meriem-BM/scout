"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft as ArrowLeftIcon,
  ArrowUpRight as ArrowUpRightIcon,
  Zap as BoltIcon,
  Database as CircleStackIcon,
  Clock as ClockIcon,
  Search as MagnifyingGlassIcon,
  Radio as SignalIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod";

import {
  describeSpec,
  IncidentSchema,
  scopeLabel,
  usd,
  watchHealth,
} from "@scout/domain";
import { queryKeys } from "@/lib/query/keys";

import { SignInButton } from "../account/sign-in-button";
import { Flow } from "../communication/flow";
import { ConnectionPopover } from "../connections/connections";
import { Investigation } from "../incidents/incident";
import { useIncident } from "../incidents/queries";
import { WatchCreationWorkflow } from "../workflow/watch-workflow";
import { api } from "../workspace/api";
import { useClock } from "../workspace/clock";
import { useDateTime } from "../workspace/formatting";
import { buttonClassName, noticeClassName } from "../workspace/primitives";
import { TokenPair } from "../workspace/scope";
import { Select } from "../workspace/select";
import {
  InvestigationListSkeleton,
  InvestigationSkeleton,
  PipelineSkeleton,
  WatchDetailSkeleton,
} from "../workspace/skeletons";
import { ErrorNotice, Status } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { WatchManagement } from "./management";
import { useWatchAction } from "./mutations";
import { useWatch, useWorkflowQuery } from "./queries";

export function WatchDetail({
  id,
  incidentId,
}: {
  id: string;
  incidentId?: string;
}) {
  const dateTime = useDateTime();
  const router = useRouter();
  const { state, signedIn } = useWorkspace();
  const watchAction = useWatchAction();
  const now = useClock();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const wq = useWatch(id, signedIn);
  const watch = wq.data ?? state.watches.find((w) => w.id === id);
  const workflow = useWorkflowQuery(id, signedIn && !!watch?.workflowId);
  const history = useQuery({
    queryKey: queryKeys.history(id, query, filter, page),
    queryFn: () =>
      api(
        `/api/watches/history?watch=${id}&q=${encodeURIComponent(query)}&status=${filter}&offset=${page * 20}`,
        z.array(IncidentSchema),
      ),
    enabled: signedIn,
    placeholderData: (old) => old,
    refetchInterval: 10_000,
  });
  const all = history.data ?? [];
  const cachedIncident = state.incidents
    .filter((incident) => incident.watchId === id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const selectedId =
    incidentId ??
    all[0]?.id ??
    (query || filter !== "all" ? null : cachedIncident?.id) ??
    null;
  const selected = useIncident(selectedId);

  if (!watch && wq.isLoading) {
    return <WatchDetailSkeleton />;
  }

  if (!watch) {
    return (
      <section>
        <h1>{wq.isLoading ? "Loading watch" : "Watch not available"}</h1>
        <p className="mt-3 text-neutral-400">
          Sign in to the account that owns this watch. Its history is private.
        </p>
        <ErrorNotice message={wq.error?.message} />
        <SignInButton
          className={buttonClassName("primary", "mt-5")}
          destination={`/watches/${id}${incidentId ? "/incidents/" + incidentId : ""}`}
        >
          Sign in to continue
        </SignInButton>
      </section>
    );
  }

  if (watch.workflowId && watch.workflowStage !== "LIVE") {
    return <WatchCreationWorkflow watch={watch} />;
  }

  if (!watch.spec || watch.spec.protocol !== "uniswap_v3") {
    return <WatchCreationWorkflow watch={watch} />;
  }

  const health = watchHealth(watch, state, now);
  const pipeline = workflow.data?.outputs.pipelinePlan;
  const verification = workflow.data?.outputs.verification;
  const rows = all.slice(0, 20);
  const more = all.length > 20;
  const largestIncident = rows.reduce((largest, incident) => {
    const amount = BigInt(incident.detection.totalUsdMicros);

    return amount > largest ? amount : largest;
  }, 0n);

  return (
    <>
      <header className="watch-object-header">
        <Link
          className="detail-back"
          href="/watches"
          onClick={(e) => {
            try {
              const previous = sessionStorage.getItem("scout.collection");

              if (previous?.startsWith("/watches?")) {
                e.preventDefault();
                router.push(previous, { scroll: false });
              }
            } catch {
              /* Follow the normal collection link without device state. */
            }
          }}
        >
          <ArrowLeftIcon />
          Your watches
        </Link>
        <div className="detail-header">
          <TokenPair />
          <div className="detail-title">
            <div className="detail-title-line">
              <h1>{watch.name}</h1>
              <Status status={health.operation} />
            </div>
            <p>{scopeLabel(watch.spec)}</p>
            <p className="detail-subtitle">{describeSpec(watch.spec)}</p>
          </div>
          <div className="detail-controls">
            <Link className={buttonClassName()} href={`/new?edit=${id}`}>
              Edit rule
            </Link>
            <WatchManagement watch={watch} />
          </div>
        </div>
      </header>
      <div className="watch-overview-grid">
        <section
          className="watch-definition"
          aria-labelledby="watch-definition"
        >
          <div className="watch-definition-heading">
            <div>
              <span className="eyebrow">Watch definition</span>
              <h2 id="watch-definition">Built from your intent</h2>
            </div>
            <span className="watch-definition-version">
              Version {watch.version}
            </span>
          </div>
          <blockquote className="watch-original-intent">
            {watch.prompt}
          </blockquote>
          <dl className="watch-definition-grid">
            <div>
              <dt>Protocol</dt>
              <dd>Uniswap V3</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Ethereum</dd>
            </div>
            <div>
              <dt>Pair</dt>
              <dd>WETH / USDC</dd>
            </div>
            <div className="watch-definition-rule">
              <dt>Rule</dt>
              <dd>{describeSpec(watch.spec)}</dd>
            </div>
            <div>
              <dt>Attribution</dt>
              <dd>Transaction initiator</dd>
            </div>
            <div>
              <dt>Investigation</dt>
              <dd>
                {watch.spec.investigation.requireNoPriorUniswapSwaps
                  ? "Previous Uniswap activity"
                  : "Recent pool context"}
              </dd>
            </div>
          </dl>
          <details className="pipeline-disclosure">
            <summary>
              <span className="pipeline-summary-icon" aria-hidden="true">
                <CircleStackIcon />
              </span>
              <span>
                <strong>Pipeline & verification ↗</strong>
                <small>
                  {pipeline?.strategy ??
                    (workflow.isLoading
                      ? "Loading pipeline"
                      : "Plan not recorded")}{" "}
                  · The Graph Substreams
                  {verification ? ` · ${verification.status}` : ""}
                </small>
              </span>
              <Status
                status={
                  watch.status === "paused"
                    ? "Paused"
                    : watch.status === "watching" || watch.status === "live"
                      ? "Streaming"
                      : health.operation
                }
              />
            </summary>
            {workflow.isLoading ? (
              <PipelineSkeleton />
            ) : (
              <dl className="pipeline-details">
                <div>
                  <dt>Reused package</dt>
                  <dd>
                    {pipeline?.dependencies.length
                      ? pipeline.dependencies
                          .map((item) => `${item.packageRef} / ${item.module}`)
                          .join(" · ")
                      : "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt>Scout modules</dt>
                  <dd>
                    {pipeline
                      ? pipeline.generatedModules.length
                        ? pipeline.generatedModules
                            .map((item) => item.name)
                            .join(" · ")
                        : "None"
                      : "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt>Verification</dt>
                  <dd>
                    {verification
                      ? `${verification.status} · ${verification.referenceSource}`
                      : "No workflow verification record"}
                  </dd>
                </div>
              </dl>
            )}
            {verification && (
              <p className="pipeline-evidence-summary">
                Historical test: {verification.execution.blocksTested} blocks ·{" "}
                {verification.execution.eventsObserved} observed events.{" "}
                {verification.findings.join(" ")}
              </p>
            )}
            <Link
              className={buttonClassName("quiet")}
              href={`/proof/${watch.id}`}
            >
              Packages, sources & verification evidence ↗
            </Link>
          </details>
        </section>
        <aside className="watch-health-panel" aria-labelledby="watch-health">
          <div className="watch-health-heading">
            <div>
              <span className="eyebrow">Current state</span>
              <h2 id="watch-health">Watch health</h2>
            </div>
            <Status status={health.operation} />
          </div>
          <div className="health-row">
            <div>
              <span className="health-icon" aria-hidden="true">
                <ClockIcon />
              </span>
              <span>
                <small>Data</small>
                <strong
                  className={health.data === "Delayed" ? "tone-warning" : ""}
                >
                  {health.data}
                  {watch.lastBlockTime
                    ? ` · ${dateTime(watch.lastBlockTime)}`
                    : ""}
                </strong>
              </span>
            </div>
            <div>
              <span className="health-icon" aria-hidden="true">
                <BoltIcon />
              </span>
              <span>
                <small>Operation</small>
                <strong>
                  {watch.status === "draft"
                    ? "Draft · not activated"
                    : health.preparing
                      ? "Preparing and validating"
                      : watch.status === "paused"
                        ? "Paused by you"
                        : `Version ${watch.version} · ${health.operation}`}
                </strong>
              </span>
            </div>
            <div>
              <span className="health-icon" aria-hidden="true">
                <SignalIcon />
              </span>
              <span>
                <small>Alert delivery</small>
                <ConnectionPopover watch={watch} />
              </span>
            </div>
          </div>
        </aside>
      </div>
      {pipeline && (
        <details className="watch-architecture">
          <summary>How this Watch works</summary>
          <Flow
            label="This Watch's recorded architecture"
            steps={[
              "Your intent",
              `${pipeline.protocol.name} ${pipeline.protocol.activity.replaceAll("_", " ")} stream`,
              `Substreams · ${pipeline.strategy.toLowerCase()}`,
              describeSpec(watch.spec),
              ...(workflow.data?.outputs.dataRequirements?.historicalQueries
                .length
                ? ["Graph historical context"]
                : []),
              "Scout investigation",
              "Alert or suppress · configured destinations",
            ]}
          />
          <p>
            Historical execution verifies the pipeline; Graph lookups provide
            investigation context. Live stream health and delivery are tracked
            separately.
          </p>
        </details>
      )}
      <ErrorNotice message={error ?? watch.error ?? wq.error?.message} />
      {health.data === "Delayed" && (
        <div className={`${noticeClassName} mb-6`}>
          Scout is waiting for fresh finalized data. Last block:{" "}
          {watch.lastBlock ?? "not recorded"}. Check worker and source health in
          Sources below.
        </div>
      )}
      {watch.pendingVersion && watch.version !== watch.pendingVersion && (
        <p className={`${noticeClassName} mb-5`}>
          Version {watch.pendingVersion} is preparing. Version {watch.version}{" "}
          remains in use until the replacement is ready.
        </p>
      )}
      <section className="incident-explorer" aria-labelledby="incident-history">
        <aside className="incident-rail">
          <div className="incident-rail-heading">
            <div>
              <span className="eyebrow">Watch history</span>
              <h2 id="incident-history">Investigations</h2>
            </div>
            <span
              className="incident-count"
              aria-label={`${rows.length}${more ? " or more" : ""} shown`}
            >
              {rows.length}
              {more ? "+" : ""}
            </span>
          </div>
          <div className="incident-rail-controls">
            <label className="incident-search">
              <span className="sr-only">Search investigations</span>
              <MagnifyingGlassIcon />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
                placeholder="Search history"
              />
            </label>
            <Select
              className="incident-filter"
              aria-label="Filter investigations"
              value={filter}
              onValueChange={(value) => {
                setFilter(value);
                setPage(0);
              }}
            >
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="reviewed">Reviewed</option>
              <option value="retracted">Retracted</option>
            </Select>
          </div>
          <ErrorNotice message={history.error?.message} />
          <p className="incident-comparison-label">
            Amounts relative to this page’s largest incident
          </p>
          <nav className="incident-list" aria-label="Investigations">
            {history.isLoading && !rows.length ? (
              <InvestigationListSkeleton />
            ) : rows.length ? (
              rows.map((incident) => (
                <Link
                  href={`/watches/${id}/incidents/${incident.id}`}
                  className="incident-rail-row"
                  aria-current={selectedId === incident.id ? "page" : undefined}
                  key={incident.id}
                >
                  <span className="incident-rail-meta">
                    <time>{dateTime(incident.createdAt)}</time>
                    <span>{incident.detection.severity}</span>
                  </span>
                  <strong>{incident.title}</strong>
                  <span className="incident-rail-value">
                    {usd(incident.detection.totalUsdMicros)}
                  </span>
                  <span className="incident-value-track" aria-hidden="true">
                    <span
                      style={{
                        width: `${largestIncident > 0n ? Number((BigInt(incident.detection.totalUsdMicros) * 10000n) / largestIncident) / 100 : 0}%`,
                      }}
                    />
                  </span>
                  <span className="incident-rail-detail">
                    {incident.detection.transactionCount} transaction
                    {incident.detection.transactionCount === 1 ? "" : "s"}
                    {incident.deliveryStates.length
                      ? ` · ${incident.deliveryStates
                          .map((delivery) => delivery.status)
                          .join(" · ")}`
                      : " · no delivery"}
                  </span>
                </Link>
              ))
            ) : (
              <p className="incident-rail-empty">
                {query || filter !== "all"
                  ? "No investigations match this filter."
                  : "No qualifying activity yet."}
              </p>
            )}
          </nav>
          {(page > 0 || more) && (
            <div className="incident-pagination">
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                Newer
              </button>
              <span>{page + 1}</span>
              <button disabled={!more} onClick={() => setPage(page + 1)}>
                Older
              </button>
            </div>
          )}
        </aside>
        <div className="incident-stage">
          {selected.incident && selected.incident.watchId === id ? (
            <Investigation
              incident={selected.incident}
              deliveries={selected.deliveries}
            />
          ) : selected.isLoading ? (
            <InvestigationSkeleton />
          ) : selectedId ? (
            <div className="incident-stage-empty">
              <h2>Investigation unavailable</h2>
              <ErrorNotice message={selected.error?.message} />
              <p>This investigation may belong to another watch or account.</p>
            </div>
          ) : (
            <div className="incident-stage-empty">
              <span className="incident-empty-icon" aria-hidden="true">
                <SignalIcon />
              </span>
              <h2>
                {watch.status === "draft"
                  ? "Your rule is saved."
                  : "No qualifying activity yet."}
              </h2>
              <p>
                {watch.status === "draft"
                  ? "Connect a verified destination and activate when you are ready."
                  : watch.status === "paused"
                    ? "Monitoring is paused. Existing evidence is preserved."
                    : "Scout will investigate events only when they match this Watch’s monitoring conditions."}
              </p>
              {watch.status === "draft" ? (
                <Link
                  className={buttonClassName("primary", "mt-5")}
                  href={`/new?edit=${id}`}
                >
                  Review and activate
                </Link>
              ) : ["paused", "failed"].includes(watch.status) ? (
                <button
                  className={buttonClassName("primary", "mt-5")}
                  onClick={async () => {
                    try {
                      await watchAction(id, "resume");
                    } catch (e) {
                      setError(
                        e instanceof Error
                          ? e.message
                          : "Could not resume watch.",
                      );
                    }
                  }}
                >
                  {watch.status === "failed"
                    ? "Retry preparation"
                    : "Resume watching"}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </section>
      <details className="mt-7 border-t border-white/8">
        <summary>Sources, pools & monitoring details</summary>
        <div className="context-grid">
          <div>
            <h3>The Graph · Substreams</h3>
            <p>
              Worker{" "}
              {state.worker.online
                ? "heartbeat current"
                : "heartbeat delayed or unavailable"}
              . Last heartbeat:{" "}
              {state.worker.lastSeen
                ? dateTime(state.worker.lastSeen)
                : "not recorded"}
              .
            </p>
            <p>
              Last processed block: {watch.lastBlock ?? "not recorded"}.{" "}
              {watch.lastBlockTime ? dateTime(watch.lastBlockTime) : ""}
            </p>
            <Link
              className={buttonClassName("quiet", "mt-3")}
              href={`/proof/${watch.id}`}
            >
              Technical source details <ArrowUpRightIcon className="size-4" />
            </Link>
          </div>
          <div>
            <h3>Selected pools</h3>
            {watch.spec.pools.map((pool) => (
              <p key={pool} className="break-all font-mono !text-[13px]">
                {pool}
              </p>
            ))}
            <p>
              Related events are grouped into {watch.spec.cooldownSeconds / 60}
              -minute UTC buckets. One alert per enabled destination per
              incident.
            </p>
          </div>
        </div>
      </details>
    </>
  );
}
