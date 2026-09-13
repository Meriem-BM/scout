import { describe, expect, it } from "vitest";

import {
  defaultSpec,
  emptySnapshot,
  safeDestination,
  watchHealth,
  WatchSchema,
} from "@scout/domain";

const now = Date.parse("2026-09-05T12:00:00Z");

function fixture(status = "watching") {
  return WatchSchema.parse({
    id: "watch",
    name: "Test watch",
    prompt: "test",
    spec: defaultSpec(),
    status,
    version: 1,
    pendingVersion: null,
    createdAt: new Date(now).toISOString(),
    lastBlock: "2000",
    lastBlockTime: new Date(now - 60_000).toISOString(),
    lastEventAt: null,
    error: null,
    mutedUntil: null,
  });
}

describe("independent persisted state derivation", () => {
  it("keeps monitoring current when delivery is missing", () => {
    const s = emptySnapshot();

    s.worker.online = true;
    expect(watchHealth(fixture(), s, now)).toMatchObject({
      operation: "watching",
      data: "Current",
      delivery: "Needs connection",
      needsAttention: true,
    });
  });
  it("does not call a paused watch disconnected or stale", () => {
    const s = emptySnapshot();
    const h = watchHealth(
      { ...fixture("paused"), lastBlockTime: null },
      s,
      now,
    );

    expect(h.data).toBe("Not processing");
    expect(h.needsAttention).toBe(false);
  });
  it("reports email suppression independently of current data and Telegram", () => {
    const s = emptySnapshot();

    s.preferences.email = true;
    s.worker.online = true;
    s.telegram.connected = true;
    s.emailConnection = {
      ...s.emailConnection,
      verified: true,
      enabled: false,
      suppressed: true,
    };
    expect(watchHealth(fixture(), s, now)).toMatchObject({
      data: "Current",
      delivery: "Partially available",
      telegram: true,
      email: false,
    });
  });
  it("flags stale finalized data and retains mute", () => {
    const s = emptySnapshot();

    expect(
      watchHealth(
        { ...fixture(), mutedUntil: new Date(now + 60_000).toISOString() },
        s,
        now,
      ),
    ).toMatchObject({ data: "Delayed", delivery: "Muted" });
  });
  it("preserves authorized return routes and rejects external redirects", () => {
    expect(safeDestination("/watches/id/incidents/event?tx=abc")).toBe(
      "/watches/id/incidents/event?tx=abc",
    );
    expect(safeDestination("/email/verify")).toBe("/email/verify");

    for (const p of [
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "/settings/\\evil.test",
    ]) {
      expect(safeDestination(p)).toBe("/watches");
    }
  });
});
