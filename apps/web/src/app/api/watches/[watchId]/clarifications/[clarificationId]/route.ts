import { z } from "zod";

import { identity } from "@/server/auth";
import { body, route } from "@/server/http";
import { workflowRpc } from "@/server/workflow";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ watchId: string; clarificationId: string }> },
) {
  const { watchId, clarificationId } = await params;

  return route(async (current) => {
    const input = await body(
      current,
      z.object({ answer: z.string().trim().min(1).max(500) }),
    );
    const auth = await identity();

    await workflowRpc(auth, "answer", {
      watch_id: z.uuid().parse(watchId),
      clarification_id: z.uuid().parse(clarificationId),
      answer: input.answer,
    });

    return { ok: true };
  })(request);
}
