import { z } from "zod";

import { WatchCapabilityExplanationSchema } from "./monitoring/explanation";
import { WATCH_ACTIVITY_TYPES } from "./protocols";

export const WorkflowStageSchema = z.enum([
  "RECEIVED",
  "INTENT_RESOLVING",
  "NEEDS_CLARIFICATION",
  "INTENT_READY",
  "DATA_PLANNING",
  "PACKAGE_DISCOVERY",
  "PACKAGE_EVALUATION",
  "PIPELINE_PLANNING",
  "PLAN_VALIDATION",
  "CODE_GENERATING",
  "BUILDING",
  "BUILD_REPAIRING",
  "TESTING",
  "SEMANTIC_VERIFYING",
  "VERIFICATION_REPAIRING",
  "PACKAGING",
  "DEPLOYING",
  "DEPLOYMENT_VERIFYING",
  "CATCHING_UP",
  "LIVE",
  "FAILED",
]);

export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export const WorkflowErrorCategorySchema = z.enum([
  "INTENT",
  "PACKAGE_DISCOVERY",
  "PLAN",
  "GENERATION",
  "BUILD",
  "VERIFICATION",
  "DEPLOYMENT",
  "STREAM",
  "INVESTIGATION",
  "DELIVERY",
]);

export type WorkflowErrorCategory = z.infer<typeof WorkflowErrorCategorySchema>;

export function workflowErrorCategory(
  stage: WorkflowStage,
): WorkflowErrorCategory {
  if (
    stage === "RECEIVED" ||
    stage === "NEEDS_CLARIFICATION" ||
    stage.startsWith("INTENT")
  ) {
    return "INTENT";
  }

  if (stage.startsWith("PACKAGE")) {
    return "PACKAGE_DISCOVERY";
  }

  if (stage.includes("PLAN")) {
    return "PLAN";
  }

  if (stage === "CODE_GENERATING") {
    return "GENERATION";
  }

  if (stage === "DEPLOYING" || stage === "DEPLOYMENT_VERIFYING") {
    return "DEPLOYMENT";
  }

  if (stage === "CATCHING_UP" || stage === "LIVE") {
    return "STREAM";
  }

  if (
    stage === "TESTING" ||
    stage === "SEMANTIC_VERIFYING" ||
    stage === "VERIFICATION_REPAIRING"
  ) {
    return "VERIFICATION";
  }

  return "BUILD";
}

export const WorkflowEventStatusSchema = z.enum([
  "pending",
  "active",
  "complete",
  "warning",
  "failed",
]);

export const WorkflowEventSchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  stage: WorkflowStageSchema,
  type: z.string().min(1).max(80),
  status: WorkflowEventStatusSchema,
  title: z.string().min(1).max(160),
  summary: z.string().max(1000).nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});

export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

export const ProvenanceSchema = z.enum([
  "explicit",
  "inferred",
  "default",
  "resolved",
]);

const sourced = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    source: ProvenanceSchema,
    confidence: z.number().min(0).max(1),
  });

export const UnresolvedFieldSchema = z.object({
  field: z.string().min(1).max(80),
  classification: z.enum(["SAFE_TO_INFER", "DEFAULTABLE", "BLOCKING"]),
  reason: z.string().min(1).max(500),
});

