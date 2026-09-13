import { afterEach, describe, expect, it, vi } from "vitest";

import { FACTORY } from "@scout/domain";
import { GraphAdapter } from "@scout/integrations/graph";

const hash = "0x" + "a".repeat(64);
const tx = "0x" + "b".repeat(64);
const other = "0x" + "c".repeat(64);
const anchor = {
  initiator: "0x" + "1".repeat(40),
  transactionHash: tx,
  blockNumber: "12370000",
  blockHash: hash,
  timestamp: 1600000000,
  logIndex: 20,
};
const manifest = JSON.stringify({
  dataSources: [
    {
      network: "mainnet",
      source: { address: FACTORY, startBlock: 12369621 },
      mapping: {
        eventHandlers: [
          { event: "PoolCreated(address,address,uint24,int24,address)" },
        ],
      },
    },
  ],
  templates: [
    {
      mapping: {
        eventHandlers: [
          {
            event: "Swap(address,address,int256,int256,uint160,uint128,int24)",
          },
        ],
      },
    },
  ],
});
const graph = new GraphAdapter("controlled-key");

afterEach(() => vi.unstubAllGlobals());

function mock(same: unknown[], earlier: unknown[] = [], broken = false) {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            _meta: {
              deployment: "Qm" + "a".repeat(44),
              hasIndexingErrors: broken,
              block: { number: 12370000, hash: null },
            },
            earlier,
            same,
          },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(new Response(manifest, { status: 200 }));

  vi.stubGlobal("fetch", fetch);

  return fetch;
}

describe("prior activity coverage and ordering", () => {
  it("excludes the entire current transaction and later transactions, and binds the query to the canonical block hash", async () => {
    const fetch = mock([
      { transaction: { id: tx }, logIndex: "1" },
      { transaction: { id: other }, logIndex: "21" },
    ]);

    expect((await graph.checkPriorActivity(anchor)).status).toBe(
      "NONE_WITH_PROVEN_COVERAGE",
    );

    const body = JSON.parse(fetch.mock.calls[0]![1].body);

    expect(body.variables.hash).toBe(hash);
    expect(body.query).toContain("block:{hash:$hash}");
  });
  it("finds an earlier transaction in the same block", async () => {
    mock([{ transaction: { id: other }, logIndex: "19" }]);
    expect((await graph.checkPriorActivity(anchor)).status).toBe("FOUND");
  });
  it("does not accept missing or errored coverage", async () => {
    mock([], [], true);
    expect((await graph.checkPriorActivity(anchor)).status).toBe("UNKNOWN");
  });
  it("requires a factory-origin manifest before claiming absence", async () => {
    const fetch = mock([]);

    fetch
      .mockReset()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              _meta: {
                deployment: "Qm" + "a".repeat(44),
                hasIndexingErrors: false,
                block: { number: 12370000, hash: null },
              },
              earlier: [],
              same: [],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("{}"));
    expect((await graph.checkPriorActivity(anchor)).status).toBe("UNKNOWN");
  });
});
