import { BASE_USDC_EXECUTOR, isBaseUsdcIntent } from "./erc20";
import {
  compileV4Intent,
  isV4LiquidityIntent,
  V4_LIQUIDITY_EXECUTOR,
} from "./uniswap/v4";
import { canonicalUniswapTokenSymbol } from "./uniswap-scope";

import type { WatchIntentSpec } from "./workflow";

export const WATCH_ACTIVITY_TYPES = [
  "swap",
  "transfer",
  "liquidity_addition",
  "liquidity_removal",
  "pool_creation",
  "wallet_activity",
  "volume_burst",
  "liquidation_risk",
  "contract_event",
] as const;

export type WatchActivityType = (typeof WATCH_ACTIVITY_TYPES)[number];

export type ProtocolExecutionCapability = {
  executorId: string | null;
  status: "verified" | "planning";
  reason: string | null;
};

export type ProtocolDataBlueprint = {
  applicationResponsibilities: string[];
  deterministicDerivedFields: string[];
  domain: string;
  entity: string;
  fields: string[];
  historicalQueries: string[];
};

export interface ProtocolProfile {
  aliases: string[];
  data: Partial<Record<WatchActivityType, ProtocolDataBlueprint>>;
  execution: Partial<Record<WatchActivityType, ProtocolExecutionCapability>>;
  id: string;
  investigationCapabilities: string[];
  name: string;
  packageHints: {
    compatibilityTerms: string[];
    queries: string[];
  };
  presentation: {
    accent: "blue" | "green" | "neutral" | "pink";
    description: string;
    shortName: string;
    subjectVisual: "pair" | "protocol" | "wallet";
  };
  supportedChains: string[];
  supportedVersions: string[];
  terminology: {
    activities: string[];
    entities: string[];
  };
  verificationFields: string[];
}

const sharedApplicationResponsibilities = [
  "deterministic rule evaluation",
  "window grouping",
  "historical context",
  "evidence-grounded investigation",
  "notification delivery",
];

