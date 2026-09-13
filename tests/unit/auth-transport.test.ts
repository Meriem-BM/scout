import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertAuthEpoch,
  authenticatedFetch,
  authEpoch,
  installAuthTransport,
  resetAuthTransport,
} from "../../apps/web/src/features/account/auth-transport";

afterEach(() => {
  resetAuthTransport();
  vi.unstubAllGlobals();
});
describe("Privy request transport", () => {
  it("obtains a fresh SDK token for each request without retaining tokens", async () => {
    const token = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("refreshed");
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));

    vi.stubGlobal("fetch", fetcher);
    installAuthTransport(token, vi.fn());
    await authenticatedFetch("/api/state");
    await authenticatedFetch("/api/state");
    expect(
      new Headers(fetcher.mock.calls[0]![1].headers).get("authorization"),
    ).toBe("Bearer first");
    expect(
      new Headers(fetcher.mock.calls[1]![1].headers).get("authorization"),
    ).toBe("Bearer refreshed");
  });
  it("retries a rejected token once using SDK refresh, not other failures", async () => {
    const get = vi.fn().mockResolvedValue("token");
    const expired = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));

    vi.stubGlobal("fetch", fetcher);
    installAuthTransport(get, expired);
    expect((await authenticatedFetch("/api/state")).status).toBe(200);
    expect((await authenticatedFetch("/api/state")).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(expired).not.toHaveBeenCalled();
  });
  it("clears the session after a bounded refresh failure", async () => {
    const expired = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 401 }));

    vi.stubGlobal("fetch", fetcher);
    installAuthTransport(async () => "expired", expired);
    expect((await authenticatedFetch("/api/state")).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(expired).toHaveBeenCalledOnce();
  });
  it("does not send a previous account's token when token retrieval resolves after a switch", async () => {
    let complete!: (token: string) => void;
    const get = () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      });
    const fetcher = vi.fn();

    vi.stubGlobal("fetch", fetcher);
    installAuthTransport(get, vi.fn());

    const request = authenticatedFetch("/api/state");

    installAuthTransport(async () => "bob", vi.fn());
    complete("alice");
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("aborts in-flight reads and rejects stale bodies on logout", async () => {
    let complete!: (response: Response) => void;
    let signal: AbortSignal | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init) => {
        signal = init.signal;

        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }),
    );
    installAuthTransport(async () => "alice", vi.fn());

    const started = authEpoch();
    const request = authenticatedFetch("/api/state");

    await Promise.resolve();
    resetAuthTransport();
    complete(new Response("private"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(() => assertAuthEpoch(started)).toThrow();
  });
  it("an obsolete provider cleanup cannot clear a new identity", async () => {
    const cleanup = installAuthTransport(async () => "alice", vi.fn());

    installAuthTransport(async () => "bob", vi.fn());
    cleanup();

    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));

    vi.stubGlobal("fetch", fetcher);
    await authenticatedFetch("/api/state");
    expect(
      new Headers(fetcher.mock.calls[0]![1].headers).get("authorization"),
    ).toBe("Bearer bob");
  });
});
