import Image from "next/image";

/** Brand artwork identifies a protocol; it does not imply capability support. */
export function ProtocolMark({
  protocol,
  size = 28,
}: {
  protocol: string | undefined;
  size?: number;
}) {
  if (!isUniswapMark(protocol)) {
    return null;
  }

  return (
    <Image
      className="protocol-mark"
      src="/brands/uniswap.webp"
      alt=""
      width={size}
      height={size}
      unoptimized
      style={{ width: size, height: size }}
    />
  );
}

export function isUniswapMark(value: string | undefined) {
  return /uniswap|v3-swaps|v4[_ -]?liquidity/i.test(value ?? "");
}
