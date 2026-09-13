import { createClient } from "@supabase/supabase-js";
import "server-only";
import { z } from "zod";

import { accountClient } from "./account-client";
import { required } from "./env";
import { HttpError } from "./errors";
import { verifyRequest } from "./privy";

import type { Database } from "@scout/database/types";

export { HttpError } from "./errors";

export const AccountSchema = z.object({
  userId: z.uuid(),
  email: z.email().nullable(),
});

export async function identity() {
  const claims = await verifyRequest();
  const service = admin();
  const { data, error } = await service.rpc("scout_authenticate", {
    privy_subject: claims.user_id,
    privy_session: claims.session_id,
    token_expires: new Date(claims.expiration * 1000).toISOString(),
  });

  if (error) {
    throw new HttpError(
      error.message.includes("Session revoked") ? 401 : 503,
      error.message.includes("Session revoked")
        ? "This session was signed out. Sign in again."
        : "Your account could not be restored. Please retry.",
    );
  }

  if (!data) {
    throw new HttpError(
      401,
      "Finish signing in to restore your Scout account.",
    );
  }

  const account = AccountSchema.parse(data);

  return {
    ...account,
    subject: claims.user_id,
    sessionId: claims.session_id,
    client: accountClient(service, claims.user_id, claims.session_id),
  };
}

export function admin() {
  return createClient<Database>(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
