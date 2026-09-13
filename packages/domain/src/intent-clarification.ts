import { protocolProfileForIntent } from "./protocols";
import { canonicalUniswapTokenSymbol, POOLS, TOKENS } from "./uniswap-scope";

import type { WatchIntentSpec } from "./workflow";

export function dataPlanningClarification(intent: WatchIntentSpec) {
  const question = (field: string, text: string, choices: string[]) => ({
    field,
    question: text,
    reason: text,
    choices: choices.map((value) => ({
      value,
      label: value,
      recommended: false,
    })),
    allowCustom: true,
  });

  if (
    protocolProfileForIntent(intent).id === "uniswap" &&
    intent.subject.protocolVersion?.value === "v4" &&
    ["liquidity_removal", "liquidity_addition"].includes(
      intent.activity.type.value,
    ) &&
    intent.subject.wallets.length &&
    !intent.subject.actorRole
  ) {
    return question(
      "actorRole",
      "Should this address match the transaction initiator or the contract calling PoolManager? Neither proves LP ownership.",
      ["transaction_initiator", "contract_caller"],
    );
  }

  if (
    protocolProfileForIntent(intent).id === "uniswap" &&
    !intent.subject.protocolVersion
  ) {
    return question(
      "protocolVersion",
      "Which Uniswap version should Scout monitor? V3, V4, or both have different data requirements.",
      ["v3", "v4", "both"],
    );
  }

  if (
    protocolProfileForIntent(intent).id === "uniswap" &&
    intent.activity.type.value === "swap" &&
    intent.subject.contracts.length === 0
  ) {
    return question(
      "poolScope",
      "The current verified catalog covers the 0.05% and 0.30% ETH/USDC pools, not every fee tier. Which pool scope should Scout monitor?",
      [
        `Both supported pools: ${POOLS.map((pool) => pool.address).join(", ")}`,
        `0.05% pool: ${POOLS[0].address}`,
        `0.30% pool: ${POOLS[1].address}`,
      ],
    );
  }

  if (intent.activity.type.value !== "volume_burst") {
    return null;
  }

  if (!intent.subject.protocol && intent.subject.contracts.length === 0) {
    return question(
      "volumeSource",
      "Where should Scout measure volume: trades on a protocol, or token transfers?",
      ["Uniswap trades", "Token transfers"],
    );
  }

  if (
    intent.subject.tokens.length === 0 &&
    intent.subject.contracts.length === 0
  ) {
    return question(
      "volumeSubject",
      "Which token, pair, or contract should Scout measure?",
      ["ETH / USDC"],
    );
  }

  if (!intent.temporal.evaluationWindowSeconds) {
    return question(
      "evaluationWindowSeconds",
      "Over what period should Scout measure the current volume?",
      ["5 minutes", "15 minutes", "1 hour"],
    );
  }

  if (!intent.temporal.comparisonWindowSeconds) {
    return question(
      "comparisonWindowSeconds",
      "How much preceding history should Scout use as the volume baseline?",
      ["15 minutes", "1 hour"],
    );
  }

  const multiplier = intent.filters.find((filter) =>
    ["volumemultiplier", "volumeratio"].includes(
      filter.field.toLowerCase().replaceAll(/[^a-z]/g, ""),
    ),
  );

  if (!multiplier) {
    return question(
      "volumeMultiplier",
      "How much higher than the preceding average should volume be before Scout alerts?",
      ["2 times", "3 times", "5 times"],
    );
  }

  if (
    protocolProfileForIntent(intent).id === "generic-evm" &&
    !intent.activity.event
  ) {
    return question(
      "volumeMetric",
      "What activity should count toward volume for this contract?",
      ["Token transfers", "Trades"],
    );
  }

  return null;
}

/** Keep an exact choice from Scout's pool question binding across model retries.
 * Arbitrary custom answers still go through normal resolution. A later request
 * for all pools or different addresses cancels this bounded shortcut. */
export function applyConfirmedPoolScope(
  intent: WatchIntentSpec,
  answers: Array<{ field: string; answer: string }>,
) {
  const index = answers.findLastIndex((a) => a.field === "poolScope");

  if (
    index < 0 ||
    protocolProfileForIntent(intent).id !== "uniswap" ||
    intent.activity.type.value !== "swap" ||
    intent.subject.protocolVersion?.value
      .toLowerCase()
      .replace(/^uniswap[_ -]?/, "") !== "v3" ||
    intent.subject.chain?.value !== "ethereum"
  ) {
    return false;
  }

  const question = dataPlanningClarification({
    ...intent,
    subject: {
      ...intent.subject,
      protocolVersion: { value: "v3", source: "explicit", confidence: 1 },
      contracts: [],
    },
  });
  const chosen = question?.choices.find(
    (c) => c.value === answers[index]!.answer,
  );

  if (!chosen) {
    return false;
  }

  intent.subject.protocolVersion!.value = "v3";

  const addresses = chosen.value.match(/0x[0-9a-fA-F]{40}/g)!;
  const later = answers
    .slice(index + 1)
    .filter((a) => /pool|scope|contract/i.test(a.field));

  if (
    later.some(
      (a) =>
        /\ball\b|\bevery\b/i.test(a.answer) ||
        (a.answer.match(/0x[0-9a-fA-F]{40}/g) ?? []).some(
          (address) => !addresses.includes(address.toLowerCase()),
        ),
    )
  ) {
    return false;
  }

  intent.subject.contracts = addresses.map((value) => ({
    value,
    source: "explicit",
    confidence: 1,
  }));

  // These pool addresses bind the pair through the installed catalog.
  // Resolve omitted pair metadata without changing an explicitly different token.
  if (
    intent.subject.tokens.every((token) =>
      TOKENS.some(
        (known) => known.symbol === canonicalUniswapTokenSymbol(token.value),
      ),
    )
  ) {
    intent.subject.tokens = TOKENS.map((token) => ({
      value: token.symbol,
      source: "resolved",
      confidence: 1,
    }));
  }

  const scopeFields = new Set([
    "poolScope",
    "pool_scope",
    "pools",
    "contracts",
    "subject.contracts",
  ]);

  intent.unresolved = intent.unresolved.filter(
    (field) => !scopeFields.has(field.field),
  );

  return true;
}
