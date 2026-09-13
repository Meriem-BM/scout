import { z } from "zod";

import {
  assertAuthEpoch,
  authenticatedFetch,
  authEpoch,
} from "../account/auth-transport";

export class AppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AppApiError";
  }
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function shouldRetryRequest(attempt: number, error: Error) {
  return attempt < 2 && error instanceof AppApiError && error.retryable;
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const started = authEpoch();
  let response: Response;

  try {
    response = await authenticatedFetch(path, {
      method: options?.method ?? "GET",
      headers: options?.body ? { "content-type": "application/json" } : {},
      body: options?.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
  } catch (error) {
    assertAuthEpoch(started);

    if (error instanceof TypeError) {
      throw new AppApiError(
        "Scout could not reach the server.",
        0,
        "NETWORK_ERROR",
      );
    }

    throw error;
  }

  let value: unknown;

  try {
    value = await response.json();
  } catch {
    assertAuthEpoch(started);

    throw new AppApiError(
      "Scout returned an unreadable response.",
      response.status,
      "INVALID_RESPONSE",
    );
  }

  assertAuthEpoch(started);

  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(value);

    throw new AppApiError(
      parsed.success
        ? parsed.data.error
        : "Scout couldn't complete this request. Please try again.",
      response.status,
      "REQUEST_FAILED",
    );
  }

  return schema.parse(value);
}

export const Ok = z.object({ ok: z.boolean() });
