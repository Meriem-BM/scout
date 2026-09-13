import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { defaultSpec } from "@scout/domain";
import { ethereum, validatePools } from "@scout/integrations/ethereum";
import { GraphAdapter } from "@scout/integrations/graph";
import { consume, normalizeBlock } from "@scout/integrations/substreams";
import { TelegramAdapter } from "@scout/integrations/telegram";

import { sha256 } from "../../apps/worker/src/pipeline/generate";

const required = ["ETHEREUM_RPC_URL", "GRAPH_API_KEY"];
const missing = required.filter((name) => !process.env[name]);

if (!process.env.SUBSTREAMS_API_KEY && !process.env.SUBSTREAMS_API_TOKEN) {
  missing.push("SUBSTREAMS_API_KEY or SUBSTREAMS_API_TOKEN");
}

if (missing.length) {
  console.log(
    `SKIPPED live smoke; missing ${missing.join(", ")}. No provider validation or delivery was performed.`,
  );
  process.exit(process.env.REQUIRE_LIVE === "1" ? 1 : 0);
}

const rpc = ethereum(process.env.ETHEREUM_RPC_URL!);
const verified = await validatePools(rpc, defaultSpec().pools);
const graph = await new GraphAdapter(
  process.env.GRAPH_API_KEY!,
  process.env.GRAPH_SUBGRAPH_ID,
).history(
  defaultSpec().pools,
  verified.timestamp - 3600,
  verified.timestamp,
  25,
);
const packageBytes = await readFile(".scout/pipeline/scout.spkg");
const stop = BigInt(verified.blockNumber) - 20n;
const start = stop - 100n;
let blocks = 0;
let events = 0;
let valued = 0;
let checkpoint: {
  number: string;
  hash: string;
  timestamp: number;
  cursorHash: string;
} | null = null;
const evidenceIds: string[] = [];

for await (const block of consume({
  endpoint:
    process.env.SUBSTREAMS_ENDPOINT ??
    "https://mainnet.eth.streamingfast.io:443",
  apiKey: process.env.SUBSTREAMS_API_KEY,
  token: process.env.SUBSTREAMS_API_TOKEN,
  packageBytes,
  startBlock: String(start),
  stopBlock: String(stop),
  signal: AbortSignal.timeout(120_000),
})) {
  assert.equal(block.type, "block", "Unexpected finalized undo");

  if (block.type !== "block") {
    throw new Error("Unexpected finalized undo");
  }

  const normalized = await normalizeBlock(block, rpc, (code) =>
    console.log(`DEGRADED ${code}`),
  );

  blocks++;
  events += normalized.length;
  valued += normalized.filter((event) => event.valuation).length;
  evidenceIds.push(...normalized.slice(0, 3).map((event) => event.id));
  checkpoint = {
    number: block.number,
    hash: block.hash,
    timestamp: block.timestamp,
    cursorHash: sha256(block.cursor),
  };
}

assert(
  blocks > 0 && events > 0 && valued > 0,
  "Live range must produce actual decoded, valued events; empty output is not proof.",
);

let telegram: { messageId: number; acceptedAt: string } | null = null;

if (process.env.SCOUT_ALLOW_TELEGRAM_TEST === "1") {
  assert(
    process.env.SCOUT_TELEGRAM_TEST_CHAT_ID && process.env.TELEGRAM_BOT_TOKEN,
    "Explicit test recipient and bot token required",
  );

  const messageId = await new TelegramAdapter(
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.SCOUT_SITE_URL ?? "http://localhost:3000",
  ).test(process.env.SCOUT_TELEGRAM_TEST_CHAT_ID);

  telegram = { messageId, acceptedAt: new Date().toISOString() };
}

const proof = {
  mode: "live_bounded_provider_smoke",
  checkedAt: new Date().toISOString(),
  scope: verified,
  packageSha256: sha256(packageBytes),
  start: String(start),
  stop: String(stop),
  blocks,
  events,
  valued,
  checkpoint,
  evidenceIds: evidenceIds.slice(0, 30),
  graph: {
    subgraphId: graph.subgraphId,
    meta: graph._meta,
    sampledSwaps: graph.swaps.length,
    from: graph.from,
    to: graph.to,
    refreshedAt: graph.refreshedAt,
  },
  telegram,
  note: "This is a bounded provider read, not proof of a continuously running persisted watch or a signed swap. Activate through the app and inspect its technical proof for the full sequence.",
};

await mkdir(".scout/evidence", { recursive: true });
await writeFile(
  ".scout/evidence/live-smoke.json",
  JSON.stringify(proof, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(proof, null, 2));
