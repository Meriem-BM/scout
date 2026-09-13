import { useSyncExternalStore } from "react";

const KEY = "scout.watch.draft";
let draft = "";
let loaded = false;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

function read() {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;

    try {
      draft = sessionStorage.getItem(KEY) ?? "";
    } catch {
      /* A draft can still be edited when session storage is disabled. */
    }
  }

  return draft;
}

export function setDraft(value: string) {
  draft = value;
  loaded = true;

  try {
    sessionStorage.setItem(KEY, value);
  } catch {
    /* Retain the draft in memory when device storage is unavailable. */
  }

  for (const listener of listeners) {
    listener();
  }
}

export function useDraft() {
  return useSyncExternalStore(subscribe, read, () => "");
}
