import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  compileExecutableSpec,
  createPipelinePlan,
  dataPlanningClarification,
  DataRequirementSpecSchema,
  type ExecutableWatchSpec,
  ExecutableWatchSpecSchema,
  migrateExecutableProgram,
  PackageResolutionSchema,
  PipelinePlanSchema,
  planDataRequirements,
  planProgramCapabilities,
  requireValidatedProgram,
  resolvePipelinePackages,
  VerificationReportSchema,
  WatchIntentSpecSchema,
  type WorkflowErrorCategory,
  workflowErrorCategory,
  type WorkflowStage,
  WorkflowStageSchema,
} from "@scout/domain";
import { GroqAdapter } from "@scout/integrations/ai";
import { IntegrationError } from "@scout/integrations/http";
import { SubstreamsRegistry } from "@scout/integrations/substreams-registry";

import {
  buildFailureCode,
  consumesRepairBudget,
  safeDiagnostic,
} from "../errors";
import { log } from "../log";
import { buildDeployment } from "../pipeline/build";

import type { WorkerConfig } from "../config";
import type { DatabaseConnection } from "@scout/database";
import type { Ethereum } from "@scout/integrations/ethereum";
import type { SupabaseClient } from "@supabase/supabase-js";

const FlowRow = z.object({
  id: z.string().uuid(),
  watch_id: z.string().uuid(),
  user_id: z.string().uuid(),
  original_prompt: z.string(),
  state: z.string(),
  run_number: z.number().int(),
});

async function append(
  sql: DatabaseConnection,
  workflowId: string,
  stage: WorkflowStage,
  type: string,
  status: "pending" | "active" | "complete" | "warning" | "failed",
  title: string,
  summary: string | null,
  metadata: Record<string, unknown> = {},
) {
  await sql`select app_private.append_workflow_event(${workflowId},${stage},${type},${status},${title},${summary},${sql.json(metadata as never)})`;
  log("watch.workflow.event", { workflowId, stage, type, status });
}

async function put(
  sql: DatabaseConnection,
  workflowId: string,
  kind: string,
  value: unknown,
) {
  await sql`select app_private.put_workflow_output(${workflowId},${kind},${sql.json(value as never)})`;
}

async function output(
  sql: DatabaseConnection,
  workflowId: string,
  kind: string,
) {
  return (
    await sql`select payload from public.watch_workflow_outputs where workflow_id=${workflowId} and kind=${kind}`
  )[0]?.payload as unknown;
}

export async function failWorkflow(
  sql: DatabaseConnection,
  workflowId: string,
  category: WorkflowErrorCategory,
  code: string,
  message: string,
  recoverable: boolean,
) {
  const safeMessage = safeDiagnostic(message);

  await sql.begin(async (tx) => {
    await tx`update public.watch_workflows set error_category=${category},error_code=${code},error_message=${safeMessage},recoverable=${recoverable},updated_at=now() where id=${workflowId}`;
    await tx`update public.watches w set error=${safeMessage} from public.watch_workflows f where f.id=${workflowId} and w.id=f.watch_id`;
    await tx`select app_private.append_workflow_event(${workflowId},'FAILED','workflow.failed','failed',${category === "VERIFICATION" ? "Pipeline could not be verified" : "Workflow stopped"},${safeMessage},${tx.json({ category, code, recoverable })})`;
  });
}

export function workflowCategory(stage: string) {
  return workflowErrorCategory(WorkflowStageSchema.parse(stage));
}

