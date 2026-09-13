import { z } from "zod";

import { dataPlanningClarification } from "../intent-clarification";
import { compileExecutableSpec } from "../planning";
import { protocolProfileForIntent } from "../protocols";

import {
  DATA_CAPABILITIES,
  type DataCapability,
  planProgramCapabilities,
} from "./capabilities";
import { capabilityLabel, chainLabel } from "./catalog";
import { migrateExecutableProgram } from "./compatibility";
import { WatchProgramSchema } from "./program";

import type { WatchIntentSpec } from "../workflow";
import type { CapabilityPlan } from "./capabilities";
import type { WatchProgram } from "./program";

export const WatchCapabilityExplanationSchema = z.object({
  state: z.enum([
    "UNDERSTANDING",
    "UNDERSTOOD",
    "NEEDS_DETAIL",
    "MISSING",
    "READY_TO_BUILD",
  ]),
  requirements: z.array(
    z.object({
      title: z.string(),
      status: z.enum(["available", "missing", "detail"]),
      explanation: z.string(),
    }),
  ),
  limitations: z.array(z.string()),
  program: WatchProgramSchema.nullable(),
  // The original planner record is kept for advanced inspection only.
  plan: z.unknown().nullable(),
});

export type WatchCapabilityExplanation = z.infer<
  typeof WatchCapabilityExplanationSchema
>;

/** Read-only explanation of the same compiler and registry used by the worker.
 * It never grants activation, invents scope, or removes a requested condition. */
