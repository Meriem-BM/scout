import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { consumeHistorical } from "@scout/integrations/substreams-cli";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("controlled Substreams CLI execution", () => {
  it("parses bounded JSONL output without exposing credentials to arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-cli-test-"));
    const executable = join(directory, "substreams");

    directories.push(directory);
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv.includes("private-test-token")) process.exit(9);
process.stdout.write(JSON.stringify({"@module":"map_watch","@block":101,"@data":{"swaps":[]}}) + "\\n");
`,
    );
    await chmod(executable, 0o700);

    const blocks = [];

    for await (const block of consumeHistorical({
      endpoint: "https://mainnet.eth.streamingfast.io:443",
      token: "private-test-token",
      substreamsBin: executable,
      packageBytes: new Uint8Array(1_000),
      startBlock: "100",
      stopBlock: "102",
      signal: new AbortController().signal,
    })) {
      blocks.push(block);
    }

    expect(blocks).toEqual([{ number: "101", swaps: [] }]);
  });

  it("rejects unbounded or oversized historical ranges before spawning", async () => {
    const stream = consumeHistorical({
      endpoint: "https://mainnet.eth.streamingfast.io:443",
      token: "private-test-token",
      substreamsBin: "substreams",
      packageBytes: new Uint8Array(1_000),
      startBlock: "100",
      stopBlock: "6001",
      signal: new AbortController().signal,
    });

    await expect(stream.next()).rejects.toThrow(
      "Invalid bounded Substreams block range.",
    );
  });
});
