import { z } from "zod";

export const WorkerEnv = z
  .object({
    SUBSTREAMS_SESSION_CAPACITY: z.coerce
      .number()
      .int()
      .min(2)
      .max(100)
      .default(2),
    BASE_RPC_URL: z.url().default("https://base-rpc.publicnode.com"),
    BASE_SUBSTREAMS_ENDPOINT: z
      .url()
      .default("https://base-mainnet.streamingfast.io:443"),
    DATABASE_URL: z.url(),
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    ETHEREUM_RPC_URL: z.url(),
    GRAPH_API_KEY: z.string().min(5),
    GRAPH_SUBGRAPH_ID: z.string().optional(),
    SUBSTREAMS_ENDPOINT: z
      .url()
      .default("https://mainnet.eth.streamingfast.io:443"),
    SUBSTREAMS_API_KEY: z.string().optional(),
    SUBSTREAMS_API_TOKEN: z.string().optional(),
    SUBSTREAMS_BIN: z.string().default("substreams"),
    SUBSTREAMS_TEMPLATE_DIR: z.string().default("../../substreams"),
    GROQ_API_KEY: z.string().optional(),
    GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
    RESEND_API_KEY: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().optional(),
    EMAIL_LINK_SECRET: z.string().min(32).optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    SCOUT_SITE_URL: z.url(),
    PORT: z.coerce.number().int().default(8080),
  })
  .refine(
    (value) => !!value.SUBSTREAMS_API_KEY || !!value.SUBSTREAMS_API_TOKEN,
    "Set a Substreams data-plane key or token.",
  );

export type WorkerConfig = z.infer<typeof WorkerEnv>;
