export const FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";

export const TOKENS = [
  {
    symbol: "WETH",
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    decimals: 18,
    feed: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
    heartbeat: 3600,
  },
  {
    symbol: "USDC",
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    feed: "0x8fffffd4afb6115b954bd326cbe7b4ba576818f6",
    heartbeat: 86400,
  },
] as const;

export const POOLS = [
  {
    address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    name: "WETH / USDC",
    fee: 500,
    feeLabel: "0.05%",
    token0: TOKENS[1],
    token1: TOKENS[0],
  },
  {
    address: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
    name: "WETH / USDC",
    fee: 3000,
    feeLabel: "0.30%",
    token0: TOKENS[1],
    token1: TOKENS[0],
  },
] as const;

export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

export const ROUTERS = [
  "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
  "0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca",
] as const;

export const ENTRYPOINTS = [
  "0x0000000071727de22e5e9d8baf0edac6f37da032",
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
];

export function tokenByAddress(address: string) {
  const token = TOKENS.find((item) => item.address === address.toLowerCase());

  if (!token) {
    throw new Error("Unsupported token. Choose WETH or USDC on Ethereum.");
  }

  return token;
}

export function canonicalUniswapTokenSymbol(value: string) {
  const normalized = value.trim().toLowerCase();

  if (normalized === "eth") {
    return "WETH";
  }

  return (
    TOKENS.find(
      (token) =>
        token.address === normalized ||
        token.symbol.toLowerCase() === normalized,
    )?.symbol ?? value.trim().toUpperCase()
  );
}

export function poolByAddress(address: string) {
  const pool = POOLS.find((item) => item.address === address.toLowerCase());

  if (!pool) {
    throw new Error("This pool is outside Scout's supported scope.");
  }

  return pool;
}
