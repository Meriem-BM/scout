import { z } from "zod";

import { AccountSchema, admin, HttpError } from "@/server/auth";
import { body, checkOrigin, route } from "@/server/http";
import { verifiedAccountEmail, verifyRequest } from "@/server/privy";

const SessionInputSchema = z.object({
  identityToken: z.string().max(24_000).optional(),
});

function restoreSessionError(message: string) {
  const sessionWasRevoked = message.includes("Session revoked");

  return new HttpError(
    sessionWasRevoked ? 401 : 503,
    sessionWasRevoked
      ? "This session was signed out. Sign in again."
      : "Scout could not restore your account. Please retry.",
  );
}

export const POST = route(async (request) => {
  const input = await body(request, SessionInputSchema);
  const claims = await verifyRequest();

  // A verified identity token avoids a provider API request during restoration.
  const email = await verifiedAccountEmail(claims.user_id, input.identityToken);
  const { data, error } = await admin().rpc("scout_authenticate", {
    privy_subject: claims.user_id,
    privy_session: claims.session_id,
    token_expires: new Date(claims.expiration * 1000).toISOString(),
    account_email: email ?? undefined,
    provision: true,
  });

  if (error) {
    throw restoreSessionError(error.message);
  }

  return AccountSchema.parse(data);
});

export const DELETE = route(async (request) => {
  checkOrigin(request);

  const claims = await verifyRequest();
  const { error } = await admin().rpc("scout_logout", {
    privy_subject: claims.user_id,
    privy_session: claims.session_id,
  });

  if (error) {
    throw new HttpError(
      503,
      "Scout could not revoke this session. Retry sign out.",
    );
  }

  return { ok: true };
});
