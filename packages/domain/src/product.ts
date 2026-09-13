import { z } from "zod";

import { ExecutableWatchSpecSchema } from "./erc20";
import { DetectionSchema, SwapEventSchema } from "./evidence";
import { PriorActivitySchema } from "./investigation";
import { WatchSpecSchema } from "./spec";
import { WatchIntentSpecSchema, WorkflowStageSchema } from "./workflow";

export const WatchSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  // Legacy swap presentation is separate from the executable contract.
  spec: ExecutableWatchSpecSchema.nullable().transform((spec) =>
    spec?.protocol === "erc20" ? null : spec,
  ),
  executableSpec: ExecutableWatchSpecSchema.nullable().optional(),
  intent: WatchIntentSpecSchema.nullable().optional(),
  status: z.enum([
    "draft",
    "preparing",
    "checking",
    "starting",
    "backfilling",
    "watching",
    "delayed",
    "paused",
    "failed",
    "archived",
    "received",
    "intent_resolving",
    "needs_clarification",
    "intent_ready",
    "data_planning",
    "package_discovery",
    "package_evaluation",
    "pipeline_planning",
    "plan_validation",
    "code_generating",
    "building",
    "build_repairing",
    "testing",
    "semantic_verifying",
    "verification_repairing",
    "packaging",
    "deploying",
    "deployment_verifying",
    "catching_up",
    "live",
    "degraded",
  ]),
  workflowId: z.string().uuid().nullable().optional(),
  workflowStage: WorkflowStageSchema.nullable().optional(),
  workflowUpdatedAt: z.string().nullable().optional(),
  version: z.number().int().nonnegative(),
  pendingVersion: z.number().int().nullable(),
  createdAt: z.string(),
  lastBlock: z.string().nullable(),
  lastBlockTime: z.string().nullable(),
  lastMessageAt: z.string().nullable().optional(),
  error: z.string().nullable(),
  mutedUntil: z.string().nullable(),
  lastEventAt: z.string().nullable(),
});

export type Watch = z.infer<typeof WatchSchema>;

export const ContextSchema = z.object({
  status: z.enum(["available", "partial", "unavailable"]),
  subgraphId: z.string(),
  deployment: z.string().nullable(),
  blockNumber: z.number().nullable(),
  blockHash: z.string().nullable(),
  refreshedAt: z.string(),
  from: z.number(),
  to: z.number(),
  sampledSwaps: z.number(),
  volumeUsd: z.string().nullable(),
  priorInitiatorTransactions: z.number().nullable(),
  priorActivityCoverage: z.string().optional(),
  priorActivity: PriorActivitySchema.optional(),
  note: z.string(),
});

export const ExplanationSchema = z.object({
  facts: z.array(
    z.object({ text: z.string(), evidenceIds: z.array(z.string()) }),
  ),
  interpretation: z.string(),
  unknowns: z.array(z.string()),
  source: z.enum(["model", "deterministic"]),
});

export type Explanation = z.infer<typeof ExplanationSchema>;

export const IncidentSchema = z.object({
  id: z.string(),
  watchId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  read: z.boolean(),
  status: z.enum(["open", "reviewed", "retracted"]),
  detection: DetectionSchema,
  spec: WatchSpecSchema,
  evidence: z.array(SwapEventSchema),
  context: ContextSchema.nullable(),
  explanation: ExplanationSchema.nullable(),
  deliveryStates: z
    .array(
      z.object({ channel: z.enum(["telegram", "email"]), status: z.string() }),
    )
    .default([]),
  delivery: z.enum([
    "inbox_only",
    "queued",
    "sent",
    "failed",
    "ambiguous",
    "muted",
  ]),
});

export type Incident = z.infer<typeof IncidentSchema>;

export const CollectionWatchSchema = WatchSchema.extend({
  recentIncidents: z.array(IncidentSchema).max(6).default([]),
});

export const PreferencesSchema = z.object({
  timezone: z.string().default("UTC"),
  telegram: z.boolean().default(true),
  email: z.boolean().default(false),
  cooldownSeconds: z.number().int().min(300).max(3600).default(900),
});

export const EmailConnectionSchema = z.object({
  address: z.string().nullable().default(null),
  verified: z.boolean().default(false),
  enabled: z.boolean().default(false),
  suppressed: z.boolean().default(false),
  error: z.string().nullable().default(null),
  pendingAddress: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  lastStatus: z.string().nullable().default(null),
  lastSentAt: z.string().nullable().default(null),
});

export const DeliverySchema = z.object({
  id: z.string(),
  channel: z.enum(["telegram", "email"]),
  status: z.string(),
  destination: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  error: z.string().nullable(),
  providerId: z.string().nullable(),
});

export type Delivery = z.infer<typeof DeliverySchema>;

export const SnapshotSchema = z.object({
  watches: z.array(WatchSchema),
  incidents: z.array(IncidentSchema),
  telegram: z.object({
    connected: z.boolean(),
    label: z.string().nullable(),
    mutedUntil: z.string().nullable(),
    error: z.string().nullable(),
  }),
  emailConnection: EmailConnectionSchema.default(() =>
    EmailConnectionSchema.parse({}),
  ),
  preferences: PreferencesSchema.default(() => PreferencesSchema.parse({})),
  worker: z.object({ online: z.boolean(), lastSeen: z.string().nullable() }),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

export const emptySnapshot = (): Snapshot => ({
  watches: [],
  incidents: [],
  telegram: { connected: false, label: null, mutedUntil: null, error: null },
  worker: { online: false, lastSeen: null },
  emailConnection: EmailConnectionSchema.parse({}),
  preferences: PreferencesSchema.parse({}),
});