export async function runWatchWorkflow(
  sql: DatabaseConnection,
  storage: SupabaseClient,
  rpc: Ethereum,
  config: WorkerConfig,
  workflowId: string,
  signal: AbortSignal,
) {
  const row = FlowRow.parse(
    (await sql`select * from public.watch_workflows where id=${workflowId}`)[0],
  );

  if (["LIVE", "NEEDS_CLARIFICATION"].includes(row.state)) {
    return;
  }

  try {
    let intentValue = await output(sql, row.id, "intent");

    if (!intentValue) {
      if (!config.GROQ_API_KEY) {
        throw new IntegrationError(
          "GROQ_SETUP_REQUIRED",
          "Intent resolution requires GROQ_API_KEY on the monitoring worker.",
        );
      }

      if (row.state !== "INTENT_RESOLVING") {
        await append(
          sql,
          row.id,
          "INTENT_RESOLVING",
          "intent.started",
          "active",
          "Understanding your request",
          "Resolving the monitoring subject, activity, thresholds, time window, and investigation needs.",
        );
      }

      const answers = (
        await sql`select field,answer from public.watch_clarifications where workflow_id=${row.id} and status='answered' order by answered_at`
      ).map((answer) => ({
        field: z.string().parse(answer.field),
        answer: z.string().parse(answer.answer),
      }));
      const resolved = await new GroqAdapter(
        config.GROQ_API_KEY,
        config.GROQ_MODEL,
      ).resolveIntent(row.original_prompt, answers);

      if (resolved.status === "UNSUPPORTED") {
        const alternative = resolved.supportedAlternative
          ? ` ${resolved.supportedAlternative}`
          : "";

        await failWorkflow(
          sql,
          row.id,
          "INTENT",
          "UNSUPPORTED_INTENT",
          `${resolved.unsupportedReason}${alternative}`,
          false,
        );

        return;
      }

      if (resolved.status === "NEEDS_CLARIFICATION") {
        const clarification = resolved.clarification!;

        await sql.begin(async (tx) => {
          await tx`insert into public.watch_clarifications(workflow_id,watch_id,user_id,field,reason,question,choices,allow_custom)
            values(${row.id},${row.watch_id},${row.user_id},${clarification.field},${clarification.reason},${clarification.question},${tx.json(clarification.choices)},${clarification.allowCustom})
            on conflict(workflow_id,field) where status='open' do update set reason=excluded.reason,question=excluded.question,choices=excluded.choices,allow_custom=excluded.allow_custom`;
          await tx`select app_private.put_workflow_output(${row.id},'intent',${tx.json(resolved.intent)})`;
          await tx`select app_private.append_workflow_event(${row.id},'NEEDS_CLARIFICATION','intent.clarification','warning','One detail is needed',${clarification.reason},${tx.json({ field: clarification.field })})`;
        });

        return;
      }

      const readyIntent = WatchIntentSpecSchema.parse(resolved.intent);

      intentValue = readyIntent;

      await sql.begin(async (tx) => {
        await tx`select app_private.put_workflow_output(${row.id},'intent',${tx.json(readyIntent)})`;
        await tx`select app_private.append_workflow_event(${row.id},'INTENT_READY','intent.resolved','complete','Request understood','Scout resolved the monitoring subject, network, activity, filters, and investigation boundary.',${tx.json({ assumptions: readyIntent.assumptions, protocol: readyIntent.subject.protocol?.value, activity: readyIntent.activity.type.value })})`;
      });
    }

    const intent = WatchIntentSpecSchema.parse(intentValue);

    let requirementsValue = await output(sql, row.id, "data_requirements");
    const dataQuestion = dataPlanningClarification(intent);

    if (dataQuestion) {
      await sql.begin(async (tx) => {
        await tx`insert into public.watch_clarifications(workflow_id,watch_id,user_id,field,reason,question,choices,allow_custom)
          values(${row.id},${row.watch_id},${row.user_id},${dataQuestion.field},${dataQuestion.reason},${dataQuestion.question},${tx.json(dataQuestion.choices)},${dataQuestion.allowCustom})
          on conflict(workflow_id,field) where status='open' do update set reason=excluded.reason,question=excluded.question,choices=excluded.choices,allow_custom=excluded.allow_custom`;
        await tx`select app_private.append_workflow_event(${row.id},'NEEDS_CLARIFICATION','data.clarification','warning','One detail is needed',${dataQuestion.reason},${tx.json({ field: dataQuestion.field })})`;
      });

      return;
    }

    // Typed executable semantics and capability dependencies are persisted before package selection.
    // Unsupported legacy shapes retain their existing explicit compiler failure path.
    let program = null;
    let programError: string | null = null;

    try {
      program = migrateExecutableProgram(compileExecutableSpec(intent));
    } catch (error) {
      programError =
        error instanceof Error
          ? error.message
          : "The monitoring program could not be bound to a data adapter.";
    }

    if (program && !(await output(sql, row.id, "watch_program"))) {
      requireValidatedProgram(program);

      const capabilities = planProgramCapabilities(program);

      await sql.begin(async (tx) => {
        await tx`select app_private.put_workflow_output(${row.id},'watch_program',${tx.json(program)})`;
        await tx`select app_private.put_workflow_output(${row.id},'capability_plan',${tx.json(capabilities)})`;
        await tx`select app_private.append_workflow_event(${row.id},'DATA_PLANNING','capability.resolved',${programError ? "warning" : "complete"},'Monitoring primitives resolved',${programError ?? "Data acquisition and deterministic monitoring conditions are planned separately. Historical and acceptance verification are still required."},${tx.json({ adapterId: capabilities.adapterId, supportLevel: capabilities.status, dependencies: capabilities.dependencies })})`;
      });
    }

    // A valid legacy program can lack an IR migration without being unsupported.
    // Only an actual executable-contract failure is a capability rejection here.
    if (programError && !(await output(sql, row.id, "capability_plan"))) {
      await put(sql, row.id, "capability_plan", {
        status: "UNSUPPORTED",
        adapterId: null,
        understood: true,
        pipelineGenerationCouldSolve: false,
        dependencies: [
          {
            category: "runtime",
            capability: "durable_program_binding",
            status: "UNSUPPORTED",
            reason: programError,
          },
        ],
      });
    }

    const currentRequirements = planDataRequirements(intent);
    const savedRequirements =
      DataRequirementSpecSchema.safeParse(requirementsValue);
    const refreshRequirements =
      savedRequirements.success &&
      !isDeepStrictEqual(savedRequirements.data, currentRequirements);

    if (!savedRequirements.success || refreshRequirements) {
      if (!savedRequirements.success) {
        await append(
          sql,
          row.id,
          "DATA_PLANNING",
          "data.plan.started",
          "active",
          "Planning required blockchain data",
          "Separating streaming fields, deterministic rules, historical context, and delivery responsibilities.",
        );
      }

      requirementsValue = currentRequirements;
      await put(sql, row.id, "data_requirements", currentRequirements);
      await append(
        sql,
        row.id,
        "DATA_PLANNING",
        refreshRequirements ? "data.plan.refreshed" : "data.plan.ready",
        "complete",
        refreshRequirements
          ? "Blockchain data plan refreshed"
          : "Blockchain data plan ready",
        `${currentRequirements.protocolName} ${currentRequirements.requiredStreams[0]?.entity ?? "activity"} evidence comes from Substreams; rules, context, investigation, and delivery remain in Scout.`,
        {
          streamFields: currentRequirements.requiredStreams.flatMap(
            (stream) => stream.fields,
          ).length,
          ...(refreshRequirements
            ? {
                previousExecutor: savedRequirements.data.execution.executorId,
                executor: currentRequirements.execution.executorId,
              }
            : {}),
        },
      );
    }

    const requirements = DataRequirementSpecSchema.parse(requirementsValue);

    let packageValue = await output(sql, row.id, "package_resolution");

    if (!packageValue) {
      await append(
        sql,
        row.id,
        "PACKAGE_DISCOVERY",
        "packages.search.started",
        "active",
        "Searching existing Substreams",
        "Querying the public Substreams registry and inspecting package artifacts.",
      );

      const discovered = await new SubstreamsRegistry().discover(
        requirements,
        signal,
      );

      await append(
        sql,
        row.id,
        "PACKAGE_EVALUATION",
        "packages.inspected",
        "active",
        `${discovered.candidates.length} packages inspected`,
        "Checking network, modules, output descriptors, fields, parameters, dependencies, and source metadata.",
        {
          query: discovered.query,
          failures: discovered.failures,
          candidates: discovered.candidates.map((candidate) => ({
            ref: candidate.ref,
            score: candidate.score,
            network: candidate.network,
            matchingFields: candidate.evidence.matchingFields.length,
            missingFields: candidate.evidence.missingFields.length,
            modules: candidate.modules.map((module) => module.name),
          })),
        },
      );
      packageValue = resolvePipelinePackages(
        requirements,
        discovered.candidates,
      );
      await put(sql, row.id, "package_resolution", packageValue);

      const resolution = PackageResolutionSchema.parse(packageValue);

      await append(
        sql,
        row.id,
        "PACKAGE_EVALUATION",
        "packages.selected",
        requirements.execution.status === "verified" ? "complete" : "warning",
        requirements.execution.status === "verified"
          ? "Data package selected"
          : "Data package proposal",
        resolution.summary,
        {
          selectedRef: resolution.selectedRef,
          strategy: resolution.strategy,
          alternatives: resolution.alternatives.map((item) => item.ref),
        },
      );
    }

    const resolution = PackageResolutionSchema.parse(packageValue);

    let planValue = await output(sql, row.id, "pipeline_plan");

    if (!planValue) {
      await append(
        sql,
        row.id,
        "PIPELINE_PLANNING",
        "pipeline.plan.started",
        "active",
        "Choosing the pipeline architecture",
        "Preferring verified reuse and the smallest necessary Scout module.",
      );

      let compiledSpec: ExecutableWatchSpec | null = null;

      if (requirements.execution.status === "verified") {
        try {
          compiledSpec = compileExecutableSpec(intent);
        } catch (error) {
          await failWorkflow(
            sql,
            row.id,
            "PLAN",
            "EXECUTABLE_SPEC_INVALID",
            error instanceof Error
              ? error.message
              : "The resolved intent could not be compiled into the verified executor contract.",
            false,
          );

          return;
        }
      }

      planValue = createPipelinePlan(
        intent,
        requirements,
        resolution,
        compiledSpec,
      );
      await put(sql, row.id, "pipeline_plan", planValue);

      const plan = PipelinePlanSchema.parse(planValue);

      await append(
        sql,
        row.id,
        "PLAN_VALIDATION",
        "pipeline.plan.validated",
        "complete",
        plan.execution.status === "verified"
          ? "Architecture validated"
          : "Architecture proposed",
        plan.execution.status === "verified"
          ? "The executor contract is available; independent historical verification is still required."
          : "Package discovery produced a proposal. Field semantics and executable implementation have not been verified.",
        {
          strategy: plan.strategy,
          generatedModules: plan.generatedModules.map((module) => module.name),
          findings: plan.critic.findings,
        },
      );

      if (plan.execution.status !== "verified" || !compiledSpec) {
        await failWorkflow(
          sql,
          row.id,
          "PLAN",
          "VERIFIED_EXECUTOR_UNAVAILABLE",
          plan.execution.reason ??
            "Scout produced a data and pipeline plan, but no verified live executor is available for this protocol, activity, network, and version yet.",
          false,
        );

        return;
      }
    }

    const plan = PipelinePlanSchema.parse(planValue);

    if (plan.execution.status !== "verified") {
      await failWorkflow(
        sql,
        row.id,
        "PLAN",
        "VERIFIED_EXECUTOR_UNAVAILABLE",
        plan.execution.reason ??
          "This persisted plan does not yet have a verified live executor.",
        false,
      );

      return;
    }

    let version = (
      await sql`select spec from public.watch_versions where watch_id=${row.watch_id} order by version desc limit 1`
    )[0]?.spec;

    if (!version) {
      const compiledSpec = compileExecutableSpec(intent);

      await sql.begin(async (tx) => {
        const inserted = (
          await tx`insert into public.watch_versions(watch_id,user_id,version,prompt,spec) values(${row.watch_id},${row.user_id},1,${row.original_prompt},${tx.json(compiledSpec)}) returning id`
        )[0];
        const versionId = z.string().uuid().parse(inserted?.id);

        await tx`update public.watches set name=${compiledSpec.name},pending_version_id=${versionId},desired_state='running',error=null where id=${row.watch_id}`;
      });
      version = compiledSpec;
    }

    ExecutableWatchSpecSchema.parse(version);

    let deployment = (
      await sql`select id,artifact_hash,state,proof from public.pipeline_deployments where workflow_id=${row.id}`
    )[0];

    if (!deployment) {
      deployment = (
        await sql`insert into public.pipeline_deployments(watch_id,user_id,version_id,workflow_id)
        select ${row.watch_id},${row.user_id},v.id,${row.id} from public.watch_versions v where v.watch_id=${row.watch_id} order by v.version desc limit 1 returning id,artifact_hash,state,proof`
      )[0];
    }

    const readyDeployment = z
      .object({
        id: z.string().uuid(),
        artifact_hash: z.string().nullable(),
        proof: z.record(z.string(), z.unknown()).nullable(),
        state: z.string(),
      })
      .parse(deployment);
    const deploymentId = readyDeployment.id;

    if (
      !readyDeployment.artifact_hash ||
      readyDeployment.proof?.pipelineStatus !== "PIPELINE_VERIFIED" ||
      !readyDeployment.proof?.intentAcceptanceStatus
    ) {
      const previousAttempts =
        await sql`select error_code from public.pipeline_build_attempts where workflow_id=${row.id} order by attempt`;
      const attempt = previousAttempts.length + 1;
      const repairAttempts = previousAttempts.filter((item) =>
        consumesRepairBudget(String(item.error_code ?? "")),
      ).length;

      if (repairAttempts >= 4) {
        throw new Error(
          "The four-attempt build budget is exhausted. Review the persisted compiler diagnostics before retrying.",
        );
      }

      const attemptId = z
        .string()
        .uuid()
        .parse(
          (
            await sql`insert into public.pipeline_build_attempts(workflow_id,deployment_id,attempt,status) values(${row.id},${deploymentId},${attempt},'running') returning id`
          )[0]?.id,
        );

      try {
        const result = await buildDeployment(
          sql,
          storage,
          config,
          rpc,
          deploymentId,
          signal,
          async (stage, title, summary, metadata) => {
            const complete = /passed|created|verified|integrity/i.test(title);

            await append(
              sql,
              row.id,
              stage,
              `pipeline.${stage.toLowerCase()}`,
              complete ? "complete" : "active",
              title,
              summary,
              metadata,
            );
          },
        );

        await put(sql, row.id, "verification", result.verification);
        VerificationReportSchema.parse(result.verification);
        await sql`update public.pipeline_build_attempts set status='passed',completed_at=now(),diagnostics=${sql.json({ verification: result.verification.status })} where id=${attemptId}`;
      } catch (error) {
        await sql`update public.pipeline_build_attempts set status='failed',completed_at=now(),error_code=${buildFailureCode(error)},diagnostics=${sql.json({ message: safeDiagnostic(error) })} where id=${attemptId}`;

        throw error;
      }
    }

    await append(
      sql,
      row.id,
      "DEPLOYING",
      "deployment.connected",
      "complete",
      "Live stream prepared",
      "The verified package is ready for the durable streaming consumer.",
      { deploymentId },
    );
    await append(
      sql,
      row.id,
      "DEPLOYMENT_VERIFYING",
      "deployment.verifying",
      "active",
      "Verifying live connection",
      "Scout will remain here until the worker receives real finalized chain data.",
      { deploymentId },
    );
  } catch (error) {
    const transientCode = buildFailureCode(error);

    if (
      ["RPC_RATE_LIMIT", "PROVIDER_TIMEOUT", "SUBSTREAMS_CAPACITY"].includes(
        transientCode,
      )
    ) {
      throw new IntegrationError(transientCode, safeDiagnostic(error), 30);
    }

    if (
      error instanceof IntegrationError &&
      (error.retryAfterSeconds !== null ||
        error.code === "NETWORK" ||
        /^HTTP_5/.test(error.code))
    ) {
      throw error;
    }

    const current = (
      await sql`select state from public.watch_workflows where id=${row.id}`
    )[0]?.state as string | undefined;

    await failWorkflow(
      sql,
      row.id,
      workflowCategory(current ?? row.state),
      error instanceof IntegrationError ? error.code : "WORKFLOW_ERROR",
      safeDiagnostic(error),
      error instanceof IntegrationError ||
        !String(error).includes("unsupported"),
    );
  }
}
