import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consume,
  substreamsProductionMode,
} from "@scout/integrations/substreams";

afterEach(() => vi.unstubAllGlobals());

describe("Substreams authentication boundary", () => {
  it("uses low-latency execution for bounded verification ranges", () => {
    expect(substreamsProductionMode("25954790")).toBe(false);
    expect(substreamsProductionMode()).toBe(true);
  });

  it("reports a rejected data-plane key without exposing provider details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            message: "invalid key value containing private material",
          },
          { status: 400 },
        ),
      ),
    );

    const stream = consume({
      endpoint: "https://mainnet.eth.streamingfast.io:443",
      apiKey: "invalid-private-value",
      packageBytes: new Uint8Array(),
      startBlock: "1",
      stopBlock: "2",
      signal: new AbortController().signal,
    });

    await expect(stream.next()).rejects.toMatchObject({
      code: "SUBSTREAMS_AUTHENTICATION",
      message:
        "The Graph rejected the Substreams data-plane key. Create a current key in The Graph Market, set SUBSTREAMS_API_KEY on the monitoring worker, and retry this Watch.",
    });
  });
});
