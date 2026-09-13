import type {
  CapabilityCatalog,
  CapabilityStatus,
  WatchCapabilityExplanation,
} from "@scout/domain";

export const capabilityStatus = {
  VERIFIED: {
    label: "Ready",
    description: "Scout has tested this capability against real chain data.",
    tone: "ready",
  },
  AVAILABLE: {
    label: "Available",
    description:
      "Scout has the data or monitoring tool. Each Watch still needs its own verification.",
    tone: "available",
  },
  PARTIAL: {
    label: "Limited",
    description:
      "Some parts work, but Scout cannot support every condition yet.",
    tone: "limited",
  },
  REQUIRES_PIPELINE: {
    label: "Can be built",
    description:
      "Scout understands the data needed and can attempt to prepare the missing data pipeline.",
    tone: "limited",
  },
  UNSUPPORTED: {
    label: "Not available yet",
    description:
      "Scout understands the request, but the required data or monitoring tool is not available yet.",
    tone: "missing",
  },
} satisfies Record<
  CapabilityStatus,
  { label: string; description: string; tone: string }
>;

export function toCapabilityViewModel(
  entry: CapabilityCatalog["protocols"][number],
) {
  return {
    ...entry,
    status: capabilityStatus[entry.status],
    fields: entry.fields.map((f) => ({
      ...f,
      status: capabilityStatus[f.status],
    })),
    operations: entry.operations.map((o) => ({
      ...o,
      status: capabilityStatus[o.status],
    })),
  };
}

export function toWatchCapabilityViewModel(value: WatchCapabilityExplanation) {
  const copy = {
    UNDERSTANDING: [
      "Understanding your Watch",
      "Scout is reading your request before checking the data and monitoring tools it needs.",
    ],
    UNDERSTOOD: [
      "Request understood",
      "Scout understands what you want to monitor. It is checking whether the full Watch can be built.",
    ],
    NEEDS_DETAIL: [
      "Needs a detail",
      "Scout needs a detail to confirm the scope of your request.",
    ],
    MISSING: [
      "One or more parts are not available yet",
      "Scout understands this request, but a required capability is missing. This Watch cannot activate yet.",
    ],
    READY_TO_BUILD: [
      "Ready to build",
      "Scout has the data and monitoring tools needed to build this Watch. Verification and a healthy live stream are still required.",
    ],
  }[value.state];

  return {
    title: copy[0],
    description: copy[1],
    available: value.requirements.filter((r) => r.status === "available"),
    missing: value.requirements.filter((r) => r.status === "missing"),
    details: value.requirements.filter((r) => r.status === "detail"),
    limitations: value.limitations,
  };
}
