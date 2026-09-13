import { createHmac, randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emailTemplate,
  manageEmailToken,
  ResendAdapter,
  verifyEmailWebhook,
  verifyManageEmailToken,
} from "@scout/integrations/email";

afterEach(() => vi.unstubAllGlobals());
describe("Resend transport and authenticated webhook contract", () => {
  it("sends both bodies with persistent application identity as provider key", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "email-123" })));

    vi.stubGlobal("fetch", fetcher);

    const payload = emailTemplate(
      "Test <script>",
      ["A & B"],
      "https://scout.test/email/verify#token",
      "Verify",
    );

    expect(
      await new ResendAdapter(
        "test-key",
        "Scout <alerts@example.invalid>",
      ).send("test@example.invalid", payload, "scout-email/durable-id"),
    ).toBe("email-123");

    const [url, options] = fetcher.mock.calls[0]!;

    expect(url).toBe("https://api.resend.com/emails");
    expect(options.headers["Idempotency-Key"]).toBe("scout-email/durable-id");

    const body = JSON.parse(options.body);

    expect(body.to).toEqual(["test@example.invalid"]);
    expect(body.html).toContain("&lt;script&gt;");
    expect(body.html).not.toContain("<script>");
    expect(body.text).toContain("A & B");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("does not treat rejected API requests as delivery", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("{}", { status: 429, headers: { "retry-after": "75" } }),
        ),
    );
    await expect(
      new ResendAdapter("key", "from").send(
        "to",
        emailTemplate("test", [], "https://scout.test", "Open"),
        "key",
      ),
    ).rejects.toMatchObject({
      code: "EMAIL_PROVIDER_ERROR",
      retryAfterSeconds: 75,
    });
  });
  it("marks network interruption as unknown acceptance for bounded retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(
      new ResendAdapter("key", "from").send(
        "to",
        emailTemplate("test", [], "https://scout.test", "Open"),
        "key",
      ),
    ).rejects.toMatchObject({ ambiguous: true });
  });
  it("verifies exact raw signed payload and rejects tampering and stale signatures", () => {
    const key = randomBytes(32);
    const secret = "whsec_" + key.toString("base64");
    const id = "msg_test";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: "email-123" },
    });
    const signature = createHmac("sha256", key)
      .update(`${id}.${timestamp}.${raw}`)
      .digest("base64");
    const headers = new Headers({
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    });

    expect(verifyEmailWebhook(raw, headers, secret)).toMatchObject({
      type: "email.delivered",
    });
    expect(() => verifyEmailWebhook(raw + " ", headers, secret)).toThrow();
    headers.set("svix-timestamp", "1");
    expect(() => verifyEmailWebhook(raw, headers, secret)).toThrow();
  });
  it("management capability can only disable its specific connection", () => {
    const secret = "local-test-secret-only".repeat(2);
    const token = manageEmailToken("connection-a", secret);

    expect(verifyManageEmailToken("connection-a", token, secret)).toBe(true);
    expect(verifyManageEmailToken("connection-b", token, secret)).toBe(false);
    expect(verifyManageEmailToken("connection-a", token + "x", secret)).toBe(
      false,
    );
  });
});
