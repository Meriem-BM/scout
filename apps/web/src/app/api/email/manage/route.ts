import { z } from "zod";

import { verifyManageEmailToken } from "@scout/integrations/email";
import { admin, HttpError } from "@/server/auth";
import { required } from "@/server/env";
import { body, route } from "@/server/http";

export const POST = route(async (request) => {
  const { id, token } = await body(
    request,
    z.object({ id: z.uuid(), token: z.string().max(100) }),
  );

  if (!verifyManageEmailToken(id, token, required("EMAIL_LINK_SECRET"))) {
    throw new HttpError(403, "This email management link is invalid.");
  }

  const { error } = await admin().rpc("scout_email_disable", {
    connection_id: id,
  });

  if (error) {
    throw new Error("Email alerts could not be disabled. Retry.");
  }

  return { ok: true };
});
