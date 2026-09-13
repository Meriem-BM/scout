import { safeDestination } from "@scout/domain";

const KEY = "scout.auth.returnTo";
let fallback: string | null = null;

export function rememberAuthDestination(path: string) {
  fallback = safeDestination(path, "/watches");

  try {
    sessionStorage.setItem(KEY, fallback);
  } catch {
    /* In-memory fallback. */
  }
}

export function takeAuthDestination() {
  let value = fallback;

  try {
    value = sessionStorage.getItem(KEY) ?? value;
    sessionStorage.removeItem(KEY);
  } catch {
    /* In-memory fallback. */
  }

  fallback = null;

  return value ? safeDestination(value, "/watches") : null;
}
