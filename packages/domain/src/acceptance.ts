import { type Erc20WatchSpec, evaluateTransfer } from "./erc20";
import { evaluate } from "./evaluate";
import { investigationDecision, type PriorActivity } from "./investigation";
import { units } from "./money";
import { verifyProgramAcceptance } from "./monitoring/acceptance";
import {
  legacyProvenance,
  migrateExecutableProgram,
  normalizeCandidate,
  normalizeLegacySwap,
} from "./monitoring/compatibility";

import type { CandidateEvent } from "./candidate-event";
import type { SwapEvent } from "./evidence";
import type { WatchSpec } from "./spec";

export function verifyUniswapAcceptance(spec: WatchSpec, seed: SwapEvent) {
  const threshold = spec.conditions.find((item) => item.kind === "large_swap");

  if (
    !threshold ||
    threshold.kind !== "large_swap" ||
    spec.conditions.length !== 1
  ) {
    return {
      status: "NOT_APPLICABLE" as const,
      cases: [],
      basis: "Aggregate rules use their independent runtime coverage checks.",
    };
  }

  const positive = {
    ...seed,
    sellToken: spec.sellToken,
    valuation: {
      ...seed.valuation!,
      usdMicros: (units(threshold.usd, 6) + 1n).toString(),
    },
  };

  if (!seed.valuation) {
    throw new Error(
      "Intent acceptance requires a historically valued seed event",
    );
  }

  const isolated = { ...spec, conditions: [threshold] };
  const prior = (status: PriorActivity["status"]): PriorActivity => ({
    status,
    protocol: "uniswap_v3",
    actor: seed.initiator,
    beforeTransaction: seed.transactionHash,
    throughBlock: seed.blockNumber,
    blockHash: seed.blockHash,
    deployment: null,
    evidenceTransaction: null,
    reason: "Controlled acceptance input, not a historical claim",
  });
  const program = migrateExecutableProgram(spec)!;
  const acceptanceReport = verifyProgramAcceptance(
    program,
    normalizeLegacySwap(positive),
  );

  if (acceptanceReport.finalStatus !== "INTENT_ACCEPTANCE_VERIFIED") {
    throw new Error("Whole-program acceptance did not pass");
  }

  const cases = [
    {
      name: "matching_swap",
      passed: !!evaluate(isolated, positive, [positive]),
    },
    {
      name: "below_threshold",
      passed:
        evaluate(
          isolated,
          {
            ...positive,
            valuation: {
              ...positive.valuation,
              usdMicros: units(threshold.usd, 6).toString(),
            },
          },
          [
            {
              ...positive,
              valuation: {
                ...positive.valuation,
                usdMicros: units(threshold.usd, 6).toString(),
              },
            },
          ],
        ) === null,
    },
    {
      name: "previous_trader_suppressed",
      passed: investigationDecision(true, prior("FOUND")) === "SUPPRESS",
    },
    {
      name: "first_trader_accepted",
      passed:
        investigationDecision(true, prior("NONE_WITH_PROVEN_COVERAGE")) ===
        "ALERT",
    },
    {
      name: "unknown_history_pending",
      passed: investigationDecision(true, prior("UNKNOWN")) === "PENDING",
    },
    {
      name: "actor_preserved",
      passed:
        !spec.investigation.requireNoPriorUniswapSwaps ||
        evaluate(isolated, positive, [positive])?.initiator === seed.initiator,
    },
  ];

  if (cases.some((item) => !item.passed)) {
    throw new Error(
      "Intent acceptance failed: " +
        cases
          .filter((item) => !item.passed)
          .map((item) => item.name)
          .join(", "),
    );
  }

  return {
    status: "INTENT_ACCEPTANCE_VERIFIED" as const,
    cases,
    acceptanceReport,
    basis:
      "Controlled boundary/decision cases derived from a real historical event. These are not claims of historical first-time traders or delivery.",
  };
}

export function verifyTransferAcceptance(
  spec: Erc20WatchSpec,
  seed: CandidateEvent,
) {
  const above = {
    ...seed,
    value: {
      usdMicros: (BigInt(spec.thresholdMicros) + 1n).toString(),
      source: "nominal_usdc" as const,
    },
  };
  const below = {
    ...above,
    value: {
      ...above.value!,
      usdMicros: (BigInt(spec.thresholdMicros) > 0n
        ? BigInt(spec.thresholdMicros) - 1n
        : 0n
      ).toString(),
    },
  };
  const program = migrateExecutableProgram(spec)!;
  const acceptanceReport = verifyProgramAcceptance(
    program,
    normalizeCandidate(above, legacyProvenance),
  );

  if (acceptanceReport.finalStatus !== "INTENT_ACCEPTANCE_VERIFIED") {
    throw new Error("Whole-program acceptance did not pass");
  }

  const cases = [
    { name: "matching_transfer", passed: !!evaluateTransfer(spec, above) },
    {
      name: "wrong_token",
      passed:
        evaluateTransfer(spec, {
          ...above,
          subject: {
            ...above.subject,
            address: "0x0000000000000000000000000000000000000001",
          },
        }) === null,
    },
    { name: "below_threshold", passed: evaluateTransfer(spec, below) === null },
    {
      name: "stable_duplicate_identity",
      passed:
        evaluateTransfer(spec, above)?.candidateId ===
        evaluateTransfer(spec, structuredClone(above))?.candidateId,
    },
  ];

  if (cases.some((item) => !item.passed)) {
    throw new Error("Transfer intent acceptance failed");
  }

  return {
    status: "INTENT_ACCEPTANCE_VERIFIED" as const,
    cases,
    acceptanceReport,
    basis:
      "Controlled cases derived from an independently receipt-verified historical transfer; storage duplicate protection tested separately.",
  };
}
