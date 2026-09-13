import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { connectDatabase } from "@scout/database";
import { SnapshotSchema } from "@scout/domain";

import { cleanupTestAccount } from "../database/account-fixture";
import { cleanupTestJobs } from "../database/cleanup";

import { testJwt, testKeys } from "./tokens";

import type { Database } from "@scout/database/types";

// Real HTTP routes + the installed Privy cryptographic verifier + local
// Supabase. Ephemeral test signing keys never leave this child process and
// are never accepted by the normal Scout server or by Privy's live service.
const { stdout } = await promisify(execFile)(
  "pnpm",
  ["exec", "supabase", "status", "-o", "json"],
  { timeout: 30_000 },
);
const env = z
  .object({
    API_URL: z.url(),
    DB_URL: z.url(),
    ANON_KEY: z.string(),
    SERVICE_ROLE_KEY: z.string(),
  })
  .parse(JSON.parse(stdout));

assert.equal(new URL(env.API_URL).hostname, "127.0.0.1");
assert.equal(new URL(env.DB_URL).hostname, "127.0.0.1");

const service = createClient<Database>(env.API_URL, env.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sql = connectDatabase(env.DB_URL, 2);
const accounts = new Set<string>();
const supabaseUsers = new Set<string>();
const listener = createServer();

listener.listen(0, "127.0.0.1");
await once(listener, "listening");

const address = listener.address();

assert(address && typeof address !== "string");

const port = address.port;

await new Promise<void>((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);

const origin = `http://127.0.0.1:${port}`;
const appId = "scout-auth-isolated-test";
const keys = testKeys();
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: "apps/web",
    env: {
      ...process.env,
      SCOUT_DIST_DIR: ".next/auth-tests",
      SCOUT_SITE_URL: origin,
      NEXT_PUBLIC_PRIVY_APP_ID: appId,
      PRIVY_APP_SECRET: "isolated-test-no-provider-access",
      PRIVY_VERIFICATION_KEY: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      NEXT_PUBLIC_SUPABASE_URL: env.API_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SERVICE_ROLE_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";

child.stdout.on("data", (x) => {
  logs = (logs + x).slice(-12_000);
});
child.stderr.on("data", (x) => {
  logs = (logs + x).slice(-12_000);
});

let checks = 0;

const check = (name: string) => {
  checks++;
  console.log(`PASS ${name}`);
};

const now = () => Math.floor(Date.now() / 1000);

function credentials(email: string | null, google = false) {
  const subject = `did:privy:test-${randomUUID()}`;
  const sid = randomUUID();
  const claims = {
    iss: "privy.io",
    aud: appId,
    sub: subject,
    sid,
    iat: now(),
    exp: now() + 3600,
  };

  return {
    subject,
    sid,
    claims,
    token: testJwt(keys.privateKey, claims),
    identityToken: testJwt(keys.privateKey, {
      iss: "privy.io",
      aud: appId,
      sub: subject,
      iat: now(),
      exp: now() + 3600,
      cr: String(now()),
      linked_accounts: JSON.stringify(
        email
          ? [
              google
                ? {
                    type: "google_oauth",
                    email,
                    subject: randomUUID(),
                    lv: now(),
                  }
                : { type: "email", address: email, lv: now() },
            ]
          : [],
      ),
    }),
  };
}

type Credentials = ReturnType<typeof credentials>;

async function call(
  path: string,
  token?: string,
  method = "GET",
  payload?: unknown,
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const value: unknown = await response.json();

  return { response, value };
}

async function login(c: Credentials) {
  const result = await call("/api/auth/session", c.token, "POST", {
    identityToken: c.identityToken,
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.value));

  const account = z
    .object({ userId: z.uuid(), email: z.string().nullable() })
    .parse(result.value);

  accounts.add(account.userId);

  return account;
}

async function supabaseIdentity() {
  const email = `scout-privy-${randomUUID()}@example.invalid`;
  const password = randomUUID();
  const result = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (result.error) {
    throw result.error;
  }

  const id = result.data.user.id;

  supabaseUsers.add(id);

  const client = createClient<Database>(env.API_URL, env.ANON_KEY, {
    auth: { persistSession: false },
  });
  const signed = await client.auth.signInWithPassword({ email, password });

  if (signed.error) {
    throw signed.error;
  }

  return { email, id, client, token: signed.data.session.access_token };
}

try {
  let up = false;

  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) {
      throw new Error(`Isolated Next server exited: ${logs}`);
    }

    try {
      const r = await fetch(origin + "/api/state", {
        signal: AbortSignal.timeout(1000),
      });

      if (r.status === 401) {
        up = true;
        break;
      }
    } catch {
      /* Wait for local compilation. */
    }

    await delay(500);
  }

  assert(up, `Isolated auth server did not start: ${logs}`);

  for (const path of [
    "/api/state",
    "/api/watches",
    "/api/connections",
    "/api/trades",
  ]) {
    assert.equal((await call(path)).response.status, 401);
  }

  check("protected operations reject anonymous requests");

  const supabaseUser = await supabaseIdentity();
  const alice = credentials(supabaseUser.email);
  const bob = credentials(supabaseUser.email, true);
  const wallet = credentials(null);

  for (const token of [
    "not-a-jwt",
    supabaseUser.token,
    testJwt(keys.privateKey, { ...alice.claims, exp: now() - 1 }),
    testJwt(keys.privateKey, { ...alice.claims, aud: "wrong-app" }),
    testJwt(keys.privateKey, { ...alice.claims, iss: "wrong-issuer" }),
    testJwt(testKeys().privateKey, alice.claims),
    alice.identityToken,
    testJwt(keys.privateKey, { ...alice.claims, iat: now() + 3600 }),
  ]) {
    assert.equal((await call("/api/state", token)).response.status, 401);
  }

  check(
    "Privy verifier rejects malformed, Supabase, expired, foreign, tampered and identity tokens",
  );

  const aliceAccount = await login(alice);
  const bobAccount = await login(bob);
  const walletAccount = await login(wallet);

  assert.notEqual(aliceAccount.userId, supabaseUser.id);
  assert.notEqual(aliceAccount.userId, bobAccount.userId);
  assert.equal(walletAccount.email, null);
  assert.equal(aliceAccount.email, supabaseUser.email);
  assert.equal(bobAccount.email, supabaseUser.email);
  check(
    "email, Google identity and wallet accounts provision separately; matching email never merges ownership",
  );

  const mixed = await call("/api/auth/session", alice.token, "POST", {
    identityToken: bob.identityToken,
  });

  assert.equal(mixed.response.status, 401);
  check("identity data must match the verified access-token subject");

  const state = SnapshotSchema.parse(
    (await call("/api/state", alice.token)).value,
  );

  assert.equal(state.emailConnection.enabled, false);
  assert.equal(state.telegram.connected, false);
  assert.equal(state.watches.length, 0);
  check(
    "login does not create a watch, wallet, notification consent or paired destination",
  );

  const created = await call("/api/watches", alice.token, "POST", {
    prompt:
      "Watch Uniswap V3 ETH/USDC swaps above $100k from newly active wallets.",
  });

  assert.equal(created.response.status, 200, JSON.stringify(created.value));

  const wid = z.object({ id: z.uuid() }).parse(created.value).id;

  assert.equal(
    (await call(`/api/watches?id=${wid}`, alice.token)).response.status,
    200,
  );
  assert.equal(
    (await call(`/api/watches?id=${wid}`, bob.token)).response.status,
    404,
  );
  assert((await supabaseUser.client.rpc("scout_snapshot")).error);
  assert((await supabaseUser.client.from("watches").select("id")).error);
  assert(
    (
      await supabaseUser.client.rpc("scout_authenticate", {
        privy_subject: alice.subject,
        privy_session: alice.sid,
        token_expires: new Date(Date.now() + 3600_000).toISOString(),
        provision: true,
      })
    ).error,
  );
  assert(
    (
      await supabaseUser.client.rpc("scout_account_rpc", {
        privy_subject: alice.subject,
        privy_session: alice.sid,
        operation: "scout_snapshot",
      })
    ).error,
  );
  check(
    "Supabase tokens and direct Data API calls cannot bypass Privy, ownership, or the account gateway",
  );

  const change = await call("/api/watches", bob.token, "PATCH", {
    id: wid,
    action: "archive",
  });

  assert.notEqual(change.response.status, 200);

  const injection = await service.rpc("scout_account_rpc", {
    privy_subject: bob.subject,
    privy_session: bob.sid,
    operation: "scout_email_begin",
    args: { owner_id: aliceAccount.userId },
  });

  assert(injection.error);
  assert(
    (
      await service.rpc("scout_account_rpc", {
        privy_subject: bob.subject,
        privy_session: alice.sid,
        operation: "scout_snapshot",
      })
    ).error,
  );
  check(
    "cross-user mutations, session substitution and non-allowlisted gateway operations fail",
  );

  const csrf = await fetch(origin + "/api/auth/session", {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${alice.token}`,
      origin: "https://attacker.invalid",
    },
  });

  assert.equal(csrf.status, 403);
  assert.equal(
    (await call("/api/auth/session", alice.token, "DELETE")).response.status,
    200,
  );
  assert.equal((await call("/api/state", alice.token)).response.status, 401);
  assert.equal(
    (
      await call(
        "/api/state",
        testJwt(keys.privateKey, {
          ...alice.claims,
          iat: now(),
          exp: now() + 7200,
        }),
      )
    ).response.status,
    401,
  );

  const nextSession = {
    ...alice,
    claims: { ...alice.claims, sid: randomUUID() },
  };

  nextSession.token = testJwt(keys.privateKey, nextSession.claims);
  assert.equal((await login(nextSession)).userId, aliceAccount.userId);
  assert.equal(
    (await call(`/api/watches?id=${wid}`, nextSession.token)).response.status,
    200,
  );
  check(
    "logout is origin-checked and durable across token refresh; a new session restores existing ownership",
  );

  const watch =
    await sql`select user_id,status from public.watches where id=${wid}`;

  assert.equal(watch[0]?.user_id, aliceAccount.userId);
  assert.equal(watch[0]?.status, "received");
  check(
    "authentication and logout do not alter monitoring lifecycle or delete user data",
  );
  console.log(
    `${checks} local authentication/security checks passed. Tokens were signed by ephemeral test keys; no live Privy login or external email was claimed.`,
  );
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5000)]);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }

  for (const id of accounts) {
    await cleanupTestJobs(sql, id);
    await cleanupTestAccount(sql, id);
  }

  for (const id of supabaseUsers) {
    await service.auth.admin.deleteUser(id);
  }

  await sql.end({ timeout: 5 });
}
