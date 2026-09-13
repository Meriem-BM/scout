"use client";

import { Play } from "lucide-react";
import Link from "next/link";

import {
  WATCH_STARTERS,
  type WatchWorkflow,
  workflowPresentation,
} from "@scout/domain";

import { setDraft } from "../watches/draft";
import { buttonClassName } from "../workspace/primitives";
import { Busy } from "../workspace/ui";

export function WorkflowOutcome({
  workflow,
  retrying,
  retry,
}: {
  workflow: WatchWorkflow;
  retrying: boolean;
  retry: () => void;
}) {
  const presentation = workflowPresentation(workflow);
  const alternatives = workflow.outputs.intent?.activity.type.value.startsWith(
    "liquidity_",
  )
    ? [WATCH_STARTERS[2], WATCH_STARTERS[0], WATCH_STARTERS[1]]
    : WATCH_STARTERS.slice(0, 3);

  return (
    <section
      className="workflow-summary"
      data-unsupported={presentation.unsupported}
      aria-live="polite"
    >
      <span className="workflow-eyebrow">
        {workflow.state === "LIVE" ? "Monitoring" : "Watch setup"}
      </span>
      <h2>{presentation.title}</h2>
      <p>{presentation.message}</p>
      <p className="workflow-summary-note">{presentation.note}</p>
      {workflow.state === "FAILED" && (
        <div className="workflow-recovery">
          <div className="workflow-recovery-actions">
            {workflow.recoverable && !presentation.unsupported && (
              <button
                className={buttonClassName("primary")}
                disabled={retrying}
                onClick={retry}
              >
                {retrying ? (
                  <Busy label="Retrying saved work" />
                ) : (
                  <>
                    <Play />
                    Retry saved work
                  </>
                )}
              </button>
            )}
            <Link
              className={buttonClassName("quiet")}
              href="/watches"
              onClick={() => setDraft(workflow.originalPrompt)}
            >
              Edit request
            </Link>
          </div>
          {presentation.unsupported && (
            <>
              <h3>Start a separate Watch with a supported setup</h3>
              <p>
                Your saved request stays unchanged. Review the new request
                before submitting.
              </p>
              <div className="workflow-alternatives">
                {alternatives.map((starter) => (
                  <Link
                    key={starter.id}
                    href="/watches"
                    onClick={() => setDraft(starter.prompt)}
                  >
                    <span>{starter.label}</span>
                    <small>{starter.description}</small>
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
