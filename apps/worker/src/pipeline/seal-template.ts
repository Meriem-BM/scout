import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256, trustedSourceHash } from "./generate";

const directory = process.argv[2];

if (!directory) {
  throw new Error("A template directory is required.");
}

const bytes = await readFile(
  join(directory, "target/wasm32-unknown-unknown/release/scout_streams.wasm"),
);

await writeFile(
  join(directory, "prebuilt.json"),
  JSON.stringify({
    sourceHash: await trustedSourceHash(directory),
    wasmHash: sha256(bytes),
  }),
);