export const UniswapProtocolProfile: ProtocolProfile = {
  id: "uniswap",
  name: "Uniswap",
  aliases: ["uniswap", "uniswap-v2", "uniswap-v3", "uniswap-v4"],
  supportedChains: ["ethereum", "base", "arbitrum", "optimism"],
  supportedVersions: ["v2", "v3", "v4"],
  terminology: {
    entities: ["pool", "pair", "liquidity position", "swap"],
    activities: [
      "whale swap",
      "large buy",
      "large sell",
      "liquidity exit",
      "liquidity addition",
      "LP activity",
      "new pool",
      "volume burst",
      "repeated swap",
    ],
  },
  data: {
    swap: {
      domain: "dex",
      entity: "swap",
      fields: [
        "pool address",
        "transaction hash",
        "log index",
        "block number",
        "block timestamp",
        "transaction initiator",
        "token0 address",
        "token1 address",
        "token0 amount",
        "token1 amount",
        "recipient",
      ],
      deterministicDerivedFields: [
        "swap direction",
        "sold token",
        "USD value",
        "canonical event id",
        "rule match",
      ],
      historicalQueries: [
        "prior Uniswap swaps by observed transaction initiator",
        "recent pool activity",
      ],
      applicationResponsibilities: [
        "threshold evaluation",
        "pair matching",
        "direction rules",
        ...sharedApplicationResponsibilities,
      ],
    },
    liquidity_addition: {
      domain: "dex",
      entity: "liquidity addition",
      fields: [
        "pool address",
        "transaction hash",
        "log index",
        "block number",
        "block timestamp",
        "token addresses",
        "token amounts",
        "observed sender",
        "position identifier",
      ],
      deterministicDerivedFields: [
        "USD value",
        "canonical event id",
        "rule match",
      ],
      historicalQueries: ["recent pool liquidity activity"],
      applicationResponsibilities: [
        "threshold evaluation",
        ...sharedApplicationResponsibilities,
      ],
    },
    liquidity_removal: {
      domain: "dex",
      entity: "liquidity removal",
      fields: [
        "pool address",
        "transaction hash",
        "log index",
        "block number",
        "block timestamp",
        "token addresses",
        "token amounts",
        "observed sender",
        "position identifier",
      ],
      deterministicDerivedFields: [
        "USD value",
        "canonical event id",
        "rule match",
      ],
      historicalQueries: [
        "recent pool liquidity activity",
        "previous position activity",
      ],
      applicationResponsibilities: [
        "threshold evaluation",
        ...sharedApplicationResponsibilities,
      ],
    },
    pool_creation: {
      domain: "dex",
      entity: "pool creation",
      fields: [
        "factory address",
        "pool address",
        "transaction hash",
        "log index",
        "block number",
        "block timestamp",
        "token addresses",
        "pool parameters",
      ],
      deterministicDerivedFields: ["canonical event id", "rule match"],
      historicalQueries: [],
      applicationResponsibilities: sharedApplicationResponsibilities,
    },
    volume_burst: {
      domain: "dex",
      entity: "swap",
      fields: [
        "pool address",
        "transaction hash",
        "log index",
        "block number",
        "block timestamp",
        "token addresses",
        "token amounts",
      ],
      deterministicDerivedFields: [
        "USD value",
        "rolling volume",
        "canonical event id",
        "rule match",
      ],
      historicalQueries: ["recent pool volume baseline"],
      applicationResponsibilities: sharedApplicationResponsibilities,
    },
    wallet_activity: {
      domain: "dex",
      entity: "protocol wallet activity",
      fields: [
        "observed address",
        "transaction hash",
        "log index",
        "block number",
        "block timestamp",
        "pool address",
        "token addresses",
        "token amounts",
      ],
      deterministicDerivedFields: ["canonical event id", "rule match"],
      historicalQueries: ["previous Uniswap activity by observed address"],
      applicationResponsibilities: sharedApplicationResponsibilities,
    },
  },
  packageHints: {
    queries: [
      "uniswap",
      "uniswap v3",
      "uniswap v4",
      "dex swaps",
      "pool events",
      "liquidity events",
    ],
    compatibilityTerms: ["uniswap", "uniswap v2", "uniswap v3", "uniswap v4"],
  },
  investigationCapabilities: [
    "previous Uniswap activity for an observed address",
    "recent pool activity",
    "trade size relative to retrieved history",
    "nearby same-direction swaps",
  ],
  verificationFields: [
    "pool address",
    "transaction hash",
    "block number",
    "log index",
    "token0 address",
    "token1 address",
    "token0 amount",
    "token1 amount",
    "swap direction",
  ],
  presentation: {
    shortName: "Uniswap",
    description:
      "Deep protocol support with live Substreams detection and historical Graph context.",
    accent: "pink",
    subjectVisual: "pair",
  },
  execution: {
    volume_burst: {
      status: "verified",
      executorId: "uniswap-v3-ethereum-swap-v1",
      reason: null,
    },
    swap: {
      status: "verified",
      executorId: "uniswap-v3-ethereum-swap-v1",
      reason: null,
    },
  },
};

