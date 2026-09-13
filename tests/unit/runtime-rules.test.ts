import { describe, expect, it } from "vitest";

import {
  defaultSpec,
  evaluateRuntimeRule,
  WatchSpecSchema,
} from "@scout/domain";

import type { RuntimeEvent, RuntimeRule } from "@scout/domain";

const rule = (): RuntimeRule => ({
  id: "volume",
  predicates: [],
  groupBy: ["pool"],
  aggregate: { operation: "sum", field: "usdMicros" },
  windowSeconds: 60,
  threshold: "0",
  operator: "gt",
  baseline: { windowSeconds: 120, multiplierMicros: "2000000", minimum: "1" },
});
const event = (
  id: string,
  timestamp: number,
  value: string | null,
): RuntimeEvent => ({
  id,
  timestamp,
  chainId: 1,
  blockNumber: String(timestamp),
  index: 0,
  finalized: true,
  fields: { pool: "pool-a", usdMicros: value, participant: id },
});
const anchor = event("anchor", 1000, "101");
const baseline = event("baseline", 900, "100");
const coverage = { from: 820, through: 1000 };

describe("durable runtime rules", () => {
  it("normalizes different windows with exact integer arithmetic", () => {
    const result = evaluateRuntimeRule(rule(), anchor, [baseline], coverage);

    expect(result.status).toBe("MATCH");
    expect(result.observed).toBe("101");
    expect(result.baseline).toBe("100");
    expect(result.evidenceIds).toEqual(["anchor"]);
    expect(result.baselineEvidenceIds).toEqual(["baseline"]);
    expect(
      evaluateRuntimeRule(
        rule(),
        { ...anchor, fields: { ...anchor.fields, usdMicros: "100" } },
        [baseline],
        coverage,
      ).status,
    ).toBe("NO_MATCH");
  });
  it("requires complete coverage and a nonzero baseline", () => {
    expect(
      evaluateRuntimeRule(rule(), anchor, [baseline], {
        ...coverage,
        from: 821,
      }).status,
    ).toBe("INSUFFICIENT_DATA");
    expect(
      evaluateRuntimeRule(rule(), anchor, [baseline], {
        ...coverage,
        through: 999,
      }).status,
    ).toBe("INSUFFICIENT_DATA");
    expect(evaluateRuntimeRule(rule(), anchor, [], coverage).status).toBe(
      "INSUFFICIENT_DATA",
    );
  });
  it("rejects missing values in either observation window", () => {
    for (const timestamp of [900, 970]) {
      expect(
        evaluateRuntimeRule(
          rule(),
          anchor,
          [baseline, event("missing", timestamp, null)],
          coverage,
        ).status,
      ).toBe("INSUFFICIENT_DATA");
    }
  });
  it("uses nonoverlapping boundaries and ignores future, unrelated and provisional events", () => {
    const history = [
      event("outside", 820, "99999"),
      event("boundary", 940, "100"),
      event("future", 1001, "99999"),
      { ...event("provisional", 950, "99999"), finalized: false },
      {
        ...event("other", 900, "99999"),
        fields: { pool: "pool-b", usdMicros: "99999" },
      },
    ];
    const result = evaluateRuntimeRule(rule(), anchor, history, coverage);

    expect(result.status).toBe("MATCH");
    expect(result.baselineEvidenceIds).toEqual(["boundary"]);
  });
  it("deduplicates canonical events and rejects conflicting duplicates", () => {
    expect(
      evaluateRuntimeRule(
        rule(),
        anchor,
        [baseline, baseline, anchor],
        coverage,
      ).observed,
    ).toBe("101");
    expect(
      evaluateRuntimeRule(
        rule(),
        anchor,
        [
          baseline,
          { ...baseline, fields: { ...baseline.fields, usdMicros: "1" } },
        ],
        coverage,
      ).status,
    ).toBe("INSUFFICIENT_DATA");
  });
  it("counts events and distinct participants independently of a protocol", () => {
    const current = [event("one", 960, "1"), event("two", 980, "1")];
    const count = {
      ...rule(),
      baseline: null,
      aggregate: { operation: "count" as const, field: null },
      threshold: "2",
    };

    expect(evaluateRuntimeRule(count, anchor, current, coverage).observed).toBe(
      "3",
    );

    const distinct = {
      ...count,
      aggregate: { operation: "distinct" as const, field: "participant" },
      threshold: "1",
    };

    expect(
      evaluateRuntimeRule(
        distinct,
        anchor,
        current.map((item) => ({
          ...item,
          fields: { ...item.fields, participant: "same" },
        })),
        coverage,
      ).observed,
    ).toBe("2");
  });
  it("does not emit a previous match for an anchor excluded by predicates", () => {
    const filtered = {
      ...rule(),
      baseline: null,
      predicates: [
        { kind: "field" as const, field: "participant", values: ["one"] },
      ],
    };

    expect(
      evaluateRuntimeRule(
        filtered,
        anchor,
        [event("one", 970, "99999")],
        coverage,
      ).status,
    ).toBe("NO_MATCH");
  });
  it("bounds executable swap rules to retained history and compatible units", () => {
    const spec = (value: RuntimeRule) => ({
      ...defaultSpec(),
      conditions: [
        { kind: "aggregate", rule: value, description: "Volume comparison" },
      ],
    });

    expect(WatchSpecSchema.safeParse(spec(rule())).success).toBe(true);
    expect(
      WatchSpecSchema.safeParse(spec({ ...rule(), windowSeconds: 7200 }))
        .success,
    ).toBe(false);
    expect(
      WatchSpecSchema.safeParse(spec({ ...rule(), groupBy: [] })).success,
    ).toBe(false);
    expect(
      WatchSpecSchema.safeParse(
        spec({ ...rule(), aggregate: { operation: "sum", field: "amount" } }),
      ).success,
    ).toBe(false);
  });
});
