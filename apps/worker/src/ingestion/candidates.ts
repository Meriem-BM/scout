import {
  type CandidateEvent,
  CandidateEventSchema,
  type NormalizedOnchainEvent,
} from "@scout/domain";

import { persistProgramEvent } from "./program";

import type { DatabaseConnection } from "@scout/database";

/** Called inside the block/checkpoint transaction by protocol adapters. */
export async function persistCandidate(
  tx: DatabaseConnection,
  deployment: {
    id: string;
    watch_id: string;
    user_id: string;
    version_id: string;
  },
  input: CandidateEvent,
  detection: unknown | null,
  deliveryOwner: "legacy" | "finding" = "finding",
  normalized?: NormalizedOnchainEvent,
) {
  const event = CandidateEventSchema.parse(input);

  await tx`insert into public.candidate_events(deployment_id,event_id,watch_id,user_id,envelope) values(${deployment.id},${event.id},${deployment.watch_id},${deployment.user_id},${tx.json(event)}) on conflict do nothing`;

  await persistProgramEvent(tx, deployment, event, deliveryOwner, normalized);

  if (detection !== null) {
    await tx`insert into public.candidate_detections(deployment_id,event_id,rule_version,detection) values(${deployment.id},${event.id},${deployment.version_id},${tx.json(detection as never)}) on conflict do nothing`;
  }
}
