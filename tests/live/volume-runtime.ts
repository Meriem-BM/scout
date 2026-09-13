import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseAbiItem } from "viem";

import { defaultSpec, evaluate, WatchSpecSchema } from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";
import { normalizeBlock } from "@scout/integrations/substreams";
import { consumeHistorical } from "@scout/integrations/substreams-cli";

import { packPipeline } from "../../apps/worker/src/pipeline/generate";

import type { SwapEvent } from "@scout/domain";

// Bounded, read-only provider acceptance. This never creates a Watch or sends alerts.
assert(process.env.ETHEREUM_RPC_URL, "ETHEREUM_RPC_URL is required");
assert(
  process.env.SUBSTREAMS_API_KEY || process.env.SUBSTREAMS_API_TOKEN,
  "Substreams credentials are required",
);

const spec = WatchSpecSchema.parse({
  ...defaultSpec(),
  streamDirection: "either",
  conditions: [
    {
      kind: "aggregate",
      description:
        "USD volume rate above 2× the preceding two-minute average over one minute",
      rule: {
        id: "volume_rate",
        predicates: [],
        groupBy: ["pool"],
        aggregate: { operation: "sum", field: "usdMicros" },
        windowSeconds: 60,
        threshold: "0",
        operator: "gt",
        baseline: {
          windowSeconds: 120,
          multiplierMicros: "2000000",
          minimum: "1",
        },
      },
    },
  ],
});
const directory = resolve(".scout/evidence/volume-runtime");

await mkdir(directory, { recursive: true });
console.log("Compiling bidirectional Substreams package.");

const artifact = await packPipeline(
  spec,
  resolve("substreams"),
  directory,
  resolve(".scout/bin/substreams"),
);
const rpc = ethereum(process.env.ETHEREUM_RPC_URL);
const head = await rpc.getBlock({ blockTag: "finalized" });
const start = head.number - 50n;
const first = await rpc.getBlock({ blockNumber: start });
const logs = (
  await Promise.all(
    Array.from({ length: 6 }, (_, index) => {
      const from = start + BigInt(index * 10);
      const through = from + 9n > head.number ? head.number : from + 9n;

      return rpc.getLogs({
        address: spec.pools as `0x${string}`[],
        fromBlock: from,
        toBlock: through,
        event: parseAbiItem(
          "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
        ),
      });
    }),
  )
).flat();
const expected = new Map(
  logs.map((item) => [`${item.transactionHash}:${item.logIndex}`, item]),
);

assert(expected.size > 0, "No independent reference events were returned");

const observed = new Set<string>();
const events: SwapEvent[] = [];

console.log("Comparing Substreams output with finalized RPC logs.");

for await (const block of consumeHistorical({
  endpoint:
    process.env.SUBSTREAMS_ENDPOINT ??
    "https://mainnet.eth.streamingfast.io:443",
  apiKey: process.env.SUBSTREAMS_API_KEY,
  token: process.env.SUBSTREAMS_API_TOKEN,
  substreamsBin: resolve(".scout/bin/substreams"),
  packageBytes: artifact.bytes,
  startBlock: String(start),
  stopBlock: String(head.number + 1n),
  signal: AbortSignal.timeout(120_000),
})) {
  const chainBlock = await rpc.getBlock({ blockNumber: BigInt(block.number) });

  for (const swap of block.swaps) {
    const key = `${swap.transactionHash}:${swap.logIndex}`;

    assert(!observed.has(key), "Duplicate canonical output");
    observed.add(key);

    const reference = expected.get(key);

    assert(
      reference,
      "Substreams emitted an event absent from the independent range",
    );
    assert.equal(swap.amount0, reference.args.amount0?.toString());
    assert.equal(swap.amount1, reference.args.amount1?.toString());
  }

  events.push(
    ...(await normalizeBlock(
      {
        ...block,
        type: "block",
        cursor: "",
        hash: chainBlock.hash,
        timestamp: Number(chainBlock.timestamp),
      },
      rpc,
      () => {},
    )),
  );
}

assert.equal(
  observed.size,
  expected.size,
  "Substreams omitted reference events",
);
assert.equal(
  new Set(events.map((event) => event.sellToken)).size,
  2,
  "Both directions must be observed",
);
assert(
  events.every((event) => event.valuation),
  "Complete valuation is required for this acceptance check",
);

let comparisons = 0;
let matches = 0;

for (const anchor of events) {
  if (anchor.timestamp - Number(first.timestamp) < 180) {
    continue;
  }

  const eligible = events.filter(
    (event) =>
      event.timestamp <= anchor.timestamp &&
      (BigInt(event.blockNumber) < BigInt(anchor.blockNumber) ||
        (event.blockNumber === anchor.blockNumber &&
          event.logIndex <= anchor.logIndex)),
  );
  const sum = (from: number, through: number) =>
    eligible
      .filter((event) => event.timestamp > from && event.timestamp <= through)
      .reduce((value, event) => value + BigInt(event.valuation!.usdMicros), 0n);
  const current = sum(anchor.timestamp - 60, anchor.timestamp);
  const baseline = sum(anchor.timestamp - 180, anchor.timestamp - 60);
  const expectedMatch = baseline > 0n && current > baseline;
  const result = evaluate(spec, anchor, events, {
    from: Number(first.timestamp),
    through: Number(head.timestamp),
  });

  assert.equal(
    !!result,
    expectedMatch,
    "Runtime comparison differs from independent integer calculation",
  );
  comparisons++;

  if (result) {
    matches++;
  }
}

assert(comparisons > 0, "No complete baseline windows were tested");

const proof = {
  checkedAt: new Date().toISOString(),
  mode: "bounded_live_provider_read",
  packageSha256: artifact.packageSha256,
  startBlock: String(start),
  stopBlock: String(head.number),
  referenceEvents: expected.size,
  matchedEvents: observed.size,
  valuedEvents: events.length,
  ruleComparisons: comparisons,
  qualifyingWindows: matches,
  note: "Compiled package, both swap directions and baseline rules checked against real finalized history. This does not establish continuous persisted Watch activation.",
};

await writeFile(
  resolve(directory, "proof.json"),
  JSON.stringify(proof, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(proof, null, 2));
