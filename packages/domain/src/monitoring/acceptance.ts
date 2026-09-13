import { type CapabilityPlan, planProgramCapabilities } from "./capabilities";
import { normalizedEventIdentity, type NormalizedOnchainEvent } from "./event";
import {
  type HistoricalEvidence,
  type WatchProgram,
  WatchProgramSchema,
} from "./program";
import { evaluateWatchProgram, type ProgramEvaluation } from "./runtime";

export type WatchAcceptanceReport = {
  intent: string;
  resolvedSpec: WatchProgram;
  capabilityPlan: CapabilityPlan;
  pipelineVerification: {
    status: "PIPELINE_VERIFIED" | "NOT_VERIFIED";
    evidenceRef: string | null;
  };
  acceptanceCases: {
    description: string;
    inputEvidence: {
      events: NormalizedOnchainEvent[];
      history: HistoricalEvidence[];
      basis: "CONTROLLED_FROM_SEED";
    };
    expected: ProgramEvaluation["status"];
    actual: ProgramEvaluation["status"];
    status: "PASSED" | "FAILED";
  }[];
  uncovered: string[];
  finalStatus: "INTENT_ACCEPTANCE_VERIFIED" | "PARTIAL" | "FAILED";
};

/** Produces actual test evidence, never a live-history or delivery claim.
 * The generator deliberately refuses complex shapes it cannot independently
 * construct an expected answer for. Hand-written runtime tests do not fill this gap. */
export function verifyProgramAcceptance(
  input: WatchProgram,
  seed: NormalizedOnchainEvent,
  intent = "",
  pipelineVerification: WatchAcceptanceReport["pipelineVerification"] = {
    status: "NOT_VERIFIED",
    evidenceRef: null,
  },
): WatchAcceptanceReport {
  const program = WatchProgramSchema.parse(input);
  const report: WatchAcceptanceReport = {
    intent,
    resolvedSpec: program,
    capabilityPlan: planProgramCapabilities(program),
    pipelineVerification,
    acceptanceCases: [],
    uncovered: [],
    finalStatus: "PARTIAL",
  };

  if (
    program.condition.kind !== "metric" ||
    program.metrics.length !== 1 ||
    program.window.kind !== "event" ||
    program.metrics[0]?.operation !== "sum" ||
    !["amount", "valueMicros"].includes(program.metrics[0]?.field ?? "")
  ) {
    report.uncovered.push(
      "Automatic whole-program acceptance case generation currently requires a single event amount/value comparison; composition needs a complete generated case plan.",
    );

    return report;
  }

  if (program.filter) {
    // Arbitrary Boolean filters require their own positive/negative branch plan.
    const filter = program.filter;
    const filters = filter.kind === "all" ? filter.terms : [filter];

    if (
      filters.some(
        (f) =>
          f.kind !== "text" ||
          !["valuationSource", "direction"].includes(f.field),
      )
    ) {
      report.uncovered.push(
        "Boolean filter branch acceptance cases are not yet generated.",
      );

      return report;
    }
  }

  const c = program.condition;
  const threshold = BigInt(c.value);
  const metric = program.metrics[0]!;
  const matchingSeed = structuredClone(seed);
  const asset = matchingSeed.assets.find((a) => a.address === program.asset);

  if (!asset || threshold < 1n) {
    report.uncovered.push(
      "A matching valued asset and positive threshold are required to construct boundary cases.",
    );

    return report;
  }

  function history(
    event: NormalizedOnchainEvent,
    status: HistoricalEvidence["status"],
  ): HistoricalEvidence[] {
    return program.history.map((req) => ({
      requirementId: req.id,
      eventId: event.id,
      subject: event.actor ?? "",
      protocol: req.protocol,
      beforeTransaction: event.transactionHash,
      status,
      coverage: {
        fromBlock: "0",
        throughBlock: event.blockNumber,
        blockHash: event.blockHash,
        complete: true,
      },
      evidenceIds: status === "FOUND" ? ["controlled-prior-event"] : [],
      provider: "controlled-acceptance",
      reason:
        "Controlled acceptance evidence, not an observed chain-history claim",
    }));
  }

  if (
    program.history.some(
      (req) => req.subject !== "actor" || req.expected !== "none",
    )
  ) {
    report.uncovered.push(
      "Acceptance evidence construction for this historical subject/expectation is not implemented.",
    );

    return report;
  }

  function add(
    description: string,
    events: NormalizedOnchainEvent[],
    expected: ProgramEvaluation["status"],
    prior = history(events.at(-1)!, "NONE_WITH_PROVEN_COVERAGE"),
  ) {
    const actual = evaluateWatchProgram(
      program,
      events.at(-1)!,
      events,
      undefined,
      prior,
    ).status;

    report.acceptanceCases.push({
      description,
      inputEvidence: { events, history: prior, basis: "CONTROLLED_FROM_SEED" },
      expected,
      actual,
      status: expected === actual ? "PASSED" : "FAILED",
    });
  }

  const at = (amount: bigint) => {
    const e = structuredClone(matchingSeed);
    const a = e.assets.find((a) => a.address === program.asset)!;

    if (metric.field === "amount") {
      a.rawAmount = String(amount);
    } else if (a.valuation) {
      a.valuation.valueMicros = String(amount);
    }

    return e;
  };

  const expected = (sign: -1 | 0 | 1) =>
    ({
      eq: sign === 0,
      ne: sign !== 0,
      gt: sign > 0,
      gte: sign >= 0,
      lt: sign < 0,
      lte: sign <= 0,
    })[c.operator]
      ? ("MATCH" as const)
      : ("NO_MATCH" as const);

  for (const offset of [-1, 0, 1] as const) {
    add(
      `threshold_${offset < 0 ? "below" : offset > 0 ? "above" : "equal"}`,
      [at(threshold + BigInt(offset))],
      expected(offset),
    );
  }

  const positiveOffset = ([-1, 0, 1] as const).find(
    (n) => expected(n) === "MATCH",
  )!;
  const positive = at(threshold + BigInt(positiveOffset));

  add(
    "duplicate_event_does_not_change_result",
    [positive, structuredClone(positive)],
    "MATCH",
  );

  const wrongChain = structuredClone(positive);

  wrongChain.chainId += 100000;
  wrongChain.id = normalizedEventIdentity(wrongChain);
  add("wrong_chain", [wrongChain], "NO_MATCH");

  const wrongAsset = structuredClone(positive);

  wrongAsset.assets.find((asset) => asset.address === program.asset)!.address =
    "0x0000000000000000000000000000000000000000";
  add("wrong_asset", [wrongAsset], "NO_MATCH");

  if (program.history.length) {
    add(
      "prior_actor_suppressed",
      [positive],
      "NO_MATCH",
      history(positive, "FOUND"),
    );
    add(
      "unknown_history_pending",
      [positive],
      "PENDING_CONTEXT",
      history(positive, "UNKNOWN"),
    );
    add(
      "retryable_history_pending",
      [positive],
      "PENDING_CONTEXT",
      history(positive, "ERROR_RETRYABLE"),
    );
  }

  report.finalStatus = report.acceptanceCases.every(
    (c) => c.status === "PASSED",
  )
    ? "INTENT_ACCEPTANCE_VERIFIED"
    : "FAILED";

  return report;
}
