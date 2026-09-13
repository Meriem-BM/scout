import {
  type HistoricalEvidence,
  HistoricalEvidenceSchema,
  type HistoricalRequirement,
  type NormalizedOnchainEvent,
} from "@scout/domain";

import type { GraphAdapter } from "./graph";

export interface InvestigationProvider {
  readonly id: string;
  canSatisfy(requirement: HistoricalRequirement, chainId: number): boolean;
  investigate(
    requirement: HistoricalRequirement,
    event: NormalizedOnchainEvent,
  ): Promise<HistoricalEvidence>;
}

/** Protocol history knowledge is a provider boundary, never a rule-engine branch. */
export class GraphPriorActivityProvider implements InvestigationProvider {
  readonly id = "graph-prior-uniswap-v3";
  constructor(private readonly graph: GraphAdapter) {}
  canSatisfy(requirement: HistoricalRequirement, chainId: number) {
    return (
      chainId === 1 &&
      requirement.kind === "prior_activity" &&
      requirement.protocol === "uniswap_v3" &&
      requirement.subject === "actor"
    );
  }
  async investigate(
    requirement: HistoricalRequirement,
    event: NormalizedOnchainEvent,
  ): Promise<HistoricalEvidence> {
    if (!this.canSatisfy(requirement, event.chainId) || !event.actor) {
      throw new Error(
        "This history provider cannot establish the requested subject/scope",
      );
    }

    let prior;

    try {
      prior = await this.graph.checkPriorActivity({
        initiator: event.actor,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        timestamp: event.timestamp,
        logIndex: event.eventIndex,
      });
    } catch {
      return HistoricalEvidenceSchema.parse({
        requirementId: requirement.id,
        eventId: event.id,
        subject: event.actor,
        protocol: requirement.protocol,
        beforeTransaction: event.transactionHash,
        status: "ERROR_RETRYABLE",
        coverage: null,
        evidenceIds: [],
        provider: this.id,
        reason:
          "Historical provider unavailable; retry before deciding the required predicate.",
      });
    }

    return HistoricalEvidenceSchema.parse({
      requirementId: requirement.id,
      eventId: event.id,
      subject: event.actor,
      protocol: requirement.protocol,
      beforeTransaction: event.transactionHash,
      status:
        prior.status === "NONE_WITH_PROVEN_COVERAGE" && !prior.coverage
          ? "UNKNOWN"
          : prior.status,
      coverage: prior.coverage ?? null,
      evidenceIds: prior.evidenceTransaction ? [prior.evidenceTransaction] : [],
      provider: this.id,
      reason: prior.reason,
    });
  }
}
