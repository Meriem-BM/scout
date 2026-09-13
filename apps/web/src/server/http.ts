import { randomUUID } from "node:crypto";

import "server-only";
import { z } from "zod";

import { IntegrationError } from "@scout/integrations/http";

import { HttpError, identity } from "./auth";
import { siteUrl } from "./env";

export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");

  if (origin !== new URL(siteUrl()).origin) {
    throw new HttpError(403, "Request origin was not accepted.");
  }
}

export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  checkOrigin(request);

  const text = await request.text();

  if (text.length > 24_000) {
    throw new HttpError(413, "This request is too large.");
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid request body.");
  }

  return schema.parse(value);
}

export async function authorizedBudget(
  bucket: string,
  maximum = 10,
  seconds = 60,
) {
  const auth = await identity();
  const { data, error } = await auth.client.rpc("scout_rate_limit", {
    bucket,
    maximum,
    period_seconds: seconds,
  });

  if (error) {
    throw new HttpError(503, "The request budget could not be checked.");
  }

  if (!data) {
    throw new HttpError(
      429,
      "You've reached this request limit. Please wait before trying again.",
    );
  }

  return auth;
}

export function route(handler: (request: Request) => Promise<unknown>) {
  return async (request: Request) => {
    const correlationId = randomUUID();

    try {
      return Response.json(await handler(request), {
        headers: {
          "cache-control": "private, no-store",
          "x-request-id": correlationId,
        },
      });
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : error instanceof IntegrationError
              ? 503
              : 500;
      const message =
        error instanceof z.ZodError
          ? error.issues
              .map((issue) => issue.message)
              .slice(0, 3)
              .join(" ")
          : error instanceof Error &&
              ["Error", "HttpError", "IntegrationError"].includes(error.name)
            ? error.message
            : "The integration request failed. Check provider configuration, network, balance and simulation requirements, then retry. Your inputs were preserved.";

      console.error(
        JSON.stringify({
          event: "request.failed",
          correlationId,
          status,
          code:
            error instanceof IntegrationError
              ? error.code
              : error instanceof Error
                ? error.name
                : "UNKNOWN",
        }),
      );

      return Response.json(
        { error: message, correlationId },
        {
          status,
          headers: {
            "cache-control": "private, no-store",
            "x-request-id": correlationId,
          },
        },
      );
    }
  };
}