export const WatchIntentSpecSchema = z.object({
  version: z.literal(1),
  subject: z.object({
    chain: sourced(
      z.enum(["ethereum", "base", "arbitrum", "optimism"]),
    ).nullable(),
    protocol: sourced(z.string().min(1).max(80)).nullable(),
    protocolVersion: sourced(z.string().min(1).max(40)).nullable(),
    contracts: z.array(sourced(z.string())).max(20).default([]),
    tokens: z
      .array(sourced(z.string().min(1).max(128)))
      .max(10)
      .default([]),
    wallets: z.array(sourced(z.string())).max(20).default([]),
    actorRole: sourced(z.enum(["transaction_initiator", "contract_caller"]))
      .nullable()
      .default(null),
  }),
  activity: z.object({
    type: sourced(z.enum(WATCH_ACTIVITY_TYPES)),
    event: sourced(z.string()).nullable(),
    direction: sourced(z.enum(["buy", "sell", "either"])).nullable(),
  }),
  filters: z
    .array(
      z.object({
        field: z.string().min(1).max(80),
        operator: z.enum(["gt", "gte", "lt", "lte", "eq", "in"]),
        value: z.union([z.string(), z.number(), z.array(z.string())]),
        unit: z.string().max(24).nullable(),
        source: ProvenanceSchema,
      }),
    )
    .max(20),
  temporal: z.object({
    mode: sourced(z.enum(["continuous", "bounded"])),
    comparisonWindowSeconds: sourced(z.number().int().positive()).nullable(),
    evaluationWindowSeconds: sourced(z.number().int().positive()).nullable(),
  }),
  investigation: z.array(sourced(z.string().min(1).max(160))).max(10),
  investigationRequirements: z
    .array(
      z.object({
        kind: z.literal("no_prior_activity"),
        protocol: z.literal("uniswap_v3"),
        actor: z.literal("transaction_initiator"),
        scope: z.literal("all_protocol_pools"),
      }),
    )
    .max(1)
    .default([]),
  delivery: z.array(sourced(z.enum(["telegram", "email"]))).max(2),
  assumptions: z.array(z.string().min(1).max(500)).max(20),
  unresolved: z.array(UnresolvedFieldSchema).max(20),
});

export type WatchIntentSpec = z.infer<typeof WatchIntentSpecSchema>;

export function intentReadiness(intent: WatchIntentSpec) {
  const blocking = intent.unresolved.filter(
    (field) => field.classification === "BLOCKING",
  );
  const defaults = intent.unresolved.filter(
    (field) => field.classification === "DEFAULTABLE",
  );

  return { ready: blocking.length === 0, blocking, defaults };
}

