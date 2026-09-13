import { useSyncExternalStore } from "react";

import { WatchSpecSchema } from "@scout/domain";

import type { WatchSpec } from "@scout/domain";

const listeners = new Set<() => void>();
const cache = new Map<string, string>();

export function clearPrivateDrafts() {
  for (const key of cache.keys()) {
    if (key.startsWith("live:") && key !== "live:new") {
      cache.delete(key);
    }
  }

  try {
    for (const key of Object.keys(sessionStorage)) {
      if (
        (key.startsWith("scout.review.live:") &&
          key !== "scout.review.live:new") ||
        key.startsWith("scout.collection.") ||
        key.startsWith("scout.scroll.") ||
        key === "scout.pendingSwap" ||
        key === "scout.pendingApproval"
      ) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    /* Memory caches are still cleared when storage is unavailable. */
  }

  listeners.forEach((listener) => listener());
}

export function useReviewDraft(key: string) {
  const read = () => {
    if (!cache.has(key)) {
      try {
        cache.set(key, sessionStorage.getItem(`scout.review.${key}`) ?? "");
      } catch {
        cache.set(key, "");
      }
    }

    return cache.get(key)!;
  };

  const raw = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    read,
    () => "",
  );
  let spec: WatchSpec | null = null;

  try {
    if (raw) {
      spec = WatchSpecSchema.parse(JSON.parse(raw));
    }
  } catch {
    /* Invalid old drafts are never activated. */
  }

  return [
    spec,
    (value: WatchSpec | null) => {
      const next = value ? JSON.stringify(value) : "";

      cache.set(key, next);

      try {
        sessionStorage.setItem(`scout.review.${key}`, next);
      } catch {
        /* Keep draft in memory. */
      }

      listeners.forEach((l) => l());
    },
  ] as const;
}
