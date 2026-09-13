import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { mainnet } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PROMPT,
  PERMIT2,
  POOLS,
  ROUTERS,
  TOKENS,
  TradeIntentSchema,
} from "@scout/domain";
import { GroqAdapter } from "@scout/integrations/ai";
import { validatePools } from "@scout/integrations/ethereum";
import { UniswapAdapter } from "@scout/integrations/uniswap";

const wallet = "0x1111111111111111111111111111111111111111";
const intent = TradeIntentSchema.parse({
  wallet,
  chainId: 1,
  tokenIn: TOKENS[0].address,
  tokenOut: TOKENS[1].address,
  amount: "1",
  slippageBps: 50,
});
const rpc = createPublicClient({
  chain: mainnet,
  transport: custom({
    async request() {
      return encodeAbiParameters([{ type: "uint256" }], [10n ** 24n]);
    },
  }),
});

afterEach(() => vi.unstubAllGlobals());

describe("Ethereum RPC boundary", () => {
  it("turns provider authentication failures into a safe configuration error", async () => {
    const protectedRpc = createPublicClient({
      chain: mainnet,
      transport: custom({
        async request() {
          throw new Error(
            "Must be authenticated. URL: https://rpc.example/v2/private-key",
          );
        },
      }),
    });

    await expect(validatePools(protectedRpc, [])).rejects.toMatchObject({
      code: "RPC_AUTHENTICATION",
      message:
        "The Ethereum RPC rejected Scout's credentials. Update ETHEREUM_RPC_URL on the monitoring worker, then retry this Watch.",
    });
  });

  it("turns provider throttling into a recoverable configuration error", async () => {
    const throttledRpc = createPublicClient({
      chain: mainnet,
      transport: custom({
        async request() {
          throw new Error("You reached Public endpoint rate limit");
        },
      }),
    });

    await expect(validatePools(throttledRpc, [])).rejects.toMatchObject({
      code: "RPC_RATE_LIMIT",
      message:
        "The Ethereum RPC rate-limited Scout during verification. Configure a dedicated Ethereum RPC endpoint on the monitoring worker, then retry this Watch.",
      retryAfterSeconds: 30,
    });
  });
});

const raw = () => ({
  routing: "CLASSIC",
  permitData: null,
  quote: {
    input: { token: intent.tokenIn, amount: "1000000000000000000" },
    output: { token: intent.tokenOut, amount: "3200000000", recipient: wallet },
    swapper: wallet,
    chainId: 1,
    tradeType: "EXACT_INPUT",
    slippage: 0.5,
    quoteId: "controlled-quote",
    route: [
      [
        {
          type: "v3-pool",
          address: POOLS[0].address,
          fee: 500,
          tokenIn: { address: intent.tokenIn, chainId: 1 },
          tokenOut: { address: intent.tokenOut, chainId: 1 },
        },
      ],
    ],
  },
});

