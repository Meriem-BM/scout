import { describe, expect, it } from "vitest";

import { IntegrationError } from "@scout/integrations/http";

import {
  buildFailureCode,
  consumesRepairBudget,
  safeDiagnostic,
} from "../../apps/worker/src/errors";

describe("worker error boundaries", () => {
  it("redacts provider URLs and request bodies before persistence", () => {
    const result = safeDiagnostic(
      new Error(
        'Request failed\nURL: https://rpc.example/v2/private-key\nRequest body: {"method":"eth_chainId"}',
      ),
    );

    expect(result).toContain("[provider URL redacted]");
    expect(result).toContain("Request body: [redacted]");
    expect(result).not.toContain("private-key");
    expect(result).not.toContain("eth_chainId");
  });

  it("does not spend repair attempts on provider or environment setup", () => {
    expect(
      consumesRepairBudget(
        buildFailureCode(
          new IntegrationError(
            "SUBSTREAMS_AUTHENTICATION",
            "The provider rejected this key.",
          ),
        ),
      ),
    ).toBe(false);
    expect(
      consumesRepairBudget(
        buildFailureCode(new Error("ENOENT: no such file or directory")),
      ),
    ).toBe(false);
    expect(
      consumesRepairBudget(
        buildFailureCode(new Error("cargo failed with code 1")),
      ),
    ).toBe(true);
  });

  it("does not spend compiler repairs on provider limits or timeouts", () => {
    const rateCode = buildFailureCode(
      new Error("You reached Public endpoint rate limit"),
    );
    const timeoutCode = buildFailureCode(
      new Error("[internal] The operation was aborted due to timeout"),
    );

    expect(rateCode).toBe("RPC_RATE_LIMIT");
    expect(timeoutCode).toBe("PROVIDER_TIMEOUT");
    expect(consumesRepairBudget(rateCode)).toBe(false);
    expect(consumesRepairBudget(timeoutCode)).toBe(false);
  });
});
