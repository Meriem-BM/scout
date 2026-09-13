import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WatchSpecSchema } from "@scout/domain";

import type { WatchSpec } from "@scout/domain";

export const TEMPLATE_VERSION = "scout-v3-bidirectional";

export const COMMON_SHA =
  "67cfcb8f52a65611d80d2fd6ee951ecb77d848ddcbda0eb5aac839e880b1e020";

export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export function pipelineIdentity(spec: WatchSpec, sourceHash: string) {
  return sha256(
    JSON.stringify({
      template: TEMPLATE_VERSION,
      sourceHash,
      common: COMMON_SHA,
      manifest: manifest(spec, "23000000"),
      pools: [...spec.pools].sort(),
      sellToken: spec.sellToken,
    }),
  );
}

export function manifest(spec: WatchSpec, initialBlock: string) {
  WatchSpecSchema.parse(spec);

  if (!/^\d{1,12}$/.test(initialBlock)) {
    throw new Error("Invalid initial block.");
  }

  const query = `(${spec.pools.map((pool) => `evt_addr:${pool}`).join(" || ")}) && evt_sig:0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`;

  return `specVersion: v0.1.0\npackage:\n  name: scout_watch\n  version: v0.1.0\n  url: https://ethglobal.com/events/ethonline2026\n  description: Scout generated pool and sell-direction module composition\nnetwork: mainnet\nimports:\n  eth_common: ./ethereum-common.spkg\nprotobuf:\n  excludePaths: [sf/substreams, google]\n  files: [scout.proto]\n  importPaths: [./proto]\nbinaries:\n  default:\n    type: wasm/rust-v1\n    file: ./scout_streams.wasm\nmodules:\n  - name: map_swaps\n    kind: map\n    initialBlock: ${initialBlock}\n    blockFilter:\n      module: eth_common:index_events\n      query:\n        string: ${JSON.stringify(query)}\n    inputs:\n      - source: sf.ethereum.type.v2.Block\n    output:\n      type: proto:scout.v1.Swaps\n  - name: map_watch\n    kind: map\n    inputs:\n      - params: string\n      - map: map_swaps\n    output:\n      type: proto:scout.v1.Swaps\nparams:\n  map_watch: ${JSON.stringify([...spec.pools].sort().join(",") + ";" + (spec.streamDirection === "either" ? "*" : spec.sellToken))}\n`;
}

export async function trustedSourceHash(templateDir: string) {
  const contents = await Promise.all(
    [
      "src/lib.rs",
      "proto/scout.proto",
      "Cargo.lock",
      "Cargo.toml",
      "abi/pool.json",
      "build.rs",
      "rust-toolchain.toml",
      "README.md",
    ].map((path) => readFile(join(templateDir, path))),
  );

  return sha256(Buffer.concat(contents));
}

export async function packPipeline(
  spec: WatchSpec,
  templateDir: string,
  directory: string,
  cli: string,
) {
  await mkdir(directory, { recursive: true });

  const common = await readFile(
    join(templateDir, "vendor/ethereum-common.spkg"),
  );

  if (sha256(common) !== COMMON_SHA) {
    throw new Error("Reusable package integrity check failed.");
  }

  // A stable floor preserves content-addressed reuse. Each deployment supplies its own bounded start block.
  const yaml = manifest(spec, "23000000");

  await writeFile(join(directory, "substreams.yaml"), yaml);
  await writeFile(join(directory, "ethereum-common.spkg"), common);

  for (const path of [
    "src",
    "proto",
    "abi",
    "Cargo.toml",
    "Cargo.lock",
    "build.rs",
    "rust-toolchain.toml",
    "README.md",
  ]) {
    await cp(join(templateDir, path), join(directory, path), {
      recursive: true,
    });
  }

  const compileLog = await runControlled(
    "cargo",
    ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown"],
    directory,
    240_000,
  );

  await cp(
    join(directory, "target/wasm32-unknown-unknown/release/scout_streams.wasm"),
    join(directory, "scout_streams.wasm"),
  );

  const packLog = await runControlled(
    cli,
    ["pack", "substreams.yaml", "-o", "scout.spkg"],
    directory,
    90_000,
  );
  const buildLog = `${compileLog}\n${packLog}`.trim();
  const bytes = await readFile(join(directory, "scout.spkg"));

  if (bytes.length < 1000 || bytes.length > 50_000_000) {
    throw new Error("Invalid package size.");
  }

  return { bytes, manifest: yaml, buildLog, packageSha256: sha256(bytes) };
}

function runControlled(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: {
        PATH: process.env.PATH,
        TMPDIR: cwd,
        CARGO_HOME: process.env.CARGO_HOME,
        RUSTUP_HOME: process.env.RUSTUP_HOME,
        CARGO_NET_OFFLINE: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");

      if (!settled) {
        settled = true;
        reject(
          new Error(
            `${command} exceeded its ${Math.round(timeoutMs / 1000)} second build limit.`,
          ),
        );
      }
    }, timeoutMs);

    const collect = (data: Buffer) => {
      output += data.toString();

      if (output.length > 1_000_000) {
        child.kill("SIGKILL");

        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("Build log exceeded limit."));
        }
      }
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timeout);

      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);

      if (!settled) {
        settled = true;

        if (code === 0) {
          resolve(output);
        } else {
          reject(
            new Error(
              `${command} failed with code ${code}. ${output.slice(-1000)}`,
            ),
          );
        }
      }
    });
  });
}
