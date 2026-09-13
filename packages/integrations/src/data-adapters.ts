import {
  DATA_CAPABILITIES,
  type DataCapability,
  type NormalizedOnchainEvent,
  normalizeLegacySwap,
  type WatchProgram,
} from "@scout/domain";

import { normalizeBlock } from "./substreams";

import type { Ethereum } from "./ethereum";
import type { StreamBlock } from "./substreams";

export interface DataAdapter<Raw> {
  readonly capability: DataCapability;
  canSatisfy(source: WatchProgram["source"]): {
    compatible: boolean;
    missing: string[];
  };
  normalize(raw: Raw): Promise<NormalizedOnchainEvent[]>;
  verificationHints(): readonly string[];
}

type Provenance = NormalizedOnchainEvent["provenance"];

function match(capability: DataCapability, source: WatchProgram["source"]) {
  const missing: string[] = [];

  if (source.chainId !== capability.chainId) {
    missing.push("chain");
  }

  if (source.eventType !== capability.eventType) {
    missing.push("eventType");
  }

  if (source.protocol !== capability.protocol) {
    missing.push("protocol");
  }

  if (
    !source.contracts.length ||
    source.contracts.some((c) => !capability.contracts.includes(c))
  ) {
    missing.push("contract scope");
  }

  return { compatible: !missing.length, missing };
}

export function uniswapDataAdapter(
  rpc: Ethereum,
  provenance: Provenance,
  onDiagnostic: (code: string) => void,
): DataAdapter<StreamBlock> {
  const capability = DATA_CAPABILITIES.find(
    (c) => c.id === "ethereum-v3-swaps",
  )!;

  return {
    capability,
    canSatisfy: (source) => match(capability, source),
    async normalize(raw) {
      return (await normalizeBlock(raw, rpc, onDiagnostic)).map((event) =>
        normalizeLegacySwap(event, provenance),
      );
    },
    verificationHints: () => [
      "Compare canonical block and initiator to RPC",
      "Compare output IDs and signed amounts to independent reference swaps",
      "Validate price feed at block",
    ],
  };
}