describe("official Trading API boundary with controlled HTTP and RPC", () => {
  it("sends exact-input v3 intent and preserves missing metrics as unavailable", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(raw()));

    vi.stubGlobal("fetch", fetcher);

    const quote = await new UniswapAdapter("test-key", rpc).quote(
      intent,
      "test",
    );
    const body = JSON.parse(fetcher.mock.calls[0]?.[1].body);

    expect(body).toMatchObject({
      protocols: ["V3"],
      permitAmount: "EXACT",
      amount: "1000000000000000000",
      recipient: wallet,
    });
    expect(quote.review.minimumAmount).toBe("3184000000");
    expect(quote.review.priceImpact).toBeNull();
    expect(quote.review.gasUsd).toBeNull();
  });
  it.each(["DUTCH_V2", "DUTCH_V3", "PRIORITY", "WRAP"])(
    "rejects non-classic %s routing",
    async (routing) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ ...raw(), routing })),
      );
      await expect(
        new UniswapAdapter("test-key", rpc).quote(intent, "test"),
      ).rejects.toThrow();
    },
  );
  it("rejects altered recipient and unsupported pools", async () => {
    const response = raw();

    response.quote.output.recipient = ROUTERS[0];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
    await expect(
      new UniswapAdapter("test-key", rpc).quote(intent, "test"),
    ).rejects.toThrow("intent");

    const wrong = raw();

    wrong.quote.route[0]![0]!.fee = 999;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(wrong)));
    await expect(
      new UniswapAdapter("test-key", rpc).quote(intent, "test"),
    ).rejects.toThrow("supported pools");
  });
  it("narrows API unlimited approval to exact reviewed amount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(raw())));

    const adapter = new UniswapAdapter("test-key", rpc);
    const stored = await adapter.quote(intent, "test");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2, 2n ** 256n - 1n],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          approval: {
            to: intent.tokenIn,
            from: wallet,
            chainId: 1,
            value: "0",
            data,
          },
        }),
      ),
    );

    const result = await adapter.approval(stored);

    expect(result).not.toBeNull();

    const decoded = decodeFunctionData({ abi: erc20Abi, data: result!.data });

    expect(decoded.args?.[1]).toBe(10n ** 18n);
  });
  it("surfaces RPC simulation reverts without returning a transaction", async () => {
    const simulation = createPublicClient({
      chain: mainnet,
      transport: custom({
        async request({ method, params }) {
          if (
            method === "eth_call" &&
            JSON.stringify(params).toLowerCase().includes(ROUTERS[0].slice(2))
          ) {
            throw new Error(
              "execution reverted: controlled simulation failure",
            );
          }

          return encodeAbiParameters([{ type: "uint256" }], [10n ** 24n]);
        },
      }),
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(raw())));

    const adapter = new UniswapAdapter("test-key", simulation);
    const stored = await adapter.quote(intent, "test");
    const path = `${intent.tokenIn}0001f4${intent.tokenOut.slice(2)}`;
    const input = encodeAbiParameters(
      parseAbiParameters("address,uint256,uint256,bytes,bool"),
      [wallet, 10n ** 18n, 3184000000n, `0x${path.slice(2)}`, true],
    );
    const data = encodeFunctionData({
      abi: parseAbi([
        "function execute(bytes commands, bytes[] inputs,uint256 deadline) payable",
      ]),
      functionName: "execute",
      args: ["0x00", [input], BigInt(Math.floor(Date.now() / 1000) + 300)],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          swap: {
            to: ROUTERS[0],
            from: wallet,
            chainId: 1,
            value: "0",
            data,
          },
        }),
      ),
    );
    await expect(adapter.prepare(stored, null)).rejects.toThrow(
      /simulation failure/,
    );
  });
});
describe("Groq strict structured-output boundary", () => {
  it("resolves a controlled answer with Scout's schema", async () => {
    const output = {
      status: "READY",
      intent: {
        subject: {
          chain: {
            value: "ethereum",
            source: "explicit",
            confidence: 1,
          },
          protocol: {
            value: "uniswap",
            source: "explicit",
            confidence: 1,
          },
          protocolVersion: {
            value: "v3",
            source: "explicit",
            confidence: 1,
          },
          contracts: [
            { value: POOLS[0].address, source: "explicit", confidence: 1 },
          ],
          tokens: [
            { value: "ETH", source: "explicit", confidence: 1 },
            { value: "USDC", source: "explicit", confidence: 1 },
          ],
          wallets: [],
        },
        activity: {
          type: { value: "swap", source: "explicit", confidence: 1 },
          event: null,
          direction: { value: "buy", source: "explicit", confidence: 1 },
        },
        filters: [
          {
            field: "swapUsd",
            operator: "gt",
            value: 100_000,
            unit: "USD",
            source: "explicit",
          },
        ],
        temporal: {
          mode: { value: "continuous", source: "inferred", confidence: 1 },
          comparisonWindowSeconds: null,
          evaluationWindowSeconds: {
            value: 0,
            source: "inferred",
            confidence: 1,
          },
        },
        investigation: [],
        delivery: [],
        assumptions: [],
        unresolved: [],
      },
      clarification: null,
      unsupportedReason: null,
      supportedAlternative: null,
    };
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        id: "chatcmpl_controlled",
        object: "chat.completion",
        created: 1,
        model: "openai/gpt-oss-120b",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            logprobs: null,
            message: {
              role: "assistant",
              content: JSON.stringify(output),
            },
          },
        ],
      }),
    );

    vi.stubGlobal("fetch", fetcher);

    const result = await new GroqAdapter(
      "controlled-test",
      "openai/gpt-oss-120b",
    ).interpret(DEFAULT_PROMPT);

    expect(result.spec?.conditions).toEqual([
      { kind: "large_swap", usd: "100000" },
    ]);

    const body = JSON.parse(fetcher.mock.calls[0]?.[1].body);

    expect(fetcher.mock.calls[0]?.[0]).toContain(
      "api.groq.com/openai/v1/chat/completions",
    );
    expect(body).toMatchObject({
      model: "openai/gpt-oss-120b",
      reasoning_effort: "low",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "watch_intent_resolution",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
          },
        },
      },
    });
    expect(body.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(body.response_format.json_schema.schema.properties.status).toEqual({
      type: "string",
      enum: ["READY", "NEEDS_CLARIFICATION", "UNSUPPORTED"],
    });
  });

  it("rejects an answer that violates Scout's runtime schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Response.json({
          id: "chatcmpl_invalid",
          object: "chat.completion",
          created: 1,
          model: "openai/gpt-oss-120b",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              logprobs: null,
              message: {
                role: "assistant",
                content: JSON.stringify({ supported: "yes" }),
              },
            },
          ],
        }),
      ),
    );

    await expect(
      new GroqAdapter("controlled-test", "openai/gpt-oss-120b").interpret(
        DEFAULT_PROMPT,
      ),
    ).rejects.toMatchObject({
      code: "GROQ_RESPONSE_SCHEMA_MISMATCH",
      message: expect.stringContaining("status"),
    });
  });

  it("adds deterministic intent schema metadata after model validation", async () => {
    const output = {
      status: "READY",
      intent: {
        subject: {
          chain: {
            value: "ethereum",
            source: "explicit",
            confidence: 1,
          },
          protocol: {
            value: "uniswap",
            source: "explicit",
            confidence: 1,
          },
          protocolVersion: {
            value: "v3",
            source: "explicit",
            confidence: 1,
          },
          contracts: [],
          tokens: [
            { value: "ETH", source: "explicit", confidence: 1 },
            { value: "USDC", source: "explicit", confidence: 1 },
          ],
          wallets: [],
        },
        activity: {
          type: { value: "swap", source: "explicit", confidence: 1 },
          event: null,
          direction: { value: "buy", source: "explicit", confidence: 1 },
        },
        filters: [
          {
            field: "swapUsd",
            operator: "gt",
            value: 100_000,
            unit: "USD",
            source: "explicit",
          },
        ],
        temporal: {
          mode: { value: "continuous", source: "inferred", confidence: 1 },
          comparisonWindowSeconds: null,
          evaluationWindowSeconds: {
            value: 0,
            source: "inferred",
            confidence: 1,
          },
        },
        investigation: [],
        delivery: [],
        assumptions: [],
        unresolved: [],
      },
      clarification: null,
      unsupportedReason: null,
      supportedAlternative: null,
    };
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        id: "chatcmpl_intent",
        object: "chat.completion",
        created: 1,
        model: "openai/gpt-oss-120b",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            logprobs: null,
            message: { role: "assistant", content: JSON.stringify(output) },
          },
        ],
      }),
    );

    vi.stubGlobal("fetch", fetcher);

    const result = await new GroqAdapter(
      "controlled-test",
      "openai/gpt-oss-120b",
    ).resolveIntent("Watch Uniswap V3 ETH/USDC buys above $100K.");
    const body = JSON.parse(fetcher.mock.calls[0]?.[1].body);

    expect(result.intent.version).toBe(1);
    expect(result.intent.temporal.evaluationWindowSeconds).toBeNull();
    expect(
      body.response_format.json_schema.schema.properties.intent.properties,
    ).not.toHaveProperty("version");
  });

  it("preserves Groq rate-limit retry timing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { message: "Rate limit reached." } },
            { status: 429, headers: { "retry-after": "3" } },
          ),
        ),
    );

    await expect(
      new GroqAdapter("controlled-test", "openai/gpt-oss-120b").interpret(
        DEFAULT_PROMPT,
      ),
    ).rejects.toMatchObject({
      code: "HTTP_429",
      retryAfterSeconds: 3,
    });
  });

  it("identifies a rejected Groq credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { message: "Invalid API key." } },
            { status: 401 },
          ),
        ),
    );

    await expect(
      new GroqAdapter("invalid-key", "openai/gpt-oss-120b").interpret(
        DEFAULT_PROMPT,
      ),
    ).rejects.toMatchObject({
      code: "HTTP_401",
      message:
        "Groq rejected the configured GROQ_API_KEY. Replace it with an active key and retry this Watch.",
    });
  });
});
