const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export function units(value: string, decimals: number): bigint {
  const match = DECIMAL.exec(value);

  if (!match || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(
      "Enter a positive decimal amount without commas or exponent notation.",
    );
  }

  const fraction = match[2] ?? "";

  if (fraction.length > decimals) {
    throw new Error(`Use at most ${decimals} decimal places.`);
  }

  return (
    BigInt(match[1] ?? "0") * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

export function decimal(
  value: bigint | string,
  decimals: number,
  places = decimals,
): string {
  const amount = BigInt(value);
  const sign = amount < 0n ? "-" : "";
  const padded = (amount < 0n ? -amount : amount)
    .toString()
    .padStart(decimals + 1, "0");

  if (decimals === 0) {
    return sign + padded;
  }

  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).slice(0, places).replace(/0+$/, "");

  return sign + whole + (fraction ? `.${fraction}` : "");
}

export function usd(value: bigint | string, compact = false): string {
  const amount = BigInt(value);

  if (compact && amount >= 1_000_000_000_000n) {
    return `$${decimal(amount / 1_000_000n, 6, 2)}m`;
  }

  const [whole = "0", fraction = ""] = decimal(amount, 6, 2).split(".");

  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction.padEnd(2, "0")}` : ""}`;
}

export function valueUsd(
  amount: string,
  tokenDecimals: number,
  price: string,
  priceDecimals: number,
): string {
  const raw = BigInt(amount);

  if (raw < 0n || BigInt(price) <= 0n) {
    throw new Error("Invalid valuation inputs.");
  }

  return (
    (raw * BigInt(price) * 1_000_000n) /
    10n ** BigInt(tokenDecimals + priceDecimals)
  ).toString();
}
