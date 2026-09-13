/** EIP-1193 rejection is definite; transport failures may follow a broadcast. */
export function walletSubmissionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";

  if (/reject|denied|4001/i.test(message)) {
    return "Signature rejected. Scout will not retry this signing attempt. Request a fresh quote only if you choose.";
  }

  if (/insufficient funds/i.test(message)) {
    return "Insufficient token balance or ETH for network fees. This signing attempt will not be retried.";
  }

  return "The wallet did not return a confirmed submission identity. Check its transaction history before requesting another quote; a transaction may already have been broadcast. Scout will not retry this signing attempt.";
}
