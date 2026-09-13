import {
  DATA_CAPABILITIES,
  type DataCapability,
} from "./monitoring/capabilities";
import { protocolProfileForIntent } from "./protocols";

import type { WatchIntentSpec, WatchWorkflow } from "./workflow";

/** Reject known missing capabilities even when network/version still need clarification. */
export function unavailableIntentCapability(
  intent: WatchIntentSpec,
  registry: readonly DataCapability[] = DATA_CAPABILITIES,
) {
  const profile = protocolProfileForIntent(intent);
  const sources = registry.filter(
    (a) =>
      a.status !== "UNSUPPORTED" &&
      (a.protocol === profile.id || a.protocol.startsWith(profile.id + "_")),
  );

  if (intent.subject.protocol && sources.length === 0) {
    return {
      code: "DATA_SOURCE_UNAVAILABLE",
      message: `Scout understands this request, but ${profile.id === "generic-evm" ? intent.subject.protocol.value : profile.name} data is not currently available. Your request is saved unchanged.`,
    };
  }

  if (profile.id !== "uniswap") {
    return null;
  }

  if (
    !["liquidity_removal", "liquidity_addition"].includes(
      intent.activity.type.value,
    )
  ) {
    return null;
  }

  const version = intent.subject.protocolVersion?.value
    .toLowerCase()
    .replace(/^uniswap[_ -]?/, "")
    .replace(/^([34])$/, "v$1");
  const liquiditySources = sources.filter(
    (a) => a.eventType === "liquidity_change",
  );
  const matching = liquiditySources.filter(
    (a) => !version || a.presentation.version?.toLowerCase() === version,
  );

  if (
    !matching.some(
      (a) =>
        a.fields.valueMicros && a.fields.valueMicros.status !== "UNAVAILABLE",
    ) &&
    intent.filters.some(
      (filter) =>
        filter.unit?.toUpperCase() === "USD" || /usd|value/i.test(filter.field),
    )
  ) {
    return {
      code: "LIQUIDITY_USD_UNAVAILABLE",
      message:
        "Scout can see liquidity changes, but cannot yet reliably calculate their dollar value for this request. Your requested threshold is saved unchanged. Review the available capabilities before creating a different Watch.",
    };
  }

  if (version && matching.length === 0) {
    return {
      code: "LIQUIDITY_VERSION_UNAVAILABLE",
      message:
        "Scout does not have liquidity-change data for the requested protocol version yet. Your request is saved unchanged; review the available versions in Scout’s capability list.",
    };
  }

  return null;
}

export function isCapabilityUnavailable(code: string | null) {
  return [
    "DATA_SOURCE_UNAVAILABLE",
    "LIQUIDITY_USD_UNAVAILABLE",
    "LIQUIDITY_VERSION_UNAVAILABLE",
    "VERIFIED_EXECUTOR_UNAVAILABLE",
    "EXECUTABLE_SPEC_INVALID",
    "UNSUPPORTED_INTENT",
  ].includes(code ?? "");
}

export function workflowPresentation(workflow: WatchWorkflow) {
  if (workflow.state === "FAILED") {
    const unsupported = isCapabilityUnavailable(workflow.errorCode);
    const liquidity =
      workflow.outputs.intent &&
      unavailableIntentCapability(workflow.outputs.intent);

    return {
      label: unsupported ? "Not supported yet" : "Setup stopped",
      title:
        unsupported && liquidity?.code === "LIQUIDITY_USD_UNAVAILABLE"
          ? "Dollar-value liquidity alerts aren’t available yet"
          : unsupported
            ? "This monitoring setup isn’t supported yet"
            : "Your Watch could not start",
      message:
        (unsupported && liquidity
          ? liquidity.message
          : unsupported
            ? "Scout understands this request, but the required monitoring capability has not been verified yet. See the missing conditions above."
            : "Scout could not complete setup. Your request and completed work are saved. View technical details for the recorded error.") ??
        "Scout could not complete setup. Your request and completed work are saved.",
      note: "This Watch is not monitoring and will not send alerts.",
      unsupported,
    };
  }

  if (workflow.state === "LIVE") {
    return {
      label: "Live",
      title: "Your Watch is live",
      message:
        "Setup and verification completed. Open the Watch to see its current monitoring status.",
      note: "Alerts appear when the Watch’s conditions match.",
      unsupported: false,
    };
  }

  if (workflow.state === "NEEDS_CLARIFICATION") {
    return {
      label: "Your input needed",
      title: "Confirm what to monitor",
      message: "Scout needs this detail to preserve the scope of your request.",
      note: "Monitoring starts only after setup and verification succeed.",
      unsupported: false,
    };
  }

  const last = workflow.events.at(-1);

  if (last?.type === "workflow.retry.scheduled") {
    return {
      label: "Waiting for provider",
      title: "Scout will retry automatically",
      message:
        "A data or AI provider is temporarily unavailable. Your request is saved; you don’t need to submit it again.",
      note: "Monitoring has not started.",
      unsupported: false,
    };
  }

  const understanding = ["RECEIVED", "INTENT_RESOLVING"].includes(
    workflow.state,
  );
  const understood = workflow.state === "INTENT_READY";
  const verifying = /TEST|VERIF/.test(workflow.state);

  return {
    label: understood ? "Understood" : "Setting up",
    title: understanding
      ? "Understanding your request"
      : understood
        ? "Scout understands your request"
        : verifying
          ? "Checking this Watch before activation"
          : "Preparing the blockchain data",
    message: understanding
      ? "Scout is identifying the activity, scope and conditions you want to monitor."
      : understood
        ? "Next, Scout checks whether it has the data and monitoring tools needed."
        : verifying
          ? "Scout is testing the data and monitoring rules. Monitoring starts only after these checks pass."
          : "Scout is preparing and checking the data needed for this Watch.",
    note: "Monitoring starts only after setup and verification succeed.",
    unsupported: false,
  };
}
