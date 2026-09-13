export function log(
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
) {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event, ...fields }),
  );
}

export function errorCode(error: unknown) {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
  ) {
    return error.code;
  }

  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}