export function explainWatchCapabilities(
  intent: WatchIntentSpec | null,
  savedProgram?: WatchProgram | null,
  registry: readonly DataCapability[] = DATA_CAPABILITIES,
): WatchCapabilityExplanation {
  if (!intent && !savedProgram) {
    return {
      state: "UNDERSTANDING",
      requirements: [],
      limitations: [],
      program: null,
      plan: null,
    };
  }

  let program = savedProgram ?? null;
  let compilerRejected = false;

  if (!program && intent) {
    try {
      program = migrateExecutableProgram(compileExecutableSpec(intent));
      compilerRejected = !program;
    } catch {
      compilerRejected = true;
    }
  }

  const requirements: WatchCapabilityExplanation["requirements"] = [];

  const add = (
    title: string,
    status: "available" | "missing" | "detail",
    explanation = "",
  ) => {
    if (!requirements.some((r) => r.title === title)) {
      requirements.push({ title, status, explanation });
    }
  };

  const profile = intent ? protocolProfileForIntent(intent) : null;
  const protocol =
    profile?.id === "generic-evm"
      ? intent?.subject.protocol?.value.toLowerCase()
      : profile?.id;
  const version = intent?.subject.protocolVersion?.value
    .toLowerCase()
    .replace(/^uniswap[_ -]?/, "");
  const chain = intent?.subject.chain?.value;
  const liquidity =
    intent &&
    ["liquidity_removal", "liquidity_addition"].includes(
      intent.activity.type.value,
    );
  const event = liquidity
    ? "liquidity_change"
    : intent?.activity.type.value === "volume_burst"
      ? "swap"
      : intent?.activity.type.value;
  const candidates = registry.filter(
    (a) =>
      (!protocol ||
        a.protocol === protocol ||
        a.protocol.startsWith(protocol + "_")) &&
      (!version ||
        a.presentation.version?.toLowerCase() === version ||
        a.presentation.version?.toLowerCase() === `v${version}`) &&
      (!chain || chainLabel(a.chainId).toLowerCase() === chain) &&
      a.eventType === event,
  );
  let plan: CapabilityPlan | null = null;
  let adapter = candidates.length === 1 ? candidates[0] : undefined;

  if (program) {
    plan = planProgramCapabilities(program, undefined, registry);
    adapter = registry.find((a) => a.id === plan?.adapterId);

    for (const dependency of plan.dependencies) {
      const { capability, category, status } = dependency;

      if (category === "delivery" || category === "chain") {
        continue;
      }

      const key = capability.split(":").at(-1)!;
      const label =
        capability === adapter?.id
          ? adapter.presentation.title
          : capability.startsWith("field:")
            ? capabilityLabel(key)
            : capability.startsWith("aggregate:")
              ? capabilityLabel(key)
              : capability.startsWith("window:")
                ? program.window.kind === "rolling"
                  ? `${program.window.seconds / 60}-minute window`
                  : capabilityLabel("event")
                : category === "context"
                  ? capabilityLabel("prior_activity")
                  : category === "valuation"
                    ? "Reliable value for the threshold"
                    : capability === "asset_projection"
                      ? "Choose the token to watch"
                      : capability === "source_scope"
                        ? "Choose the pool or contract scope"
                        : "Blockchain data for this scope";
      const available = ["AVAILABLE", "AVAILABLE_WITH_PARAMETERS"].includes(
        status,
      );

      add(
        label,
        available
          ? "available"
          : status === "REQUIRES_CLARIFICATION"
            ? "detail"
            : "missing",
        available
          ? ""
          : status === "REQUIRES_CLARIFICATION"
            ? "Scout needs this detail to preserve your request."
            : "The required data or monitoring condition is not available for this scope yet.",
      );
    }

    if (program.window.kind === "rolling") {
      for (const field of program.window.groupBy) {
        add(
          `Group by ${field === "asset" ? "token" : field === "actor" ? "wallet" : capabilityLabel(field).toLowerCase()}`,
          "available",
        );
      }
    }
  } else if (intent) {
    if (adapter) {
      add(
        adapter.presentation.title,
        ["UNSUPPORTED", "REQUIRES_PIPELINE"].includes(adapter.status)
          ? "missing"
          : "available",
      );

      if (liquidity) {
        for (const field of ["subject", "actor"]) {
          if (
            adapter.fields[field as "subject" | "actor"] &&
            adapter.fields[field as "subject" | "actor"]?.status !==
              "UNAVAILABLE"
          ) {
            add(capabilityLabel(field), "available");
          }
        }
      }
    } else if (protocol) {
      add(
        `${protocol === "erc20" ? "ERC-20" : protocol.charAt(0).toUpperCase() + protocol.slice(1)} data for this request`,
        "missing",
        "Scout does not have an installed data source for this activity, version and chain yet.",
      );
    } else {
      add("Choose the protocol or data source", "detail");
    }

    if (
      intent.activity.direction?.value &&
      intent.activity.direction.value !== "either"
    ) {
      add(
        `${intent.activity.direction.value === "buy" ? "Buy" : "Sell"} activity`,
        adapter?.fields.direction &&
          adapter.fields.direction.status !== "UNAVAILABLE"
          ? "available"
          : "missing",
      );
    }

    for (const filter of intent.filters) {
      const usd =
        filter.unit?.toUpperCase() === "USD" || /usd|value/i.test(filter.field);
      const unique = /unique|wallet|actor|participant/i.test(filter.field);
      const grouping =
        /^group_?by$/i.test(filter.field) && filter.value === "asset";

      add(
        usd && liquidity
          ? "USD value of removed liquidity"
          : grouping
            ? "Group by token"
            : unique
              ? "Count unique wallets"
              : usd
                ? "Amount threshold in USD"
                : "Requested monitoring condition",
        usd
          ? adapter?.fields.valueMicros &&
            adapter.fields.valueMicros.status !== "UNAVAILABLE"
            ? "available"
            : "missing"
          : (unique || grouping) && adapter
            ? "available"
            : "detail",
        usd && liquidity
          ? "Scout can monitor liquidity decreases, but cannot yet reliably calculate their USD value."
          : "",
      );
    }

    if (intent.temporal.evaluationWindowSeconds) {
      add(
        `${intent.temporal.evaluationWindowSeconds.value / 60}-minute window`,
        adapter ? "available" : "missing",
      );
    }

    if (intent.subject.wallets.length) {
      add(
        "Filter by wallet",
        "detail",
        "This filter must be supported by the selected Watch setup.",
      );
    }

    if (intent.investigationRequirements.length) {
      add(
        capabilityLabel("prior_activity"),
        adapter?.historicalProviders.length ? "available" : "missing",
      );
    }
  }

  if (intent && !requirements.some((r) => r.status === "missing")) {
    for (const field of intent.unresolved.filter(
      (f) => f.classification === "BLOCKING",
    )) {
      add("Confirm the requested scope", "detail", field.reason);
    }
  }

  if (intent && !requirements.some((r) => r.status === "missing")) {
    const question = dataPlanningClarification(intent);

    if (question) {
      add(
        "Confirm the pool, token or monitoring scope",
        "detail",
        question.question,
      );
    }
  }

  if (
    compilerRejected &&
    !requirements.some((r) => r.status === "missing" || r.status === "detail")
  ) {
    add(
      "Build and verify this combination",
      "missing",
      "Scout has some of the required tools, but cannot yet turn this exact combination into a verified Watch.",
    );
  }

  return {
    state: requirements.some((r) => r.status === "missing")
      ? "MISSING"
      : requirements.some((r) => r.status === "detail")
        ? "NEEDS_DETAIL"
        : program
          ? "READY_TO_BUILD"
          : "UNDERSTOOD",
    requirements,
    limitations: adapter
      ? [
          "Scout monitors finalized onchain activity, not pending transactions.",
          ...adapter.presentation.limitations,
        ]
      : [],
    program,
    plan,
  };
}