export const ClarificationSchema = z.object({
  id: z.string().uuid(),
  field: z.string().min(1).max(80),
  reason: z.string().min(1).max(500),
  question: z.string().min(1).max(500),
  choices: z
    .array(
      z.object({
        value: z.string().min(1).max(200),
        label: z.string().min(1).max(120),
        recommended: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(8),
  allowCustom: z.boolean().default(false),
  status: z.enum(["open", "answered", "cancelled"]),
  answer: z.string().nullable(),
  createdAt: z.string(),
});

export type Clarification = z.infer<typeof ClarificationSchema>;

export const DataRequirementSpecSchema = z.object({
  version: z.literal(1),
  chain: z.string(),
  protocolProfile: z.string().min(1).default("generic-evm"),
  protocolName: z.string().min(1).default("Unspecified protocol"),
  protocolVersion: z.string().nullable().default(null),
  requiredStreams: z.array(
    z.object({
      domain: z.string(),
      protocol: z.string().nullable(),
      entity: z.string(),
      fields: z.array(z.string()).min(1),
    }),
  ),
  deterministicDerivedFields: z.array(z.string()),
  historicalQueries: z.array(z.string()),
  realtimeRequirements: z.object({
    continuous: z.boolean(),
    reorgAware: z.boolean(),
    finality: z.enum(["finalized", "irreversible"]),
  }),
  applicationResponsibilities: z.array(z.string()),
  packageHints: z
    .object({
      queries: z.array(z.string()).min(1),
      compatibilityTerms: z.array(z.string()).min(1),
    })
    .default({
      queries: ["blockchain events"],
      compatibilityTerms: ["events"],
    }),
  execution: z
    .object({
      status: z.enum(["verified", "planning"]),
      executorId: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .default({
      status: "planning",
      executorId: null,
      reason: "Execution capability has not been established.",
    }),
  verificationFields: z.array(z.string()).default([]),
});

export type DataRequirementSpec = z.infer<typeof DataRequirementSpecSchema>;

export const PackageCandidateSchema = z.object({
  ref: z.string(),
  name: z.string(),
  version: z.string(),
  network: z.string().nullable(),
  publisher: z.string().nullable(),
  modules: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      outputType: z.string().nullable(),
      initialBlock: z.string().nullable(),
      outputFields: z.array(z.string()).default([]),
      matchingFields: z.array(z.string()).default([]),
      dependencyGraphValid: z.boolean().default(false),
    }),
  ),
  outputs: z.array(z.string()),
  parameters: z.array(z.string()),
  dependencies: z.array(z.string()),
  registryUrl: z.url().nullable().default(null),
  packageUrl: z.url().nullable(),
  sourceUrl: z.url().nullable(),
  evidence: z.object({
    matchingFields: z.array(z.string()),
    missingFields: z.array(z.string()),
    networkCompatible: z.boolean(),
    protocolCompatible: z.boolean(),
    packageResolved: z.boolean(),
  }),
  trustSignals: z.object({
    publisher: z.string().nullable(),
    downloads: z.number().int().nonnegative().nullable(),
    freshness: z.string().nullable(),
    sourceAvailable: z.boolean(),
  }),
  score: z.number(),
});

export type PackageCandidate = z.infer<typeof PackageCandidateSchema>;

export function substreamsRegistryUrl(ref: string): string | null {
  const match = /^([a-z0-9][a-z0-9-]*)@(v[0-9][a-zA-Z0-9.-]*)$/.exec(ref);

  return match
    ? `https://substreams.dev/packages/${match[1]}/${match[2]}`
    : null;
}

export const PipelineStrategySchema = z.enum([
  "REUSE",
  "PARAMETERIZE",
  "COMPOSE",
  "EXTEND",
  "GENERATE",
]);

export const PackageResolutionSchema = z.object({
  selectedRef: z.string(),
  selectedModule: z.string().nullable().default(null),
  strategy: PipelineStrategySchema,
  summary: z.string(),
  reasons: z.array(z.string()),
  alternatives: z.array(
    z.object({ ref: z.string(), reason: z.string(), score: z.number() }),
  ),
  candidates: z.array(PackageCandidateSchema),
});

export type PackageResolution = z.infer<typeof PackageResolutionSchema>;

export const PipelinePlanSchema = z.object({
  version: z.literal(1),
  chain: z.string(),
  protocol: z
    .object({
      profileId: z.string(),
      name: z.string(),
      version: z.string().nullable(),
      activity: z.enum(WATCH_ACTIVITY_TYPES),
    })
    .default({
      profileId: "generic-evm",
      name: "Unspecified protocol",
      version: null,
      activity: "contract_event",
    }),
  execution: z
    .object({
      status: z.enum(["verified", "planning"]),
      executorId: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .default({
      status: "planning",
      executorId: null,
      reason: "Execution capability has not been established.",
    }),
  strategy: PipelineStrategySchema,
  dependencies: z.array(
    z.object({
      packageRef: z.string(),
      module: z.string(),
      purpose: z.string(),
    }),
  ),
  parameters: z.array(
    z.object({ module: z.string(), name: z.string(), value: z.string() }),
  ),
  generatedModules: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["map", "store"]),
      inputs: z.array(z.string()),
      outputType: z.string(),
      purpose: z.string(),
    }),
  ),
  protoMessages: z.array(z.string()),
  requiredArtifacts: z.array(z.string()),
  startBlock: z.string().nullable(),
  sink: z.object({
    type: z.enum(["scout-consumer"]),
    config: z.record(z.string(), z.unknown()),
  }),
  applicationRules: z.array(z.string()),
  verificationPlan: z.array(z.string()),
  selectionReasons: z.array(z.string()),
  critic: z.object({
    passed: z.boolean(),
    findings: z.array(
      z.object({
        severity: z.enum(["info", "warning", "critical"]),
        message: z.string(),
      }),
    ),
  }),
});

export type PipelinePlan = z.infer<typeof PipelinePlanSchema>;

