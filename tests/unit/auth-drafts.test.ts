import { afterEach, expect, it, vi } from "vitest";

import {
  rememberAuthDestination,
  takeAuthDestination,
} from "../../apps/web/src/features/account/return-to";
import { clearPrivateDrafts } from "../../apps/web/src/features/watches/review-draft";

afterEach(() => {
  takeAuthDestination();
  vi.unstubAllGlobals();
});
it("clears private drafts and collection caches while retaining the anonymous prompt and owner-scoped transaction journal", () => {
  const storage: Record<string, string> = {
    "scout.watch.draft": "My anonymous watch",
    "scout.review.live:new": "New draft",
    "scout.review.live:private-id": "Previous owner's edit",
    "scout.collection.live": "Previous owner's filter",
    "scout.scroll.watch": "Private selection",
    "scout.transaction.owner-a.swap": "Signed transaction identity",
  };

  Object.defineProperty(storage, "removeItem", {
    value: (key: string) => {
      delete storage[key];
    },
  });
  vi.stubGlobal("sessionStorage", storage);
  clearPrivateDrafts();
  expect(Object.keys(storage)).toEqual([
    "scout.watch.draft",
    "scout.review.live:new",
    "scout.transaction.owner-a.swap",
  ]);
});
it("preserves only safe relative destinations and consumes them once even without browser storage", () => {
  vi.stubGlobal("sessionStorage", {
    setItem() {
      throw new Error("unavailable");
    },
    getItem() {
      throw new Error("unavailable");
    },
  });
  rememberAuthDestination("/watches/123/incidents/456?event=7");
  expect(takeAuthDestination()).toBe("/watches/123/incidents/456?event=7");
  expect(takeAuthDestination()).toBeNull();

  for (const unsafe of [
    "https://attacker.invalid",
    "//attacker.invalid",
    "/\\attacker.invalid",
  ]) {
    rememberAuthDestination(unsafe);
    expect(takeAuthDestination()).toBe("/watches");
  }
});
