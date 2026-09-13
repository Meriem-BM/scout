import { describe, expect, it } from "vitest";

import {
  matchOutputFields,
  outputFields,
} from "@scout/integrations/package-descriptors";

describe("Package output coverage", () => {
  const files = [
    {
      package: "test",
      messageType: [
        {
          name: "Swaps",
          field: [{ name: "swaps", typeName: ".test.Swap" }],
          nestedType: [],
        },
        {
          name: "Swap",
          field: [
            { name: "amount", typeName: "" },
            { name: "transaction_hash", typeName: "" },
          ],
          nestedType: [],
        },
        {
          name: "UnreachablePrice",
          field: [{ name: "usd_amount", typeName: "" }],
          nestedType: [],
        },
      ],
    },
  ];

  it("follows only messages reachable from a selected output", () => {
    const fields = outputFields(files, "proto:test.Swaps");

    expect(fields).toContain("swaps.transaction_hash");
    expect(fields).not.toContain("usd_amount");
    expect(
      matchOutputFields(["transaction hash", "USD amount"], fields),
    ).toEqual(["transaction hash"]);
  });
  it("does not accept substring collisions or unknown output types", () => {
    expect(
      matchOutputFields(["amount", "USD amount"], ["amount0", "amount1"]),
    ).toEqual([]);
    expect(outputFields(files, "proto:test.Missing")).toEqual([]);
  });
  it("terminates recursive message traversal", () => {
    expect(
      outputFields(
        [
          {
            package: "test",
            messageType: [
              {
                name: "Node",
                field: [{ name: "child", typeName: ".test.Node" }],
                nestedType: [],
              },
            ],
          },
        ],
        "proto:test.Node",
      ),
    ).toEqual(["child"]);
  });
});
