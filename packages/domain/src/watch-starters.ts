import { POOLS } from "./uniswap-scope";
import { WatchIntentSpecSchema } from "./workflow";

const pools = POOLS.map((pool) => pool.address).join(" and ");

/** Exact, reviewable requests. Editing a request returns it to intent resolution. */
export const WATCH_STARTERS = [
  {
    id: "large-swaps",
    label: "Watch $250K+ Uniswap swaps",
    description: "Ethereum · V3 ETH/USDC · both supported pools",
    prompt: `Continuously watch Uniswap V3 ETH/USDC swaps above $250K on Ethereum, in either direction, in pools ${pools}. Use my alert delivery settings.`,
  },
  {
    id: "usdc-transfers",
    label: "Track $100K+ USDC transfers",
    description: "Base · native USDC · nominal dollar value",
    prompt:
      "Continuously flag native USDC transfers above $100K on Base, across all wallets. Use nominal USDC value. Use my alert delivery settings.",
  },
  {
    id: "liquidity-changes",
    label: "Watch V4 liquidity removals",
    description: "Ethereum · all V4 pools · no dollar threshold",
    prompt:
      "Continuously flag every Uniswap V4 liquidity removal on Ethereum across all pools, without an amount or USD threshold. Use my alert delivery settings.",
  },
  {
    id: "volume-spikes",
    label: "Detect 3× Uniswap volume",
    description: "Ethereum · V3 ETH/USDC · 5 minutes vs. prior hour",
    prompt: `Continuously flag Uniswap V3 ETH/USDC trading volume on Ethereum when its 5-minute rate exceeds 3 times the preceding hour's average rate, in either direction, in pools ${pools}. Use my alert delivery settings.`,
  },
] as const;

export const EXAMPLES = WATCH_STARTERS.map((starter) => starter.prompt);

export function resolveWatchStarter(prompt: string) {
  const starter = WATCH_STARTERS.find((item) => item.prompt === prompt.trim());

  if (!starter) {
    return null;
  }

  const source = <T>(value: T) => ({
    value,
    source: "explicit",
    confidence: 1,
  });
  const liquidity = starter.id === "liquidity-changes";
  const transfer = starter.id === "usdc-transfers";
  const volume = starter.id === "volume-spikes";

  return WatchIntentSpecSchema.parse({
    version: 1,
    subject: {
      chain: source(transfer ? "base" : "ethereum"),
      protocol: source(transfer ? "erc20" : "uniswap"),
      protocolVersion: transfer ? null : source(liquidity ? "v4" : "v3"),
      contracts:
        transfer || liquidity ? [] : POOLS.map((pool) => source(pool.address)),
      tokens: liquidity
        ? []
        : transfer
          ? [source("USDC")]
          : [source("ETH"), source("USDC")],
      wallets: [],
    },
    activity: {
      type: source(
        liquidity
          ? "liquidity_removal"
          : transfer
            ? "transfer"
            : volume
              ? "volume_burst"
              : "swap",
      ),
      event: null,
      direction: transfer || liquidity ? null : source("either"),
    },
    filters: liquidity
      ? []
      : [
          {
            field: transfer
              ? "transferUsd"
              : volume
                ? "volumeMultiplier"
                : "swapUsd",
            operator: "gt",
            value: transfer ? "100000" : volume ? "3" : "250000",
            unit: volume ? "x" : "USD",
            source: "explicit",
          },
        ],
    temporal: {
      mode: source("continuous"),
      evaluationWindowSeconds: volume ? source(300) : null,
      comparisonWindowSeconds: volume ? source(3600) : null,
    },
    investigation: [],
    investigationRequirements: [],
    delivery: [],
    assumptions: [],
    unresolved: [],
  });
}
