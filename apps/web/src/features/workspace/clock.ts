"use client";

import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  const timer = setInterval(listener, 1000);

  return () => clearInterval(timer);
};

/** UI clock only. Monitoring and delivery never depend on this timer. */
export function useClock() {
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / 1000) * 1000,
    () => 0,
  );
}
