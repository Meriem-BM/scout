"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";

import { substreamsRegistryUrl } from "@scout/domain";
import { buttonClassName } from "@/features/workspace/primitives";
import { queryKeys } from "@/lib/query/keys";

import { api } from "../workspace/api";
import { useDateTime } from "../workspace/formatting";
import { PipelineSkeleton } from "../workspace/skeletons";
import { ErrorNotice, Status } from "../workspace/ui";
import { useWorkspace } from "../workspace/use-workspace";

import { useWorkflowQuery } from "./queries";

const Proof = z.object({
  deployments: z.array(
    z.object({
      id: z.string(),
      state: z.string(),
      artifact_hash: z.string().nullable(),
      proof: z.json(),
      error: z.string().nullable(),
      created_at: z.string(),
      last_block: z.coerce.string().nullable(),
      last_block_time: z.string().nullable(),
    }),
  ),
});

export function ProofView({ id }: { id: string }) {
  const dateTime = useDateTime();
  const { state, signedIn } = useWorkspace();
  const watch = state.watches.find((item) => item.id === id);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: queryKeys.proof(id),
    queryFn: () => api(`/api/proof?watch=${id}`, Proof),
    enabled: signedIn,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  const workflow = useWorkflowQuery(id, signedIn && !!watch?.workflowId);
  const resolution = workflow.data?.outputs.packageResolution;
  const plan = workflow.data?.outputs.pipelinePlan;

  async function download(file: string) {
    setError(null);

    try {
      const { url } = await api(
        `/api/proof?watch=${id}&file=${file}`,
        z.object({ url: z.string().url() }),
      );

      window.location.assign(url);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Artifact unavailable.",
      );
    }
  }

  return (
    <section className="w-full">
      <Link
        className="mb-6 inline-flex min-h-10 items-center gap-2 text-sm text-neutral-400 transition-colors hover:text-white"
        href="/watches"
      >
        <ArrowLeft width={13} height={13} /> Watches
      </Link>
      <div className="mb-8 [&_p]:mt-2 [&_p]:text-sm [&_p]:text-neutral-400 max-sm:flex-wrap max-sm:gap-5">
        <div className="mb-2 text-xs font-medium tracking-wide text-neutral-400">
          Technical proof
        </div>
        <h1 className="mt-5">From instruction to sink.</h1>
        <p>
          A package is not a running pipeline. This view separates generated
          artifacts, provider checks, and persisted progress.
        </p>
      </div>
      <ErrorNotice message={error ?? query.error?.message} />
      {query.isFetching && !query.data ? <PipelineSkeleton /> : null}
      {watch && (
        <section className="mt-7 border-t border-neutral-800 pt-6 [&>h2]:mb-4 [&>h3]:mb-4 [&>p]:text-sm [&>p]:text-neutral-400">
          <h2>Instruction & exact specification</h2>
          <p className="text-sm leading-6">{watch.prompt}</p>
          <pre className="max-h-96 overflow-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 font-mono text-xs leading-6 text-neutral-300 mt-5">
            {JSON.stringify(watch.spec, null, 2)}
          </pre>
        </section>
      )}
      {query.data?.deployments.map((deployment) => (
        <section
          className="mt-7 border-t border-neutral-800 pt-6 [&>h2]:mb-4 [&>h3]:mb-4 [&>p]:text-sm [&>p]:text-neutral-400"
          key={deployment.id}
        >
          <div className="flex items-center gap-3 justify-between">
            <h2>Deployment {deployment.id.slice(0, 8)}</h2>
            <Status status={deployment.state} />
          </div>
          <p className="text-sm leading-6 text-neutral-400">
            Created {dateTime(deployment.created_at)}
          </p>
          <ErrorNotice message={deployment.error} />
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm [&_dt]:text-neutral-400 [&_dd]:min-w-0 [&_dd]:break-words sm:grid-cols-[140px_minmax(0,1fr)] mt-5">
            <dt>Artifact identity</dt>
            <dd className="font-mono text-xs break-all">
              {deployment.artifact_hash ?? "Not yet built"}
            </dd>
            <dt>Last block</dt>
            <dd>{deployment.last_block ?? "No persisted output"}</dd>
            <dt>Block time</dt>
            <dd>
              {deployment.last_block_time
                ? dateTime(deployment.last_block_time)
                : "Unknown"}
            </dd>
          </dl>
          <pre className="max-h-96 overflow-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 font-mono text-xs leading-6 text-neutral-300 mt-5">
            {JSON.stringify(deployment.proof, null, 2)}
          </pre>
        </section>
      ))}
      {query.data?.deployments[0]?.artifact_hash && (
        <section className="mt-7 border-t border-neutral-800 pt-6 [&>h2]:mb-4 [&>h3]:mb-4 [&>p]:text-sm [&>p]:text-neutral-400">
          <h2>Restricted artifacts · newest version</h2>
          <p className="text-sm leading-6 text-neutral-400">
            Downloads require your account and use a 60-second signed URL.
          </p>
          <div className="flex items-center gap-3 flex-wrap mt-5">
            {["package.spkg", "manifest.yaml", "sources.json", "build.log"].map(
              (file) => (
                <button
                  className={buttonClassName("quiet")}
                  key={file}
                  onClick={() => void download(file)}
                >
                  {file}
                </button>
              ),
            )}
          </div>
        </section>
      )}
      <section className="mt-7 border-t border-neutral-800 pt-6 space-y-4">
        <h2>Package & reuse</h2>
        <ErrorNotice message={workflow.error?.message} />
        <p className="text-sm text-neutral-400">
          Scout artifacts are private. A successful build or live stream does
          not mean the package has been published. No registry publication is
          recorded for this Watch.
        </p>
        {resolution?.candidates
          .filter((candidate) => candidate.ref === resolution.selectedRef)
          .map((candidate) => (
            <div key={candidate.ref} className="space-y-3">
              <h3>
                {candidate.name} · {candidate.version}
              </h3>
              <p className="text-sm text-neutral-400">
                Selected dependency · {resolution.strategy} ·{" "}
                {resolution.selectedModule ?? "Module not selected"}
              </p>
              <div className="flex flex-wrap gap-3">
                {(
                  candidate.registryUrl ?? substreamsRegistryUrl(candidate.ref)
                )?.startsWith("https://substreams.dev/") && (
                  <a
                    className={buttonClassName("quiet")}
                    href={
                      candidate.registryUrl ??
                      substreamsRegistryUrl(candidate.ref) ??
                      undefined
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    View published dependency
                  </a>
                )}
                {candidate.packageUrl &&
                  /^https:\/\/(spkg.io|substreams.dev)\//.test(
                    candidate.packageUrl,
                  ) && (
                    <a
                      className={buttonClassName("quiet")}
                      href={candidate.packageUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download dependency
                    </a>
                  )}
                {candidate.sourceUrl?.startsWith("https://") && (
                  <a
                    className={buttonClassName("quiet")}
                    href={candidate.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Source repository
                  </a>
                )}
              </div>
            </div>
          ))}
        {!resolution && (
          <p className="text-sm text-neutral-400">
            No persisted package selection is available yet.
          </p>
        )}
        {plan && (
          <p className="text-sm text-neutral-400">
            {plan.generatedModules.length
              ? `Scout modules: ${plan.generatedModules.map((module) => module.name).join(", ")}.`
              : "No custom modules planned."}{" "}
            {plan.execution.status === "verified"
              ? "Executor available; deployment verification is recorded separately above."
              : "Architecture proposal only; an executable implementation is still required."}
          </p>
        )}
        <details>
          <summary>Reuse or publish your package</summary>
          <p className="text-sm text-neutral-400 my-3">
            Download package.spkg above to inspect or reuse it. Publishing makes
            the package and its embedded configuration public. Review the
            manifest and sources first, then authenticate with your own
            Substreams registry account.
          </p>
          <pre className="overflow-auto text-xs p-4 bg-neutral-950 rounded-lg">
            {
              "substreams info package.spkg\nsubstreams registry verify package.spkg\nsubstreams registry login\nsubstreams registry publish package.spkg"
            }
          </pre>
          <a
            className={buttonClassName("quiet", "mt-3")}
            href="https://thegraph.com/docs/en/substreams/publishing/"
            target="_blank"
            rel="noreferrer"
          >
            The Graph publishing guide
          </a>
        </details>
      </section>
    </section>
  );
}
