/** Zod object parsing can strip unknown keys. Model responses must reject them
 * rather than partially accepting a hallucinated condition or readiness flag. */
export function rejectDiscardedModelFields(
  raw: unknown,
  parsed: unknown,
  path = "response",
): void {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed) || raw.length !== parsed.length) {
      throw new Error(`Model structure changed at ${path}`);
    }

    raw.forEach((item, index) =>
      rejectDiscardedModelFields(item, parsed[index], `${path}.${index}`),
    );

    return;
  }

  if (raw && typeof raw === "object") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Model structure changed at ${path}`);
    }

    for (const key of Object.keys(raw)) {
      if (!Object.hasOwn(parsed, key)) {
        throw new Error(`Unknown model field at ${path}.${key}`);
      }

      rejectDiscardedModelFields(
        Reflect.get(raw, key),
        Reflect.get(parsed, key),
        `${path}.${key}`,
      );
    }
  }
}
