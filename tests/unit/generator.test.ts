import { describe, expect, it } from "vitest";

import { defaultSpec, POOLS, TOKENS } from "@scout/domain";

import {
  manifest,
  pipelineIdentity,
} from "../../apps/worker/src/pipeline/generate";

describe("constrained reusable module composition", () => {
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
