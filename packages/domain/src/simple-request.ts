import { applyConfirmedPoolScope } from "./intent-clarification";
import { units } from "./money";
import { resolveWatchStarter, WATCH_STARTERS } from "./watch-starters";

/** A deliberately closed grammar for simple amount requests. It cannot swallow
 * extra wallet/history/window conditions; those continue through full resolution.
 * This supplies intent, never support or activation authority. */
export function resolveSimpleMonitoringRequest(
  prompt: string,
  answers: Array<{ field: string; answer: string }> = [],
) {
  const swap =
    /^watch\s+\$([\d]+(?:\.\d{1,6})?)([km]?)\+?\s+(?:ETH|WETH)\s+(buys|sells)\s+on\s+Uniswap\s+V3(?:\s+on\s+Ethereum)?\.?$/i.exec(
      prompt.trim(),
    );
  const transfer =
    /^watch\s+(?:native\s+)?USDC\s+transfers\s+above\s+\$([\d]+(?:\.\d{1,6})?)([km]?)\s+on\s+Base\.?$/i.exec(
      prompt.trim(),
    );
  const match = swap ?? transfer;

  if (
    !match ||
    (transfer && answers.length) ||
    answers.some((a) => a.field !== "poolScope")
  ) {
    return null;
  }

  let micros: bigint;

  try {
    micros =
      units(match[1]!, 6) *
      (match[2]!.toLowerCase() === "m"
        ? 1_000_000n
        : match[2]!.toLowerCase() === "k"
          ? 1_000n
          : 1n);
  } catch {
    return null;
  }

  if (micros <= 0n || micros >= 1_000_000_000_000_000_000n) {
    return null;
  }

  const tail = String(micros % 1_000_000n)
    .padStart(6, "0")
    .replace(/0+$/, "");
  const threshold = String(micros / 1_000_000n) + (tail ? `.${tail}` : "");
  const intent = resolveWatchStarter(WATCH_STARTERS[swap ? 0 : 1].prompt)!;

  intent.filters[0]!.value = threshold;
  // Delivery and continuous mode are product defaults, not text supplied by the user.
  intent.temporal.mode.source = "inferred";

  if (swap) {
    intent.subject.contracts = [];
    intent.subject.chain!.source = /on\s+Ethereum/i.test(prompt)
      ? "explicit"
      : "inferred";
    intent.subject.tokens = intent.subject.tokens.map((token) => ({
      ...token,
      source: token.value === "USDC" ? "resolved" : "explicit",
    }));
    intent.activity.direction = {
      value: swap[3]!.toLowerCase() === "buys" ? "buy" : "sell",
      source: "explicit",
      confidence: 1,
    };

    if (answers.length && !applyConfirmedPoolScope(intent, answers)) {
      return null;
    }
  }

  return intent;
}
