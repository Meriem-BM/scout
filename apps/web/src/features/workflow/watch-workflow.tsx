"use client";

import {
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  Code as CodeBracketIcon,
  TriangleAlert as ExclamationTriangleIcon,
  Play as PlayIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { type Watch, workflowLabel } from "@scout/domain";

import { useDateTime } from "../workspace/formatting";
import { buttonClassName } from "../workspace/primitives";
import { WorkflowSkeleton } from "../workspace/skeletons";
import { Busy, ErrorNotice } from "../workspace/ui";

import { useWatchWorkflow } from "./use-watch-workflow";

function stageLabel(stage: string) {
  if (
    stage.includes("INTENT") ||
    stage === "RECEIVED" ||
    stage === "NEEDS_CLARIFICATION"
  ) {
    return "Intent";
  }

  if (stage.includes("PACKAGE")) {
    return "Substreams";
  }

  if (stage.includes("DATA")) {
    return "Data planning";
  }

  if (stage.includes("PLAN")) {
    return "Architecture";
  }

  if (stage.includes("BUILD") || stage.includes("CODE")) {
    return "Build";
  }

  if (stage.includes("TEST") || stage.includes("VERIF")) {
    return "Verification";
  }

  if (stage.includes("DEPLOY") || stage === "CATCHING_UP" || stage === "LIVE") {
    return "Streaming";
  }

  return "Workflow";
}

export function WatchCreationWorkflow({ watch }: { watch: Watch }) {
  const dateTime = useDateTime();
  const [custom, setCustom] = useState("");
  const {
    query,
    workflow,
    streamError,
    answering,
    answeringValue,
    retrying,
    answer,
    retry,
  } = useWatchWorkflow(watch);

  return (
    <div className="workflow-page">
      <Link className="detail-back" href="/watches">
        ← Your watches
      </Link>
      <header className="workflow-header">
        <div>
          <h1>{workflow?.originalPrompt ?? watch.prompt}</h1>
        </div>
        <div
          className="workflow-live-state"
          data-stage={workflow?.state ?? watch.workflowStage ?? "RECEIVED"}
        >
          <span aria-hidden="true" />
          {workflow ? workflowLabel(workflow.state) : "Loading workflow"}
        </div>
      </header>

      <ErrorNotice message={query.error?.message ?? streamError} />
      {!workflow ? (
        query.isLoading ? (
          <WorkflowSkeleton />
        ) : null
      ) : (
        <div className="workflow-layout">
          <div className="workflow-timeline" aria-live="polite">
            <div className="workflow-panel-heading">
              <CodeBracketIcon aria-hidden="true" />
              <h2>
                {workflow.state === "FAILED"
                  ? "Workflow needs attention"
                  : workflow.state === "LIVE"
                    ? "Watch activated"
                    : workflow.state === "NEEDS_CLARIFICATION"
                      ? "Waiting for your input"
                      : "Building your Watch"}
              </h2>
              <span>Saved activity</span>
            </div>
            <div className="workflow-panel-events">
              {workflow.events.map((event, index) => (
                <article
                  className="workflow-event"
                  data-status={event.status}
                  data-current={
                    index === workflow.events.length - 1 &&
                    !["LIVE", "FAILED", "NEEDS_CLARIFICATION"].includes(
                      workflow.state,
                    )
                  }
                  key={event.id}
                >
                  <div className="workflow-event-rail">
                    <span
                      className="workflow-event-icon"
                      aria-label={
                        event.status === "active"
                          ? "Recorded activity"
                          : event.status
                      }
                    >
                      {event.status === "complete" ? (
                        <CheckIcon />
                      ) : event.status === "failed" ? (
                        <ExclamationTriangleIcon />
                      ) : (
                        <span className="workflow-activity-dot" />
                      )}
                    </span>
                    {index < workflow.events.length - 1 && <i />}
                  </div>
                  <div className="workflow-event-body">
                    <div>
                      <h2>{event.title}</h2>
                      <span className="workflow-stage-label">
                        {stageLabel(event.stage)}
                      </span>
                    </div>
                    {event.summary && <p>{event.summary}</p>}
                    <RecordedProgress metadata={event.metadata} />
                    <details>
                      <summary>
                        <ChevronDownIcon /> View details
                      </summary>
                      <time dateTime={event.createdAt}>
                        {dateTime(event.createdAt)}
                      </time>
                      {Object.keys(event.metadata).length > 0 && (
                        <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                      )}
                    </details>
                  </div>
                </article>
              ))}
            </div>
            {workflow.clarification && (
              <section
                className="clarification-card"
                aria-labelledby="clarification-title"
              >
                <span>I need one detail before I can continue.</span>
                <h2 id="clarification-title">
                  {workflow.clarification.question}
                </h2>
                <p>{workflow.clarification.reason}</p>
                <div className="clarification-choices">
                  {workflow.clarification.choices.map((choice) => (
                    <button
                      disabled={answering}
                      key={choice.value}
                      onClick={() => void answer(choice.value)}
                    >
                      <span>{choice.label}</span>
                      {answering && answeringValue === choice.value ? (
                        <Busy label="Saving" />
                      ) : (
                        choice.recommended && <small>Recommended</small>
                      )}
                    </button>
                  ))}
                </div>
                {workflow.clarification.allowCustom && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void answer(custom);
                    }}
                  >
                    <input
                      value={custom}
                      disabled={answering}
                      aria-label="Custom clarification answer"
                      onChange={(event) => setCustom(event.target.value)}
                      placeholder="Enter another answer"
                      maxLength={500}
                    />
                    <button
                      className={buttonClassName()}
                      disabled={answering || !custom.trim()}
                    >
                      {answering && answeringValue === custom ? (
                        <Busy label="Saving" />
                      ) : (
                        "Continue"
                      )}
                    </button>
                  </form>
                )}
              </section>
            )}

            {workflow.state === "FAILED" && (
              <section className="workflow-failure">
                <ExclamationTriangleIcon />
                <div>
                  <span>{workflow.errorCategory ?? "Workflow"}</span>
                  <h2>
                    {workflow.errorCategory === "VERIFICATION"
                      ? "Pipeline could not be verified"
                      : "Scout stopped before activation"}
                  </h2>
                  <p className="workflow-failure-message">
                    {workflow.errorMessage ??
                      "Scout stopped before activation."}
                  </p>
                  <p className="workflow-failure-note">
                    Scout did not mark this Watch live. Completed outputs and
                    diagnostics remain saved.
                  </p>
                  {workflow.recoverable && (
                    <button
                      className={buttonClassName("primary", "mt-4")}
                      disabled={retrying}
                      onClick={retry}
                    >
                      {retrying ? (
                        <Busy label="Retrying saved work" />
                      ) : (
                        <>
                          <PlayIcon />
                          Retry saved work
                        </>
                      )}
                    </button>
                  )}
                </div>
              </section>
            )}
          </div>

          <aside className="workflow-proof">
            <h2>What Scout knows</h2>
            <ProofBlock
              title="Intent"
              value={
                workflow.outputs.intent
                  ? {
                      network: workflow.outputs.intent.subject.chain?.value,
                      protocol: workflow.outputs.intent.subject.protocol?.value,
                      version:
                        workflow.outputs.intent.subject.protocolVersion?.value,
                      tokens: workflow.outputs.intent.subject.tokens
                        .map((item) => item.value)
                        .join(" / "),
                      activity: workflow.outputs.intent.activity.type.value,
                      assumptions: workflow.outputs.intent.assumptions,
                    }
                  : null
              }
            />
            <ProofBlock
              title="Data plan"
              value={
                workflow.outputs.dataRequirements
                  ? {
                      stream: workflow.outputs.dataRequirements.requiredStreams
                        .map((item) =>
                          [item.protocol, item.entity]
                            .filter(Boolean)
                            .join(" "),
                        )
                        .join(", "),
                      profile:
                        workflow.outputs.dataRequirements.protocolProfile,
                      deterministic:
                        workflow.outputs.dataRequirements
                          .deterministicDerivedFields,
                      historical:
                        workflow.outputs.dataRequirements.historicalQueries,
                    }
                  : null
              }
            />
            <ProofBlock
              title="Data source"
              value={
                workflow.outputs.packageResolution
                  ? {
                      selected: workflow.outputs.packageResolution.selectedRef,
                      strategy: workflow.outputs.packageResolution.strategy,
                      inspected:
                        workflow.outputs.packageResolution.candidates.length,
                      considered:
                        workflow.outputs.packageResolution.alternatives.map(
                          (item) => item.ref,
                        ),
                    }
                  : null
              }
            />
            <ProofBlock
              title="Architecture"
              value={
                workflow.outputs.pipelinePlan
                  ? {
                      strategy: workflow.outputs.pipelinePlan.strategy,
                      protocol: [
                        workflow.outputs.pipelinePlan.protocol.name,
                        workflow.outputs.pipelinePlan.protocol.version,
                      ]
                        .filter(Boolean)
                        .join(" "),
                      activity:
                        workflow.outputs.pipelinePlan.protocol.activity.replaceAll(
                          "_",
                          " ",
                        ),
                      execution:
                        workflow.outputs.pipelinePlan.execution.status ===
                        "verified"
                          ? "Verified executor"
                          : "Planning only",
                      package:
                        workflow.outputs.pipelinePlan.dependencies[0]
                          ?.packageRef,
                      reused: workflow.outputs.pipelinePlan.dependencies.map(
                        (item) => item.module,
                      ),
                      scoutModules: workflow.outputs.pipelinePlan
                        .generatedModules.length
                        ? workflow.outputs.pipelinePlan.generatedModules.map(
                            (item) => item.name,
                          )
                        : ["None"],
                    }
                  : null
              }
            />
            <ProofBlock
              title="Verification"
              value={
                workflow.outputs.verification
                  ? {
                      status: workflow.outputs.verification.status,
                      blocks:
                        workflow.outputs.verification.execution.blocksTested,
                      events:
                        workflow.outputs.verification.execution.eventsObserved,
                      source: workflow.outputs.verification.referenceSource,
                    }
                  : null
              }
            />
          </aside>
        </div>
      )}
    </div>
  );
}

