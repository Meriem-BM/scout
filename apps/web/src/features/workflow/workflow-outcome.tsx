"use client";

import { Play } from "lucide-react";
import Link from "next/link";

import { type WatchWorkflow, workflowPresentation } from "@scout/domain";

import { useCapabilities } from "../capabilities/queries";
import { setDraft } from "../watches/draft";
import { buttonClassName } from "../workspace/primitives";
import { ProtocolMark } from "../workspace/protocol-mark";
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
  const capabilities = useCapabilities();
  const alternatives = capabilities.data?.examples ?? [];

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
      {workflow.errorCode && (
        <details>
          <summary>View technical details</summary>
          <pre>
            {workflow.errorCode}
            {"\n"}
            {workflow.errorMessage}
          </pre>
        </details>
      )}
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
                {alternatives.map((starter) => {
                  const protocol = capabilities.data?.protocols.find(
                    (entry) => entry.id === starter.adapterId,
                  )?.protocol;

                  return (
                    <Link
                      key={starter.id}
                      href="/watches"
                      onClick={() => setDraft(starter.prompt)}
                    >
                      <ProtocolMark
                        protocol={protocol ?? starter.adapterId}
                        size={18}
                      />
                      <span>
                        {starter.label}
                        <small>{starter.description}</small>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
