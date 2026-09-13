import { z } from "zod";

import { compileExecutableSpec } from "../planning";
import { resolveWatchStarter, WATCH_STARTERS } from "../watch-starters";

import { DATA_CAPABILITIES, type DataCapability } from "./capabilities";
import { migrateExecutableProgram } from "./compatibility";
import { MetricSchema } from "./program";
import { validateProgram } from "./validation";

export const CapabilityStatusSchema = z.enum([
  "VERIFIED",
  "AVAILABLE",
  "PARTIAL",
  "REQUIRES_PIPELINE",
  "UNSUPPORTED",
]);

export const CapabilityItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: CapabilityStatusSchema,
});

export const CapabilityCatalogSchema = z.object({
  protocols: z.array(
    z.object({
      id: z.string(),
      protocol: z.string(),
      title: z.string(),
      version: z.string().nullable(),
      description: z.string(),
      chains: z.array(z.string()),
      status: CapabilityStatusSchema,
      activities: z.array(z.string()),
      fields: z.array(CapabilityItemSchema),
      operations: z.array(CapabilityItemSchema),
      limitations: z.array(z.string()),
      verification: z.string(),
    }),
  ),
  chains: z.array(z.string()),
  runtime: z.array(CapabilityItemSchema),
  examples: z.array(
    z.object({
      id: z.string(),
      adapterId: z.string(),
      label: z.string(),
      description: z.string(),
      prompt: z.string(),
    }),
  ),
});

export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;

/** Vocabulary only. Availability is always derived from installed data and runtime definitions. */
export const capabilityLabels: Record<string, string> = {
  actor: "Observed wallet",
  participant: "Identifiable trading wallet",
  sender: "Sending wallet",
  recipient: "Receiving wallet",
  subject: "Pool or token identity",
  contract: "Contract identity",
  protocol: "Protocol identity",
  eventType: "Onchain activity",
  transaction: "Transaction details",
  asset: "Token identity",
  direction: "Buy / sell direction",
  amount: "Token amount",
  valueMicros: "USD value",
  valuationSource: "Value source",
  metric: "Liquidity increase or decrease",
  count: "Count events",
  sum: "Add amounts",
  average: "Calculate averages",
  min: "Find the smallest amount",
  max: "Find the largest amount",
  median: "Find the middle amount",
  unique_count: "Count unique wallets",
  absolute_delta: "Watch for amount changes",
  percentage_delta: "Watch for percentage changes",
  rolling: "Watch activity over a time window",
  event: "Check each onchain event",
  prior_activity: "Check whether a wallet used this protocol before",
  grouping: "Group activity by token or wallet",
  threshold: "Apply amount thresholds",
  wallet_filter: "Filter by wallet",
};

export function capabilityLabel(key: string) {
  return capabilityLabels[key] ?? "Additional monitoring condition";
}

export function chainLabel(id: number) {
  return (
    (
      {
        1: "Ethereum",
        8453: "Base",
        42161: "Arbitrum",
        10: "Optimism",
      } as Record<number, string>
    )[id] ?? `Chain ${id}`
  );
}

export function protocolName(protocol: string) {
  return protocol.startsWith("uniswap")
    ? "Uniswap"
    : protocol === "erc20"
      ? "ERC-20"
      : protocol;
}

/** Safe public projection: no contracts, package paths, provider identifiers or account data. */
export function getCapabilityCatalog(
  registry: readonly DataCapability[] = DATA_CAPABILITIES,
): CapabilityCatalog {
  const runtime = [
    ...MetricSchema.shape.operation.options,
    "event",
    "rolling",
    "grouping",
    "threshold",
    "wallet_filter",
  ].map((id) => ({
    id,
    title: capabilityLabel(id),
    description:
      "Available in Scout’s monitoring engine. Each combination needs compatible data and Watch verification.",
    status: "AVAILABLE" as const,
  }));
  const protocols = registry.map((entry) => {
    const fields = Object.entries(entry.fields).map(([id, field]) => ({
      id,
      title:
        id === "valueMicros" && entry.eventType === "liquidity_change"
          ? "USD value of removed liquidity"
          : id === "direction" && entry.eventType === "transfer"
            ? "Transfer direction"
            : capabilityLabel(id),
      description:
        field.status === "UNAVAILABLE"
          ? "Scout cannot reliably provide this value yet."
          : field.status === "DERIVABLE"
            ? "Scout derives this from available activity and checks it before use."
            : "Available from this data source.",
      status:
        field.status === "UNAVAILABLE"
          ? ("UNSUPPORTED" as const)
          : ("AVAILABLE" as const),
    }));
    const operations = runtime.filter(
      (op) =>
        op.id === "event" ||
        (op.id === "threshold" &&
          fields.some(
            (f) =>
              ["amount", "valueMicros"].includes(f.id) &&
              f.status !== "UNSUPPORTED",
          )),
    );

    if (entry.historicalProviders.length) {
      operations.push({
        id: "prior_activity",
        title: capabilityLabel("prior_activity"),
        description:
          "Earlier blockchain activity is checked. Missing or incomplete history stays unknown.",
        status: "AVAILABLE",
      });
    }

    return {
      id: entry.id,
      protocol: protocolName(entry.protocol),
      ...entry.presentation,
      status: entry.status,
      chains: [chainLabel(entry.chainId)],
      activities: [entry.eventType],
      fields,
      operations,
      limitations: [
        "Scout monitors finalized onchain activity, not pending transactions.",
        ...entry.presentation.limitations,
      ],
      verification:
        entry.status === "VERIFIED"
          ? "Tested against real blockchain data. Every new Watch still needs its own verification."
          : "An installed data source is available. Scout verifies each Watch before activation; this listing is not a live provider health check.",
    };
  });
  const examples = WATCH_STARTERS.flatMap((starter) => {
    try {
      const intent = resolveWatchStarter(starter.prompt)!;
      const program = migrateExecutableProgram(compileExecutableSpec(intent));

      if (!program) {
        return [];
      }

      const result = validateProgram(program, registry);
      const adapter = registry.find(
        (a) => a.id === result.capabilityPlan?.adapterId,
      );

      if (
        result.status !== "PROGRAM_VALIDATED" ||
        !adapter ||
        ["UNSUPPORTED", "REQUIRES_PIPELINE"].includes(adapter.status)
      ) {
        return [];
      }

      return [{ ...starter, adapterId: adapter.id }];
    } catch {
      return [];
    }
  });

  return {
    protocols,
    chains: [...new Set(protocols.flatMap((p) => p.chains))],
    runtime,
    examples,
  };
}
