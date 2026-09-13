import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSpec, POOLS } from "@scout/domain";
import { fetchJson, IntegrationError } from "@scout/integrations/http";
import { TelegramAdapter, TelegramUpdate } from "@scout/integrations/telegram";

import type { Incident } from "@scout/domain";

afterEach(() => vi.unstubAllGlobals());
describe("provider errors and real Telegram request contract (mock HTTP)", () => {
  it("respects Telegram's JSON retry_after when no header is sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ok: false, parameters: { retry_after: 37 } }),
            { status: 429 },
          ),
        ),
    );
    await expect(
      new TelegramAdapter("test-token", "https://scout.test").test("123"),
    ).rejects.toMatchObject({ retryAfterSeconds: 37, code: "HTTP_429" });
  });
  it("records ambiguity after network timeouts on a send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")),
    );
    await expect(
      new TelegramAdapter("test-token", "https://scout.test").test("123"),
    ).rejects.toMatchObject({ ambiguous: true });
  });
  it("does not classify a failed read as a sent notification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(fetchJson("https://scout.test/read")).rejects.toMatchObject({
      ambiguous: false,
    });
  });
  it("returns the actual message id from the API response", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } })),
      );

    vi.stubGlobal("fetch", fetcher);
    expect(
      await new TelegramAdapter("test-token", "https://scout.test").test("123"),
    ).toBe(42);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("uses an incident link and authorized callback identity, never a transaction action", async () => {
    const watchId = "123e4567-e89b-42d3-a456-426614174000";
    const incident: Incident = {
      id: "123e4567-e89b-42d3-a456-426614174001",
      watchId,
      title: "Repeated selling from one initiator",
      createdAt: "2026-09-08T12:00:00.000Z",
      updatedAt: "2026-09-08T12:00:00.000Z",
      read: false,
      status: "open",
      spec: defaultSpec(),
      detection: {
        pool: POOLS[0].address,
        initiator: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        timestamp: 1_788_534_600,
        totalUsdMicros: "172800000000",
        transactionCount: 3,
        evidenceIds: [],
        matches: [
          {
            condition: "repeated_selling",
            matched: true,
            observedUsdMicros: "172800000000",
            observedCount: 3,
            evidenceIds: [],
            rule: "3 sales above $50,000 within 15 minutes",
          },
        ],
        severity: "attention",
      },
      evidence: [],
      context: null,
      explanation: null,
      deliveryStates: [],
      delivery: "queued",
    };

    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 22 } })),
      );

    vi.stubGlobal("fetch", fetcher);
    await new TelegramAdapter("test-token", "https://scout.test").send(
      "123",
      incident,
    );

    const [, options] = fetcher.mock.calls[0] ?? [];
    const body = JSON.parse(options.body);

    expect(body.reply_markup.inline_keyboard[0][0].url).toBe(
      `https://scout.test/watches/${incident.watchId}/incidents/${incident.id}`,
    );
    expect(body.reply_markup.inline_keyboard[1][0].callback_data).toBe(
      `mute:${incident.watchId}`,
    );
    expect(body.text).not.toMatch(/fraud/i);
  });
  it("rejects oversized untrusted Telegram text", () =>
    expect(
      TelegramUpdate.safeParse({
        update_id: 1,
        message: { text: "a".repeat(501), chat: { id: 1, type: "private" } },
      }).success,
    ).toBe(false));
  it("fails closed on invalid provider JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid")));
    await expect(fetchJson("https://scout.test")).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });
});
