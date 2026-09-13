import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { planDataRequirements, WatchIntentSpecSchema } from "@scout/domain";
import { SubstreamsRegistry } from "@scout/integrations/substreams-registry";

afterEach(() => vi.unstubAllGlobals());

const source = <T>(value: T) => ({
  value,
  source: "explicit" as const,
  confidence: 1,
});

describe("Substreams registry discovery", () => {
  it("inspects a real package artifact instead of trusting search metadata", async () => {
    const bytes = await readFile(
      resolve("substreams/vendor/ethereum-common.spkg"),
    );
    const registryPackage = {
      name: "ethereum-common",
      slug: "ethereum-common",
      organization: { name: "StreamingFast", slug: "streamingfast" },
      repository:
        "https://github.com/streamingfast/substreams-foundational-modules",
      downloads: 1200,
      releaseCount: 3,
      latestVersion: "v0.3.3",
      network: "",
      spkg: "https://spkg.io/v1/packages/ethereum-common/v0.3.3",
      reference: "ethereum-common@v0.3.3",
    };
    const fetcher = vi.fn(
      async (input: string | URL | Request, _options?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );

        if (url.hostname === "spkg.io") {
          if (url.pathname.startsWith("/v1/packages/")) {
            return new Response(null, {
              status: 302,
              headers: { location: "/v1/files/ethereum-common-v0.3.3.spkg" },
            });
          }

          return new Response(bytes, {
            headers: { "content-length": String(bytes.length) },
          });
        }

        return new Response(
          JSON.stringify({
            packages:
              url.searchParams.get("query") === "ethereum common"
                ? [registryPackage]
                : [],
            recommendations: [],
          }),
        );
      },
    );

    vi.stubGlobal("fetch", fetcher);

    const requirements = planDataRequirements(
      WatchIntentSpecSchema.parse({
        version: 1,
        subject: {
          chain: source("ethereum"),
          protocol: source("Uniswap"),
          protocolVersion: source("v3"),
          contracts: [source("0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640")],
          tokens: [source("ETH"), source("USDC")],
          wallets: [],
        },
        activity: {
          type: source("swap"),
          event: source("Swap"),
          direction: source("buy"),
        },
        filters: [
          {
            field: "swapUsd",
            operator: "gt",
            value: "100000",
            unit: "USD",
            source: "explicit",
          },
        ],
        temporal: {
          mode: source("continuous"),
          comparisonWindowSeconds: null,
          evaluationWindowSeconds: null,
        },
        investigation: [],
        delivery: [],
        assumptions: [],
        unresolved: [],
      }),
    );

    const discovered = await new SubstreamsRegistry().discover(requirements);

    expect(fetcher.mock.calls.length).toBeGreaterThan(3);
    expect(
      fetcher.mock.calls.some(([input]) =>
        input.toString().includes("query=uniswap"),
      ),
    ).toBe(true);
    expect(
      fetcher.mock.calls.some(([input]) =>
        input.toString().includes("query=ethereum+common"),
      ),
    ).toBe(true);
    expect(
      fetcher.mock.calls.some(([input, options]) => {
        return (
          input.toString().includes("/v1/files/") &&
          options?.redirect === "manual"
        );
      }),
    ).toBe(true);
    expect(discovered.candidates[0]).toMatchObject({
      ref: "ethereum-common@v0.3.3",
      evidence: { networkCompatible: true, packageResolved: true },
    });
    expect(
      discovered.candidates[0]?.modules.some(
        (module) =>
          module.name === "index_events" &&
          module.outputType === "proto:sf.substreams.index.v1.Keys",
      ),
    ).toBe(true);
  });
});
