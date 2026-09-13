"use client";

import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import Link from "next/link";

import { toWatchCapabilityViewModel } from "./view-model";

import type { WatchWorkflow } from "@scout/domain";

export function WatchCapabilityExplanation({
  workflow,
}: {
  workflow: WatchWorkflow;
}) {
  const value = workflow.capabilities;

  if (!value) {
    return (
      <section className="watch-capabilities">
        <h2>Understanding your Watch</h2>
        <p>
          Scout’s capability checks will appear here as your request is
          resolved.
        </p>
      </section>
    );
  }

  const view = toWatchCapabilityViewModel(value);
  const live = workflow.state === "LIVE";

  return (
    <section
      className="watch-capabilities"
      aria-label="How Scout built this Watch"
    >
      <span className="eyebrow">How Scout built this Watch</span>
      <h2>{live ? "Built and verified" : view.title}</h2>
      <p aria-live="polite">
        {live
          ? "This Watch passed setup and verification. Its current monitoring health is shown separately."
          : view.description}
      </p>
      <details className="capability-request">
        <summary>Your request</summary>
        <p>{workflow.originalPrompt}</p>
      </details>
      <div className="watch-capability-groups">
        {[
          {
            title: "Scout will combine",
            rows: view.available,
            Icon: CheckCircle2,
            tone: "available",
          },
          {
            title: "Missing",
            rows: view.missing,
            Icon: XCircle,
            tone: "missing",
          },
          {
            title: "Needs a detail",
            rows: view.details,
            Icon: CircleDashed,
            tone: "detail",
          },
        ]
          .filter((group) => group.rows.length)
          .map(({ title, rows, Icon, tone }) => (
            <div key={title} data-tone={tone}>
              <h3>{title}</h3>
              <ul>
                {rows.map((row) => (
                  <li key={row.title}>
                    <Icon size={17} aria-hidden="true" />
                    <div>
                      <span>{row.title}</span>
                      {row.explanation && <p>{row.explanation}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
      {view.limitations.length > 0 && (
        <details>
          <summary>
            {live
              ? "What this Watch can do & its limits"
              : "Scope & limitations"}
          </summary>
          {live && (
            <ul>
              {view.available.map((r) => (
                <li key={r.title}>{r.title}</li>
              ))}
            </ul>
          )}
          <ul>
            {view.limitations.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </details>
      )}
      <Link className="capability-link" href="/capabilities">
        View what Scout can monitor →
      </Link>
      {Boolean(value.program || value.plan) && (
        <details>
          <summary>Technical details</summary>
          <h3>WatchProgram</h3>
          <pre>{JSON.stringify(value.program, null, 2)}</pre>
          <h3>Capability plan</h3>
          <pre>{JSON.stringify(value.plan, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
