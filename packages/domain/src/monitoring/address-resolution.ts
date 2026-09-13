import { BASE_USDC } from "../erc20";
import { isV4LiquidityIntent } from "../uniswap/v4";
import { POOLS, TOKENS } from "../uniswap-scope";

import type { WatchIntentSpec } from "../workflow";

export type AddressResolution = {
  address: string;
  chainId: number;
  source: "USER_PROVIDED" | "CANONICAL_REGISTRY";
  canonical: boolean;
};

/** Address extraction is lexical validation of user input, not interpretation of
 * model prose. A model's own provenance/confidence is never address authority. */
export function validateIntentAddresses(
  intent: WatchIntentSpec,
  userInputs: readonly string[],
): AddressResolution[] {
  const chain = intent.subject.chain?.value;
  const chainId =
    chain === "base"
      ? 8453
      : chain === "ethereum"
        ? 1
        : chain === "arbitrum"
          ? 42161
          : 10;
  const canonical = new Set(
    chain === "base"
      ? [BASE_USDC]
      : chain === "ethereum"
        ? [...TOKENS.map((t) => t.address), ...POOLS.map((p) => p.address)]
        : [],
  );
  const supplied = new Set(
    userInputs
      .flatMap((input) => input.match(/\b0x[0-9a-fA-F]{40}\b/g) ?? [])
      .map((a) => a.toLowerCase()),
  );
  const resolutions: AddressResolution[] = [];

  for (const item of [
    ...intent.subject.contracts,
    ...intent.subject.wallets,
    ...intent.subject.tokens,
  ]) {
    if (!item.value.toLowerCase().startsWith("0x")) {
      continue;
    }

    const address = item.value.toLowerCase();

    if (
      isV4LiquidityIntent(intent) &&
      intent.subject.contracts.includes(item) &&
      /^0x[0-9a-f]{64}$/.test(address)
    ) {
      const poolIds = userInputs
        .flatMap((input) => input.match(/\b0x[0-9a-fA-F]{64}\b/g) ?? [])
        .map((id) => id.toLowerCase());

      if (!poolIds.includes(address)) {
        throw new Error("Model pool ID has no authoritative resolution.");
      }

      // Pool IDs are not addresses. Initialize evidence resolves their identities before evaluation.
      continue;
    }

    if (!/^0x[0-9a-f]{40}$/.test(address) || !chain) {
      throw new Error("Address requires a valid format and resolved chain.");
    }

    if (!canonical.has(address) && !supplied.has(address)) {
      throw new Error("Model address has no authoritative resolution.");
    }

    resolutions.push({
      address,
      chainId,
      source: supplied.has(address) ? "USER_PROVIDED" : "CANONICAL_REGISTRY",
      canonical: canonical.has(address),
    });
  }

  return resolutions;
}
