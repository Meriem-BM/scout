import { InvalidAuthTokenError, PrivyClient } from "@privy-io/node";
import { headers } from "next/headers";
import "server-only";
import { z } from "zod";

import { required } from "./env";
import { HttpError } from "./errors";

let client: PrivyClient | undefined;

export function privy() {
  return (client ??= new PrivyClient({
    appId: required("NEXT_PUBLIC_PRIVY_APP_ID"),
    appSecret: required("PRIVY_APP_SECRET"),
    jwtVerificationKey: process.env.PRIVY_VERIFICATION_KEY?.replace(
      /\\n/g,
      "\n",
    ),
    timeout: 10_000,
    maxRetries: 1,
  }));
}

export async function verifyRequest() {
  const authorization = (await headers()).get("authorization");

  if (!authorization || !/^Bearer [^\s]{1,12000}$/.test(authorization)) {
    throw new HttpError(
      401,
      "Sign in to continue. Your draft is saved on this device.",
    );
  }

  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID || !process.env.PRIVY_APP_SECRET) {
    throw new HttpError(
      503,
      "Privy authentication is not configured for this deployment.",
    );
  }

  try {
    const claims = await privy()
      .utils()
      .auth()
      .verifyAccessToken(authorization.slice(7));

    if (
      !claims.user_id.startsWith("did:privy:") ||
      !claims.session_id ||
      claims.issued_at > Date.now() / 1000 + 60
    ) {
      throw new HttpError(401, "This session is not valid. Sign in again.");
    }

    return claims;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof InvalidAuthTokenError) {
      throw new HttpError(
        401,
        "Your session expired or could not be verified. Sign in again; your draft is saved.",
      );
    }

    throw new HttpError(
      503,
      "The sign-in service could not be reached. Please retry.",
    );
  }
}

export async function verifiedAccountEmail(
  subject: string,
  identityToken?: string,
) {
  const user = await (async () => {
    try {
      return identityToken
        ? await privy().users().get({ id_token: identityToken })
        : await privy().users()._get(subject);
    } catch (error) {
      if (error instanceof InvalidAuthTokenError) {
        throw new HttpError(
          401,
          "Your account identity expired or could not be verified. Sign in again.",
        );
      }

      throw new HttpError(
        503,
        "Your account profile could not be verified. Please retry.",
      );
    }
  })();

  if (user.id !== subject) {
    throw new HttpError(401, "Account identity did not match this session.");
  }

  const email = user.linked_accounts.find(
    (a) => a.type === "email" && a.verified_at,
  );
  const google = user.linked_accounts.find(
    (a) => a.type === "google_oauth" && a.verified_at,
  );
  const value =
    email?.type === "email"
      ? email.address
      : google?.type === "google_oauth"
        ? google.email
        : null;

  return value && z.email().max(254).safeParse(value).success
    ? value.toLowerCase()
    : null;
}
