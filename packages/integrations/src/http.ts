export class IntegrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export async function fetchJson(
  url: string,
  options: RequestInit = {},
  timeoutMs = 12_000,
): Promise<unknown> {
  let response: Response;

  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;

    response = await fetch(url, {
      ...options,
      signal,
      cache: "no-store",
    });
  } catch {
    throw new IntegrationError(
      "NETWORK",
      "The provider did not respond. Please try again.",
      null,
      options.method === "POST",
    );
  }

  if (!response.ok) {
    let retry = Number(response.headers.get("retry-after"));

    if (response.status === 429 && (!Number.isFinite(retry) || retry <= 0)) {
      try {
        const value: unknown = await response.json();

        if (
          typeof value === "object" &&
          value !== null &&
          "parameters" in value &&
          typeof value.parameters === "object" &&
          value.parameters !== null &&
          "retry_after" in value.parameters &&
          typeof value.parameters.retry_after === "number"
        ) {
          retry = value.parameters.retry_after;
        }
      } catch {
        /* A bounded default backoff applies when no readable retry delay is supplied. */
      }
    }

    throw new IntegrationError(
      `HTTP_${response.status}`,
      response.status === 429
        ? "The provider is rate limiting requests."
        : `The provider returned HTTP ${response.status}.`,
      Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : null,
    );
  }

  let body: string;

  try {
    body = await response.text();
  } catch {
    throw new IntegrationError(
      "NETWORK_BODY",
      "The provider response was interrupted.",
      null,
      options.method === "POST",
    );
  }

  if (body.length > 4_000_000) {
    throw new IntegrationError(
      "RESPONSE_LIMIT",
      "Provider response exceeded the size limit.",
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new IntegrationError(
      "INVALID_JSON",
      "The provider returned an unreadable response.",
    );
  }
}

export function assertServer() {
  if (typeof window !== "undefined") {
    throw new Error("This integration must only run on a server.");
  }
}
