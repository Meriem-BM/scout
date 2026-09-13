import { workflowLabel } from "./workflow";

import type { Snapshot, Watch } from "./product";

export function watchChannels(watch: Watch, state: Snapshot) {
  if (!watch.spec) {
    return state.preferences;
  }

  return watch.spec.notifications.useDefaults
    ? state.preferences
    : watch.spec.notifications;
}

export function watchHealth(watch: Watch, state: Snapshot, now: number) {
  const channels = watchChannels(watch, state);
  const latest = state.incidents
    .filter((i) => i.watchId === watch.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const failedDelivery =
    latest?.deliveryStates.some(
      (d) =>
        channels[d.channel] &&
        ["failed", "bounced", "suppressed", "ambiguous"].includes(d.status),
    ) ?? false;

  const muted = !!watch.mutedUntil && Date.parse(watch.mutedUntil) > now;
  const telegram =
    channels.telegram &&
    state.telegram.connected &&
    !state.telegram.error &&
    (!state.telegram.mutedUntil ||
      Date.parse(state.telegram.mutedUntil) <= now);
  const email =
    channels.email &&
    state.emailConnection.verified &&
    state.emailConnection.enabled &&
    !state.emailConnection.suppressed;
  const stopped = ["draft", "paused", "archived"].includes(watch.status);
  const preparing = [
    "preparing",
    "checking",
    "starting",
    "backfilling",
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
  ].includes(watch.status);
  const stale =
    !stopped &&
    !preparing &&
    (!state.worker.online ||
      !watch.lastBlockTime ||
      (watch.lastMessageAt !== null &&
        watch.lastMessageAt !== undefined &&
        now - Date.parse(watch.lastMessageAt) > 180_000) ||
      now - Date.parse(watch.lastBlockTime) > 20 * 60_000);

  return {
    operation: watch.workflowStage
      ? workflowLabel(watch.workflowStage)
      : watch.status === "checking"
        ? "Validating"
        : watch.status === "delayed"
          ? "Watching"
          : watch.status,
    data:
      watch.status === "failed"
        ? "Unavailable"
        : stopped
          ? "Not processing"
          : watch.status === "backfilling"
            ? "Backfilling"
            : preparing
              ? "Waiting for data"
              : stale || watch.status === "delayed"
                ? "Delayed"
                : "Current",
    delivery: failedDelivery
      ? "Delivery failed"
      : muted
        ? "Muted"
        : !channels.telegram && !channels.email
          ? "Not configured"
          : !telegram && !email
            ? "Needs connection"
            : (channels.telegram && !telegram) || (channels.email && !email)
              ? "Partially available"
              : "Ready",
    needsAttention:
      failedDelivery ||
      !!watch.error ||
      stale ||
      watch.status === "failed" ||
      (!stopped &&
        !muted &&
        ((!telegram && channels.telegram) ||
          (!email && channels.email) ||
          (!channels.telegram && !channels.email))),
    telegram: !!telegram,
    email: !!email,
    muted,
    preparing,
  };
}

export function safeDestination(value: string | null, fallback = "/watches") {
  return value &&
    /^\/(?:watches|new|connections|settings|proof|swap|email\/verify)(?:[/?]|$)/.test(
      value,
    ) &&
    !value.includes("\\")
    ? value
    : fallback;
}
