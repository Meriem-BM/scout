import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { z } from "zod";

import { connectDatabase } from "@scout/database";

const exec = promisify(execFile);
const { stdout } = await exec("pnpm", [
  "exec",
  "supabase",
  "status",
  "-o",
  "json",
]);
const status = z
  .object({ API_URL: z.url(), DB_URL: z.url(), SERVICE_ROLE_KEY: z.string() })
  .parse(JSON.parse(stdout));

assert(
  ["127.0.0.1", "localhost"].includes(new URL(status.DB_URL).hostname),
  "Local test database only",
);

const sql = connectDatabase(status.DB_URL);

try {
  assert.equal(
    Number((await sql`select count(*) n from public.watches`)[0]?.n),
    0,
    "Container check requires an empty disposable database",
  );
} finally {
  await sql.end();
}

const name = `scout-container-test-${randomUUID()}`;
const image = "scout-worker:0.1.0";
const env = {
  DATABASE_URL: status.DB_URL.replace(
    "127.0.0.1",
    "host.docker.internal",
  ).replace("localhost", "host.docker.internal"),
  SUPABASE_URL: status.API_URL.replace(
    "127.0.0.1",
    "host.docker.internal",
  ).replace("localhost", "host.docker.internal"),
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  ETHEREUM_RPC_URL: "http://127.0.0.1:19999",
  GRAPH_API_KEY: "controlled-no-live",
  SUBSTREAMS_API_TOKEN: "controlled-no-live",
  SCOUT_SITE_URL: "http://localhost:3000",
};

try {
  await exec("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    "127.0.0.1:18082:8080",
    ...Object.entries(env).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    image,
  ]);

  let ready = false;

  for (let i = 0; i < 80; i++) {
    try {
      ready = (
        await fetch("http://127.0.0.1:18082/health/ready", {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      /* Bounded startup polling. */
    }

    if (ready) {
      break;
    }

    await delay(250);
  }

  assert(ready, "Container readiness within 20 seconds");

  const packed = await exec(
    "docker",
    [
      "exec",
      name,
      "/app/apps/worker/node_modules/.bin/tsx",
      "-e",
      "import {packPipeline} from '/app/apps/worker/src/pipeline/generate.ts'; import {defaultSpec} from '/app/packages/domain/src/index.ts'; packPipeline(defaultSpec(),'/app/substreams','/tmp/scout-container-package','/usr/local/bin/substreams').then(p=>console.log(p.packageSha256));",
    ],
    { timeout: 100_000 },
  );

  assert.match(packed.stdout.trim(), /^[a-f0-9]{64}$/);
  console.log(`PASS Linux container package build: ${packed.stdout.trim()}`);
  await exec("docker", ["stop", "--time", "20", name]);

  const result = await exec("docker", [
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    name,
  ]);

  assert.equal(result.stdout.trim(), "0");
  console.log(
    "PASS non-root Docker worker readiness and SIGTERM drain. No provider connection or delivery was attempted.",
  );
} catch (error) {
  const logs = await exec("docker", ["logs", "--tail", "20", name]).catch(
    () => ({ stdout: "", stderr: "" }),
  );
  let safe = logs.stdout + logs.stderr;

  for (const value of Object.values(env)) {
    safe = safe.replaceAll(value, "[redacted]");
  }

  console.error(safe);

  throw error;
} finally {
  await exec("docker", ["rm", "--force", name]).catch((error: unknown) => {
    console.error(
      "Could not remove disposable test container",
      error instanceof Error ? error.name : "unknown",
    );
  });
}
