import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  COMMON_SHA,
  packPipeline,
  sha256,
} from "../apps/worker/src/pipeline/generate";
import { defaultSpec, WatchSpecSchema } from "../packages/domain/src/index";

const root = resolve("substreams");
const spec = process.argv[2]
  ? WatchSpecSchema.parse(JSON.parse(await readFile(process.argv[2], "utf8")))
  : defaultSpec();

await mkdir(resolve(root, "vendor"), { recursive: true });

const response = await fetch(
  "https://spkg.io/v1/packages/ethereum-common/v0.3.3",
  { signal: AbortSignal.timeout(30_000) },
);

if (!response.ok) {
  throw new Error("Could not obtain ethereum-common.");
}

const common = new Uint8Array(await response.arrayBuffer());

if (sha256(common) !== COMMON_SHA) {
  throw new Error("ethereum-common checksum mismatch.");
}

await writeFile(resolve(root, "vendor/ethereum-common.spkg"), common);
await promisify(execFile)(
  "cargo",
  ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown"],
  { cwd: root, maxBuffer: 4_000_000 },
);

const output = resolve(".scout/pipeline");
const artifact = await packPipeline(
  spec,
  root,
  output,
  process.env.SUBSTREAMS_BIN ?? "substreams",
);

console.log(
  JSON.stringify(
    {
      package: resolve(output, "scout.spkg"),
      sha256: artifact.packageSha256,
      providerValidation: "not run; use pnpm test:live with credentials",
    },
    null,
    2,
  ),
);
