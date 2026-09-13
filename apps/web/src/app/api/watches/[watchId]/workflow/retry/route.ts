import { z } from "zod";

import { identity } from "@/server/auth";
import { body, route } from "@/server/http";
import { workflowRpc } from "@/server/workflow";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ watchId: string }> },
) {
  const { watchId } = await params;

  return route(async (current) => {
    await body(current, z.object({}));

    const auth = await identity();

    await workflowRpc(auth, "retry", { watch_id: z.uuid().parse(watchId) });

    return { ok: true };
  })(request);
}