export const Erc20ProtocolProfile: ProtocolProfile = {
  id: "erc20",
  name: "ERC-20",
  aliases: ["erc20", "erc-20", "token transfer", "token transfers"],
  supportedChains: ["ethereum", "base", "arbitrum", "optimism"],
  supportedVersions: [],
  terminology: {
    entities: ["token", "wallet", "transfer"],
    activities: ["large transfer", "wallet inflow", "wallet outflow"],
  },
  data: {
    transfer: {
      domain: "evm",
      entity: "token transfer",
      fields: [
        "token address",
        "from address",
        "to address",
        "amount",
        "transaction hash",
        "log index",
        "block number",
        "block timestamp",
      ],
      deterministicDerivedFields: [
        "transfer direction",
        "USD value when a reliable price exists",
        "canonical event id",
        "rule match",
      ],
      historicalQueries: ["previous transfers for the observed address"],
      applicationResponsibilities: sharedApplicationResponsibilities,
    },
    wallet_activity: {
      domain: "evm",
      entity: "wallet transaction",
      fields: [
        "observed address",
        "from address",
        "to address",
        "value",
        "transaction hash",
        "block number",
        "block timestamp",
      ],
      deterministicDerivedFields: ["canonical event id", "rule match"],
      historicalQueries: ["previous activity for the observed address"],
      applicationResponsibilities: sharedApplicationResponsibilities,
    },
  },
  packageHints: {
    queries: ["erc20 transfers", "ethereum token transfers", "evm events"],
    compatibilityTerms: ["erc20", "erc-20", "token transfer"],
  },
  investigationCapabilities: [
    "previous transfers for an observed address",
    "recent token activity",
  ],
  verificationFields: [
    "token address",
    "from address",
    "to address",
    "amount",
    "transaction hash",
    "block number",
    "log index",
  ],
  presentation: {
    shortName: "Token transfers",
    description: "Generic EVM token and wallet monitoring.",
    accent: "blue",
    subjectVisual: "wallet",
  },
  execution: {},
};

export const AaveProtocolProfile: ProtocolProfile = {
  id: "aave",
  name: "Aave",
  aliases: ["aave"],
  supportedChains: ["ethereum", "base", "arbitrum", "optimism"],
  supportedVersions: ["v2", "v3"],
  terminology: {
    entities: ["position", "reserve", "liquidation"],
    activities: ["liquidation risk", "borrow", "repay", "liquidation"],
  },
  data: {
    liquidation_risk: {
      domain: "lending",
      entity: "position health",
      fields: [
        "account address",
        "reserve address",
        "collateral balance",
        "debt balance",
        "health factor inputs",
        "block number",
        "block timestamp",
      ],
      deterministicDerivedFields: [
        "health factor",
        "distance to configured threshold",
        "canonical observation id",
        "rule match",
      ],
      historicalQueries: ["recent position and reserve state"],
      applicationResponsibilities: sharedApplicationResponsibilities,
    },
  },
  packageHints: {
    queries: ["aave", "aave v3", "lending positions", "ethereum events"],
    compatibilityTerms: ["aave", "aave v2", "aave v3"],
  },
  investigationCapabilities: [
    "recent position health",
    "reserve and collateral context",
  ],
  verificationFields: [
    "account address",
    "reserve address",
    "block number",
    "health factor inputs",
  ],
  presentation: {
    shortName: "Aave",
    description: "Protocol-aware lending intent planning.",
    accent: "green",
    subjectVisual: "protocol",
  },
  execution: {},
};

export const GenericEvmProtocolProfile: ProtocolProfile = {
  id: "generic-evm",
  name: "Onchain",
  aliases: ["evm", "onchain", "contract"],
  supportedChains: ["ethereum", "base", "arbitrum", "optimism"],
  supportedVersions: [],
  terminology: {
    entities: ["wallet", "contract", "event", "transaction"],
    activities: ["wallet activity", "contract event", "value transfer"],
  },
  data: {
    transfer: {
      domain: "evm",
      entity: "value transfer",
      fields: [
        "from address",
        "to address",
        "value",
        "transaction hash",
        "block number",
        "block timestamp",
      ],
      deterministicDerivedFields: ["canonical event id", "rule match"],
      historicalQueries: ["previous activity for the observed address"],
      applicationResponsibilities: sharedApplicationResponsibilities,
    },
    wallet_activity: {
      domain: "evm",
      entity: "wallet transaction",
      fields: [
        "observed address",
        "from address",
        "to address",
        "value",
        "transaction hash",
        "block number",
        "block timestamp",
      ],
      deterministicDerivedFields: ["canonical event id", "rule match"],
      historicalQueries: ["previous activity for the observed address"],
      applicationResponsibilities: sharedApplicationResponsibilities,
    },
    contract_event: {
      domain: "evm",
      entity: "contract event",
      fields: [
        "contract address",
        "event topics",
        "event data",
        "transaction hash",
        "log index",
        "block number",
        "block timestamp",
      ],
      deterministicDerivedFields: ["canonical event id", "rule match"],
      historicalQueries: [],
      applicationResponsibilities: sharedApplicationResponsibilities,
    },
  },
  packageHints: {
    queries: ["evm events", "ethereum common", "blockchain events"],
    compatibilityTerms: ["ethereum common", "evm", "ethereum"],
  },
  investigationCapabilities: ["previous activity for an observed address"],
  verificationFields: [
    "transaction hash",
    "block number",
    "log index",
    "contract address",
  ],
  presentation: {
    shortName: "Onchain activity",
    description: "Generic EVM event and wallet intent planning.",
    accent: "neutral",
    subjectVisual: "wallet",
  },
  execution: {},
};

