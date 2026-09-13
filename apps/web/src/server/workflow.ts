import "server-only";
import { z } from "zod";

import { WatchWorkflowSchema } from "@scout/domain";

import { admin } from "./auth";
import { HttpError } from "./errors";

import type { Json } from "@scout/database/types";

export async function workflowRpc(
  auth: { subject: string; sessionId: string },
  operation: "create" | "read" | "answer" | "retry" | "duplicate",
  args: Record<string, unknown>,
) {
  const { data, error } = await admin().rpc("scout_workflow_account_rpc", {
    privy_subject: auth.subject,
    privy_session: auth.sessionId,
    operation,
    args: args as Json,
  });

  if (error) {
    if (/not found|available|belongs/i.test(error.message)) {
      throw new HttpError(
        404,
        "This Watch workflow is not available to this account.",
      );
    }

    throw new HttpError(400, error.message);
  }

  return data;
}

export async function readWorkflow(
  auth: { subject: string; sessionId: string },
  watchId: string,
  afterSequence = 0,
) {
  const value = await workflowRpc(auth, "read", {
    watch_id: z.uuid().parse(watchId),
    after_sequence: z.number().int().nonnegative().parse(afterSequence),
  });

  if (!value) {
    throw new HttpError(
      404,
      "This Watch workflow is not available to this account.",
    );
  }

  return WatchWorkflowSchema.parse(value);
}
