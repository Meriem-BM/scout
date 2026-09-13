import { IntegrationError } from "@scout/integrations/http";

const REDACTED_URL = "[provider URL redacted]";

export function safeDiagnostic(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "The workflow stopped without a readable diagnostic.";

  return message
    .replace(/^Request body:.*$/gim, "Request body: [redacted]")
    .replace(/https?:\/\/[^\s)]+/gi, REDACTED_URL)
    .replace(
      /((?:api[_-]?key|access[_-]?token|authorization|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, 4_000);
}

export function buildFailureCode(error: unknown) {
  if (error instanceof IntegrationError) {
    return error.code;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (
    /ENOENT|no such file|command not found|spawn .* not found/i.test(message)
  ) {
    return "BUILD_ENVIRONMENT";
  }

  if (
    /cargo failed|substreams failed with code|could not compile/i.test(message)
  ) {
    return "BUILD_COMPILATION";
  }

  if (/concurrent stream limit|resource_exhausted/i.test(message)) {
    return "SUBSTREAMS_CAPACITY";
  }

  if (/rate limit|too many requests|status: 429/i.test(message)) {
    return "RPC_RATE_LIMIT";
  }

  if (
    /aborted due to timeout|operation timed out|provider timeout/i.test(message)
  ) {
    return "PROVIDER_TIMEOUT";
  }

  if (
    /verification|reference|matching output|duplicate|event mismatch|block identity disagrees/i.test(
      message,
    )
  ) {
    return "VERIFICATION_MISMATCH";
  }

  return "BUILD_OR_VERIFICATION_FAILED";
}

export function consumesRepairBudget(code: string) {
  return [
    "BUILD_COMPILATION",
    "BUILD_OR_VERIFICATION_FAILED",
    "VERIFICATION_MISMATCH",
  ].includes(code);
}
