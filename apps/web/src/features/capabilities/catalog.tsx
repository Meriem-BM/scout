"use client";

import { ArrowRight, CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import Link from "next/link";

import { ProtocolMark } from "../workspace/protocol-mark";

import { useCapabilities } from "./queries";
import { capabilityStatus, toCapabilityViewModel } from "./view-model";

export function CapabilityStatus({
  status,
}: {
  status: { label: string; description: string; tone: string };
}) {
  const Icon =
    status.tone === "ready" || status.tone === "available"
      ? CheckCircle2
      : status.tone === "missing"
        ? XCircle
        : CircleDashed;

  return (
    <span
      className="capability-status"
      data-tone={status.tone}
      title={status.description}
    >
      <Icon size={15} aria-hidden="true" />
      {status.label}
      <span className="sr-only">. {status.description}</span>
    </span>
  );
}

export function CapabilityCatalog({ compact = false }: { compact?: boolean }) {
  const query = useCapabilities();

  if (query.isPending) {
    return (
      <div
        className="capability-loading"
        role="status"
        aria-label="Loading what Scout can watch"
      >
        <div />
        <div />
        <div />
        <span className="sr-only">Loading capabilities</span>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div role="alert" className="capability-empty">
        <p>Scout couldn’t load its current capabilities.</p>
        <button onClick={() => void query.refetch()}>Try again</button>
      </div>
    );
  }

  const entries = query.data.protocols.map(toCapabilityViewModel);

  return (
    <div className={`capability-catalog ${compact ? "is-compact" : ""}`}>
      {entries.length ? (
        <div className="capability-grid">
          {entries.map((entry) => (
            <article
              className="capability-card"
              data-protocol={entry.protocol}
              key={entry.id}
            >
              <div className="capability-card-meta">
                <span className="capability-source">
                  <ProtocolMark protocol={entry.protocol} size={22} />
                  <span>
                    {entry.protocol}
                    {entry.version ? ` · ${entry.version}` : ""} ·{" "}
                    {entry.chains.join(", ")}
                  </span>
                </span>
                <CapabilityStatus status={entry.status} />
              </div>
              <h3 className="capability-title">{entry.title}</h3>
              <p>{entry.description}</p>
              {!compact && (
                <>
                  <p className="capability-verification">
                    {entry.verification}
                  </p>
                  <details>
                    <summary>What Scout can use</summary>
                    <ul className="capability-fields">
                      {[...entry.operations, ...entry.fields].map((field) => (
                        <li key={field.id}>
                          <span>{field.title}</span>
                          <CapabilityStatus status={field.status} />
                        </li>
                      ))}
                    </ul>
                  </details>
                  <details>
                    <summary>Scope & limitations</summary>
                    <ul>
                      {entry.limitations.map((limit) => (
                        <li key={limit}>{limit}</li>
                      ))}
                    </ul>
                  </details>
                  {query.data.examples
                    .filter((e) => e.adapterId === entry.id)
                    .map((example) => (
                      <Link
                        className="capability-example"
                        href={`/watches?example=${example.id}`}
                        key={example.id}
                      >
                        {example.label}
                        <ArrowRight size={15} aria-hidden="true" />
                      </Link>
                    ))}
                </>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p>No data sources are currently available.</p>
      )}
      {compact ? (
        <Link className="capability-link" href="/capabilities">
          View all capabilities <ArrowRight size={16} aria-hidden="true" />
        </Link>
      ) : (
        <section className="capability-tools">
          <h2>Monitoring tools</h2>
          <p>
            Scout combines these tools with compatible data. A tool being
            available does not mean every combination is ready to activate.
          </p>
          <ul>
            {query.data.runtime.map((item) => (
              <li key={item.id}>
                <span>{item.title}</span>
                <CapabilityStatus status={capabilityStatus[item.status]} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function CapabilitiesScreen() {
  return (
    <div className="capabilities-page">
      <Link href="/watches" className="detail-back">
        ← Your Watches
      </Link>
      <header>
        <span className="eyebrow">What Scout can watch</span>
        <h1>Start with what’s available.</h1>
        <p>
          Describe what matters onchain. Scout checks whether it has the data
          and monitoring tools needed to build the Watch.
        </p>
      </header>
      <CapabilityCatalog />
      <section className="capability-footnote">
        <h2>Different versions, different support.</h2>
        <p>
          Protocol versions expose different activity. Scout checks the version,
          chain and conditions together. If an activity is not listed, Scout has
          no installed data source for it today.
        </p>
        <p>
          Protocols provide data. Scout provides the monitoring logic. More data
          sources can be added through adapters without rebuilding the Watch
          system.
        </p>
        <Link href="/docs/capabilities">Understand capabilities →</Link>
      </section>
    </div>
  );
}