export const protocolProfiles = [
  UniswapProtocolProfile,
  Erc20ProtocolProfile,
  AaveProtocolProfile,
  GenericEvmProtocolProfile,
] as const;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();

export function profileForProtocol(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = normalize(value);

  return (
    protocolProfiles.find((profile) =>
      profile.aliases.some((alias) => {
        const normalizedAlias = normalize(alias);

        return (
          normalized === normalizedAlias || normalized.includes(normalizedAlias)
        );
      }),
    ) ?? null
  );
}

export function protocolProfileForIntent(intent: WatchIntentSpec) {
  const explicit = profileForProtocol(intent.subject.protocol?.value);

  if (explicit) {
    return explicit;
  }

  if (
    intent.activity.type.value === "transfer" &&
    intent.subject.tokens.length > 0
  ) {
    return Erc20ProtocolProfile;
  }

  return GenericEvmProtocolProfile;
}

export function protocolExecution(
  profile: ProtocolProfile,
  intent: WatchIntentSpec,
): ProtocolExecutionCapability {
  if (isBaseUsdcIntent(intent)) {
    return { status: "verified", executorId: BASE_USDC_EXECUTOR, reason: null };
  }

  if (isV4LiquidityIntent(intent)) {
    try {
      compileV4Intent(intent);

      return {
        status: "verified",
        executorId: V4_LIQUIDITY_EXECUTOR,
        reason: null,
      };
    } catch (error) {
      return {
        status: "planning",
        executorId: null,
        reason:
          error instanceof Error
            ? error.message
            : "Unsupported V4 liquidity scope",
      };
    }
  }

  const configured = profile.execution[intent.activity.type.value];
  const chain = intent.subject.chain?.value;
  const version = intent.subject.protocolVersion?.value.toLowerCase() ?? null;

  if (!configured || configured.status !== "verified") {
    return {
      status: "planning",
      executorId: null,
      reason: `${profile.name} ${intent.activity.type.value.replaceAll("_", " ")} monitoring can be planned, but Scout does not yet have a verified live executor for it.`,
    };
  }

  if (
    profile.id !== "uniswap" ||
    chain !== "ethereum" ||
    (version !== "v3" && version !== "3")
  ) {
    return {
      status: "planning",
      executorId: null,
      reason:
        "Scout's currently verified Uniswap executor covers V3 swaps on Ethereum. This intent remains saved with its data plan, but it cannot be activated until an executor for the resolved network and version is verified.",
    };
  }

  const tokens = intent.subject.tokens.map((token) =>
    canonicalUniswapTokenSymbol(token.value),
  );

  if (!tokens.includes("WETH") || !tokens.includes("USDC")) {
    return {
      status: "planning",
      executorId: null,
      reason:
        "Scout resolved the Uniswap swap intent, but its currently verified live executor covers the WETH / USDC pair. The data plan is preserved without claiming this pair is live.",
    };
  }

  return configured;
}

export function protocolLabel(
  profile: ProtocolProfile,
  version?: string | null,
) {
  const cleanVersion = version?.trim();

  return cleanVersion ? `${profile.name} ${cleanVersion}` : profile.name;
}