export const VerificationReportSchema = z.object({
  pipelineStatus: z.enum(["PIPELINE_VERIFIED", "FAILED"]).optional(),
  intentAcceptance: z
    .object({
      status: z.enum(["INTENT_ACCEPTANCE_VERIFIED", "NOT_APPLICABLE"]),
      basis: z.string(),
      cases: z.array(z.object({ name: z.string(), passed: z.boolean() })),
    })
    .optional(),
  status: z.enum(["verified", "partial", "failed"]),
  confidence: z.enum(["high", "medium", "low"]),
  buildPassed: z.boolean(),
  execution: z.object({
    fromBlock: z.string(),
    toBlock: z.string(),
    blocksTested: z.number().int().nonnegative(),
    eventsObserved: z.number().int().nonnegative(),
    errors: z.array(z.string()),
  }),
  comparisons: z.array(
    z.object({
      field: z.string(),
      expected: z.string(),
      actual: z.string(),
      matched: z.boolean(),
    }),
  ),
  duplicateCheck: z.object({
    passed: z.boolean(),
    count: z.number().int().nonnegative(),
  }),
  missingEventCheck: z.object({
    passed: z.boolean(),
    count: z.number().int().nonnegative(),
  }),
  referenceSource: z.string(),
  findings: z.array(z.string()),
  checkedAt: z.string(),
});

export type VerificationReport = z.infer<typeof VerificationReportSchema>;

export const WatchWorkflowSchema = z.object({
  id: z.string().uuid(),
  watchId: z.string().uuid(),
  state: WorkflowStageSchema,
  originalPrompt: z.string(),
  errorCategory: WorkflowErrorCategorySchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  recoverable: z.boolean(),
  events: z.array(WorkflowEventSchema),
  clarification: ClarificationSchema.nullable(),
  capabilities: WatchCapabilityExplanationSchema.optional(),
  outputs: z.object({
    intent: WatchIntentSpecSchema.nullable(),
    dataRequirements: DataRequirementSpecSchema.nullable(),
    packageResolution: PackageResolutionSchema.nullable(),
    pipelinePlan: PipelinePlanSchema.nullable(),
    verification: VerificationReportSchema.nullable(),
  }),
  updatedAt: z.string(),
});

export type WatchWorkflow = z.infer<typeof WatchWorkflowSchema>;

const linearOrder = WorkflowStageSchema.options.filter(
  (stage) => !["NEEDS_CLARIFICATION", "FAILED"].includes(stage),
);

export function canTransition(from: WorkflowStage, to: WorkflowStage) {
  if (from === to) {
    return true;
  }

  if (to === "FAILED" || to === "NEEDS_CLARIFICATION") {
    return from !== "LIVE";
  }

  if (from === "NEEDS_CLARIFICATION") {
    return to === "INTENT_RESOLVING";
  }

  if (from === "FAILED") {
    return (
      to === "INTENT_RESOLVING" ||
      to === "PACKAGE_DISCOVERY" ||
      to === "BUILDING" ||
      to === "SEMANTIC_VERIFYING" ||
      to === "DEPLOYING"
    );
  }

  return linearOrder.indexOf(to) > linearOrder.indexOf(from);
}

export const workflowLabel = (stage: WorkflowStage) =>
  ({
    RECEIVED: "Queued",
    INTENT_RESOLVING: "Understanding request",
    NEEDS_CLARIFICATION: "Needs one detail",
    INTENT_READY: "Request understood",
    DATA_PLANNING: "Planning blockchain data",
    PACKAGE_DISCOVERY: "Finding data sources",
    PACKAGE_EVALUATION: "Evaluating packages",
    PIPELINE_PLANNING: "Designing pipeline",
    PLAN_VALIDATION: "Validating architecture",
    CODE_GENERATING: "Generating module",
    BUILDING: "Building pipeline",
    BUILD_REPAIRING: "Repairing build",
    TESTING: "Testing onchain history",
    SEMANTIC_VERIFYING: "Verifying correctness",
    VERIFICATION_REPAIRING: "Repairing verification",
    PACKAGING: "Packaging pipeline",
    DEPLOYING: "Connecting live stream",
    DEPLOYMENT_VERIFYING: "Verifying live connection",
    CATCHING_UP: "Catching up",
    LIVE: "Live",
    FAILED: "Setup stopped",
  })[stage];
