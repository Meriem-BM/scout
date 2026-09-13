import type { WatchIntentSpec } from "../workflow";

/** Syntactic provenance is not proof of user intent. This catches declared
 * defaults; a model falsely claiming EXPLICIT remains a separate trust gap. */
export function blockingDefault(intent: WatchIntentSpec) {
  const fields = [
    ["chain", intent.subject.chain],
    ["protocol", intent.subject.protocol],
    ["protocolVersion", intent.subject.protocolVersion],
    ["direction", intent.activity.direction],
    ["evaluationWindowSeconds", intent.temporal.evaluationWindowSeconds],
    ["comparisonWindowSeconds", intent.temporal.comparisonWindowSeconds],
    ...intent.subject.contracts.map(
      (item, i) => [`contracts.${i}`, item] as const,
    ),
    ...intent.subject.tokens.map((item, i) => [`tokens.${i}`, item] as const),
  ] as const;

  for (const [field, item] of fields) {
    if (item?.source === "default") {
      return {
        field,
        value: String(item.value),
        reason: "This default changes which activity the Watch monitors.",
      };
    }
  }

  for (const filter of intent.filters) {
    if (filter.source === "default") {
      return {
        field: filter.field,
        value: String(filter.value),
        reason: "This default changes the Watch's matching threshold.",
      };
    }
  }

  return null;
}
