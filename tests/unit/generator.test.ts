import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultSpec, POOLS, TOKENS } from "@scout/domain";

import {
  manifest,
  pipelineIdentity,
  prebuiltTemplate,
  sha256,
  trustedSourceHash,
} from "../../apps/worker/src/pipeline/generate";

describe("constrained reusable module composition", () => {
  it("reuses sealed WASM only while its source and binary still match", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scout-template-"));

    try {
      expect(await prebuiltTemplate(directory)).toBeNull();

      for (const file of [
        "src/lib.rs",
        "proto/scout.proto",
        "Cargo.lock",
        "Cargo.toml",
        "abi/pool.json",
        "build.rs",
        "rust-toolchain.toml",
        "README.md",
      ]) {
        await mkdir(dirname(join(directory, file)), { recursive: true });
        await writeFile(join(directory, file), file);
      }

      const binaryPath = join(
        directory,
        "target/wasm32-unknown-unknown/release/scout_streams.wasm",
      );
      const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

      await mkdir(dirname(binaryPath), { recursive: true });
      await writeFile(binaryPath, bytes);
      await writeFile(
        join(directory, "prebuilt.json"),
        JSON.stringify({
          sourceHash: await trustedSourceHash(directory),
          wasmHash: sha256(bytes),
        }),
      );
      expect((await prebuiltTemplate(directory))?.bytes).toEqual(bytes);
      await writeFile(binaryPath, Buffer.concat([bytes, Buffer.from([1])]));
      await expect(prebuiltTemplate(directory)).rejects.toThrow("integrity");
      await writeFile(binaryPath, bytes);
      await writeFile(join(directory, "src/lib.rs"), "modified decoder");
      await expect(prebuiltTemplate(directory)).rejects.toThrow("integrity");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("emits a real indexed decoder and parameterized output", () => {
    const yaml = manifest(defaultSpec(), "23000000");

    expect(yaml).toContain("eth_common:index_events");
    expect(yaml).toContain("source: sf.ethereum.type.v2.Block");
    expect(yaml).toContain("map: map_swaps");
    expect(yaml).toContain(POOLS[0].address);
    expect(yaml).toContain(TOKENS[0].address);
  });
  it("reuses the same ingestion package for different numeric rules", () => {
    const next = {
      ...defaultSpec(),
      conditions: [{ kind: "large_swap" as const, usd: "987654" }],
    };

    expect(pipelineIdentity(next, "trusted-hash")).toBe(
      pipelineIdentity(defaultSpec(), "trusted-hash"),
    );
  });
  it("changes identity for source, direction and pool selection", () => {
    expect(pipelineIdentity(defaultSpec(), "a")).not.toBe(
      pipelineIdentity(defaultSpec(), "b"),
    );
    expect(
      pipelineIdentity({ ...defaultSpec(), sellToken: TOKENS[1].address }, "a"),
    ).not.toBe(pipelineIdentity(defaultSpec(), "a"));
    expect(
      pipelineIdentity({ ...defaultSpec(), pools: [POOLS[1].address] }, "a"),
    ).not.toBe(pipelineIdentity(defaultSpec(), "a"));
  });
  it("never accepts executable parameters or unsupported contracts", () => {
    expect(() =>
      manifest({ ...defaultSpec(), pools: ["$(touch /tmp/not-allowed)"] }, "1"),
    ).toThrow();
    expect(() => manifest(defaultSpec(), "1\ncommand: sh")).toThrow();
  });
});
