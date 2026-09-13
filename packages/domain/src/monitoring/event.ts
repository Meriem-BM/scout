import { z } from "zod";

import { AtomicNumber, type EventField, type WatchProgram } from "./program";

const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((x) => x.toLowerCase());
const Hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((x) => x.toLowerCase());

export const NormalizedOnchainEventSchema = z
  .object({
    id: z.string(),
    chainId: z.number().int().positive(),
    blockNumber: z.string().regex(/^\d+$/),
    blockHash: Hash,
    timestamp: z.number().int().nonnegative(),
    transactionHash: Hash,
    transactionIndex: z.number().int().nonnegative().nullable(),
    eventIndex: z.number().int().nonnegative(),
    actor: Address.nullable(),
    subject: z.union([Address, Hash]).nullable(),
    contract: Address,
    protocol: z.string().nullable(),
    eventType: z.string().min(1),
    assets: z
      .array(
        z
          .object({
            address: Address,
            direction: z.enum(["buy", "sell", "transfer"]).nullable(),
            rawAmount: z.string().regex(/^\d{1,78}$/),
            decimals: z.number().int().min(0).max(36),
            valuation: z
              .discriminatedUnion("kind", [
                z
                  .object({
                    kind: z.literal("nominal_stablecoin"),
                    valueMicros: AtomicNumber,
                    source: z.string(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("usd_price"),
                    valueMicros: AtomicNumber,
                    source: z.string(),
                    blockNumber: z.string(),
                    timestamp: z.number().int(),
                    stale: z.boolean(),
                  })
                  .strict(),
              ])
              .nullable(),
          })
          .strict(),
      )
      .max(32),
    attributes: z.record(
      z.string().max(64),
      z.union([z.string().max(512), z.boolean(), z.null()]),
    ),
    provenance: z
      .object({
        source: z.enum(["substreams", "subgraph_preview"]),
        package: z.string(),
        module: z.string(),
        decoder: z.string(),
        pipelineVersion: z.string(),
      })
      .strict(),
    finalized: z.literal(true),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.id !== normalizedEventIdentity(event)) {
      ctx.addIssue({
        code: "custom",
        message: "Event identity does not match canonical chain evidence.",
      });
    }

    if (
      new Set(event.assets.map((a) => a.address)).size !== event.assets.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Asset projections must be unique.",
      });
    }
  });

export type NormalizedOnchainEvent = z.infer<
  typeof NormalizedOnchainEventSchema
>;

export function normalizedEventIdentity(event: {
  chainId: number;
  blockHash: string;
  transactionHash: string;
  eventIndex: number;
}) {
  return `${event.chainId}:${event.blockHash.toLowerCase()}:${event.transactionHash.toLowerCase()}:${event.eventIndex}`;
}

export type EventProjection = Record<EventField, string | null>;

export function projectEvent(
  event: NormalizedOnchainEvent,
  program: WatchProgram,
): EventProjection {
  const asset = program.asset
    ? event.assets.find((a) => a.address === program.asset)
    : event.assets.length === 1
      ? event.assets[0]
      : undefined;
  const valuation = asset?.valuation;
  const usable =
    valuation &&
    (valuation.kind === "nominal_stablecoin" ||
      (!valuation.stale &&
        valuation.blockNumber === event.blockNumber &&
        valuation.timestamp <= event.timestamp));
  const attr = (key: string) =>
    typeof event.attributes[key] === "string" ? event.attributes[key] : null;

  return {
    actor: event.actor,
    subject: event.subject,
    contract: event.contract,
    protocol: event.protocol,
    eventType: event.eventType,
    transaction: event.transactionHash,
    asset: asset?.address ?? null,
    direction: asset?.direction ?? null,
    amount: asset?.rawAmount ?? null,
    valueMicros: usable ? valuation.valueMicros : null,
    valuationSource: usable ? valuation.source : null,
    sender: attr("sender"),
    recipient: attr("recipient"),
    metric: attr("metric"),
    participant:
      event.attributes.actorAttributable === false ? null : event.actor,
  };
}

/** JSONB/object key order must not turn identical evidence into a conflict. */
export function sameNormalizedEvidence(
  a: NormalizedOnchainEvent,
  b: NormalizedOnchainEvent,
) {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        );
      }

      return item;
    });

  return canonical(a) === canonical(b);
}
