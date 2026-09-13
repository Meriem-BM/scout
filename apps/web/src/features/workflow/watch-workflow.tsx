"use client";

import {
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  Code as CodeBracketIcon,
  TriangleAlert as ExclamationTriangleIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  type Watch,
  WATCH_STARTERS,
  workflowPresentation,
} from "@scout/domain";

import { useDateTime } from "../workspace/formatting";
import { buttonClassName } from "../workspace/primitives";
import { WorkflowSkeleton } from "../workspace/skeletons";
import { Busy, ErrorNotice } from "../workspace/ui";

import { useWatchWorkflow } from "./use-watch-workflow";
import { WorkflowOutcome } from "./workflow-outcome";

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

  const presentation = workflow ? workflowPresentation(workflow) : null;
  const prompt = workflow?.originalPrompt ?? watch.prompt;
  const starter = WATCH_STARTERS.find((item) => item.prompt === prompt.trim());

  return (
    <div className="workflow-page">
      <Link className="detail-back" href="/watches">
        ← Your watches
      </Link>
      <header className="workflow-header">
        <div>
          <h1>{starter?.label ?? prompt}</h1>
          {starter && <p>{starter.description}</p>}
        </div>
        <div
          className="workflow-live-state"
          data-stage={workflow?.state ?? watch.workflowStage ?? "RECEIVED"}
          data-unsupported={presentation?.unsupported}
        >
          <span aria-hidden="true" />
          {presentation?.label ?? "Loading workflow"}
        </div>
      </header>

      <ErrorNotice message={query.error?.message ?? streamError} />
      {!workflow ? (
        query.isLoading ? (
          <WorkflowSkeleton />
        ) : null
      ) : (
        <div className="workflow-layout">
          <div className="workflow-timeline">
            <WorkflowOutcome
              workflow={workflow}
              retrying={retrying}
              retry={retry}
            />
            {workflow.clarification && (
              <section
                className="clarification-card"
                aria-labelledby="clarification-title"
              >
                <span>I need one detail before I can continue.</span>
                <h2 id="clarification-title">
                  {workflow.clarification.question}
                </h2>
                {workflow.clarification.reason !==
                  workflow.clarification.question && (
                  <p>{workflow.clarification.reason}</p>
                )}
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
            <details className="workflow-history">
              <summary>
                <ChevronDownIcon />
                Activity log <span>{workflow.events.length} saved steps</span>
              </summary>
              <div className="workflow-panel-heading">
                <CodeBracketIcon aria-hidden="true" />
                <h2>Setup activity</h2>
                <span>Recorded events</span>
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
            </details>
          </div>

          <aside className="workflow-proof">
            <h2>Saved setup details</h2>
            {starter && (
              <details className="workflow-request">
                <summary>Full request</summary>
                <p>{prompt}</p>
              </details>
            )}
            <p className="workflow-proof-note">
              Plans describe intended work. Check the verification report for
              execution evidence.
            </p>
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
                      pools: workflow.outputs.intent.subject.contracts.map(
                        (item) => item.value,
                      ),
                      conditions: workflow.outputs.intent.filters.map(
                        (filter) =>
                          `${filter.field} ${filter.operator} ${filter.value} ${filter.unit ?? ""}`,
                      ),
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
                          ? "Executor available; see verification"
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
  if (!value) {
    return null;
  }

  return (
    <section data-ready="true">
      <div>
        <span>
          <CodeBracketIcon />
        </span>
        <h3>{title}</h3>
      </div>
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
