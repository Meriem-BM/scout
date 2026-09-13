import { execFile } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { z } from "zod";

const WEB_ENV_PATH = "apps/web/.env.local";
const WORKER_ENV_PATH = "apps/worker/.env";

const SHARED_PROVIDER_KEYS = [
  "EMAIL_LINK_SECRET",
  "ETHEREUM_RPC_URL",
  "GRAPH_API_KEY",
  "GRAPH_SUBGRAPH_ID",
  "GROQ_API_KEY",
  "GROQ_MODEL",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "TELEGRAM_BOT_TOKEN",
] as const;

async function readEnvFile(path: string) {
  try {
    return { content: await readFile(path, "utf8"), created: false };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { content: "", created: true };
    }

    throw error;
  }
}

function parseEnv(content: string) {
  const values = new Map<string, string>();

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    const key = match?.[1];
    const value = match?.[2];

    if (key !== undefined && value !== undefined) {
      values.set(key, value);
    }
  }

  return values;
}

async function mergeEnvFile(path: string, values: ReadonlyMap<string, string>) {
  const { content, created } = await readEnvFile(path);
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/).flatMap((line) => {
    const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];

    if (!key || !values.has(key)) {
      return [line];
    }

    if (seen.has(key)) {
      return [];
    }

    seen.add(key);

    return [`${key}=${values.get(key)}`];
  });

  while (lines.at(-1) === "") {
    lines.pop();
  }

  const missing = [...values].filter(([key]) => !seen.has(key));

  if (missing.length > 0 && lines.length > 0) {
    lines.push("");
  }

  lines.push(...missing.map(([key, value]) => `${key}=${value}`), "");

  await writeFile(path, lines.join("\n"), { mode: 0o600 });
  await chmod(path, 0o600);

  return created;
}

const { stdout } = await promisify(execFile)(
  "pnpm",
  ["exec", "supabase", "status", "-o", "json"],
  { maxBuffer: 1_000_000 },
);
const status = z
  .object({
    API_URL: z.string().url(),
    SERVICE_ROLE_KEY: z.string(),
    DB_URL: z.string().url(),
  })
  .parse(JSON.parse(stdout));
const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .parse(process.env.SCOUT_LOCAL_PORT ?? 3000);
const siteUrl = `http://localhost:${port}`;

const webValues = new Map([
  ["NEXT_PUBLIC_SUPABASE_URL", status.API_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY],
  ["SCOUT_SITE_URL", siteUrl],
]);
const webCreated = await mergeEnvFile(WEB_ENV_PATH, webValues);
const webEnv = parseEnv((await readEnvFile(WEB_ENV_PATH)).content);
const workerExisting = parseEnv((await readEnvFile(WORKER_ENV_PATH)).content);
const workerValues = new Map([
  ["DATABASE_URL", status.DB_URL],
  ["SUPABASE_URL", status.API_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY],
  ["SCOUT_SITE_URL", siteUrl],
]);

for (const key of SHARED_PROVIDER_KEYS) {
  const webValue = webEnv.get(key);

  if (!workerExisting.get(key) && webValue) {
    workerValues.set(key, webValue);
  }
}

const workerDefaults = new Map([
  ["SUBSTREAMS_ENDPOINT", "https://mainnet.eth.streamingfast.io:443"],
  ["SUBSTREAMS_BIN", "substreams"],
  ["SUBSTREAMS_TEMPLATE_DIR", "../../substreams"],
  ["GROQ_MODEL", "openai/gpt-oss-120b"],
  ["PORT", "8080"],
]);

for (const [key, value] of workerDefaults) {
  if (!workerExisting.get(key)) {
    workerValues.set(key, value);
  }
}

const workerCreated = await mergeEnvFile(WORKER_ENV_PATH, workerValues);

console.log(
  `${webCreated ? "Created" : "Updated"} ignored ${WEB_ENV_PATH} and ${
    workerCreated ? "created" : "updated"
  } ignored ${WORKER_ENV_PATH} with local Supabase settings. Existing provider credentials were preserved.`,
);