function ProofBlock({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown> | null;
}) {
  return (
    <section data-ready={!!value}>
      <div>
        <span>{value ? <CheckIcon /> : null}</span>
        <h3>{title}</h3>
      </div>
      {value ? (
        <dl>
          {Object.entries(value).map(([key, item]) =>
            item === undefined ||
            item === null ||
            item === "" ||
            (Array.isArray(item) && !item.length) ? null : (
              <div key={key}>
                <dt>{key.replaceAll(/([A-Z])/g, " $1")}</dt>
                <dd>{Array.isArray(item) ? item.join(" · ") : String(item)}</dd>
              </div>
            ),
          )}
        </dl>
      ) : (
        <p>Waiting for this stage.</p>
      )}
    </section>
  );
}

function RecordedProgress({ metadata }: { metadata: Record<string, unknown> }) {
  const fields = [
    ["startBlock", "Historical start block"],
    ["stopBlock", "Historical stop block (exclusive)"],
    ["blocksTested", "Blocks tested"],
    ["eventsObserved", "Events observed"],
    ["referenceEvents", "Reference events"],
    ["outputBlocks", "Output blocks received"],
    ["pipelineHead", "Recorded pipeline head"],
    ["networkHead", "Recorded finalized network head"],
    ["lag", "Recorded block lag"],
  ] as const;
  const rows = fields.flatMap(([key, label]) => {
    const value = metadata[key];

    return (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0) ||
      (typeof value === "string" && /^\d+$/.test(value))
      ? [{ label, value: String(value) }]
      : [];
  });

  if (!rows.length) {
    return null;
  }

  return (
    <dl className="workflow-recorded-progress">
      {rows.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
