import { protocolProfileForIntent } from "./protocols";

import type { WatchIntentSpec, WatchWorkflow } from "./workflow";

/** Reject known missing capabilities even when network/version still need clarification. */
export function unavailableIntentCapability(intent: WatchIntentSpec) {
  if (protocolProfileForIntent(intent).id !== "uniswap") {
    return null;
  }

  if (
    !["liquidity_removal", "liquidity_addition"].includes(
      intent.activity.type.value,
    )
  ) {
    return null;
  }

  if (
    intent.filters.some(
      (filter) =>
        filter.unit?.toUpperCase() === "USD" || /usd|value/i.test(filter.field),
    )
  ) {
    return {
      code: "LIQUIDITY_USD_UNAVAILABLE",
      message:
        "Scout can detect Uniswap V4 liquidity changes on Ethereum, but cannot yet determine their dollar value. Your requested threshold is saved unchanged. To monitor removals now, create a separate V4 Watch without a value threshold.",
    };
  }

  const version = intent.subject.protocolVersion?.value.toLowerCase();

  if (version && !["v4", "4"].includes(version)) {
    return {
      code: "LIQUIDITY_VERSION_UNAVAILABLE",
      message:
        "Liquidity-change monitoring currently supports Uniswap V4 on Ethereum without value thresholds. This request selects a different version. Scout has kept your request unchanged.",
    };
  }

  return null;
}

export function isCapabilityUnavailable(code: string | null) {
  return [
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
          : workflow.errorMessage) ??
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

  return {
    label: "Setting up",
    title: last?.title ?? "Your request is queued",
    message:
      last?.summary ??
      "Scout will check support before preparing the data pipeline.",
    note: "Monitoring starts only after setup and verification succeed.",
    unsupported: false,
  };
}
