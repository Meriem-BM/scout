import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { connectDatabase, loadDeployment } from "@scout/database";
import { DEFAULT_PROMPT, defaultSpec, SnapshotSchema } from "@scout/domain";
import { emailTemplate } from "@scout/integrations/email";
import { ethereum } from "@scout/integrations/ethereum";

import { WorkerEnv } from "../../apps/worker/src/config";
import { persistBlock } from "../../apps/worker/src/ingestion/persist";
import { deliverEmail } from "../../apps/worker/src/jobs/email";
import { handleJob } from "../../apps/worker/src/jobs/handlers";
import { fixtureEvents } from "../fixtures/swap-events";

import { accountFixture, cleanupTestAccount } from "./account-fixture";
import { cleanupTestJobs } from "./cleanup";

import type { Database } from "@scout/database/types";

const { stdout } = await promisify(execFile)("pnpm", [
  "exec",
  "supabase",
  "status",
  "-o",
  "json",
]);
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
  auth: { persistSession: false },
});
const sql = connectDatabase(env.DB_URL);
const ids: string[] = [];
const providerPrefix = `scout-test-${randomUUID()}-`;
const addresses: string[] = [];
const originalFetch = globalThis.fetch;
let checks = 0;

const check = (name: string) => {
  checks++;
  console.log(`PASS ${name}`);
};

async function user() {
  const email = `scout-delivery-${randomUUID()}@example.invalid`;
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

  ids.push(id);

  const client = createClient<Database>(env.API_URL, env.ANON_KEY, {
    auth: { persistSession: false },
  });
  const login = await client.auth.signInWithPassword({ email, password });

  if (login.error) {
    throw login.error;
  }

  return { id, email, client: await accountFixture(sql, service, client, id) };
}

function ok(result: { error: unknown }) {
  if (result.error) {
    throw result.error;
  }
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const config = WorkerEnv.parse({
  DATABASE_URL: env.DB_URL,
  SUPABASE_URL: env.API_URL,
  SUPABASE_SERVICE_ROLE_KEY: env.SERVICE_ROLE_KEY,
  ETHEREUM_RPC_URL: "http://127.0.0.1:1",
  GRAPH_API_KEY: "controlled",
  SUBSTREAMS_API_TOKEN: "controlled",
  RESEND_API_KEY: "controlled-test-only",
  RESEND_FROM_EMAIL: "Scout <test@example.invalid>",
  EMAIL_LINK_SECRET: "controlled-link-secret-at-least-32-characters",
  SCOUT_SITE_URL: "https://scout.test",
});
const job = (id: string, attempts = 1) => ({
  id: randomUUID(),
  kind: "email" as const,
  payload: { deliveryId: id },
  attempts,
  max_attempts: 5,
});

try {
  const alice = await user();
  const bob = await user();

  assert(
    (
      await alice.client.rpc("scout_email_begin", {
        owner_id: alice.id,
        destination: alice.email,
        token_hash: hash("x"),
        mail_payload: {},
        use_account: true,
      })
    ).error,
  );
  ok(
    await service.rpc("scout_email_begin", {
      owner_id: alice.id,
      destination: alice.email,
      token_hash: hash("x"),
      mail_payload: {},
      use_account: true,
    }),
  );

  let state = SnapshotSchema.parse(
    (await alice.client.rpc("scout_snapshot")).data,
  );

  assert.equal(state.emailConnection.verified, true);
  assert.equal(state.emailConnection.enabled, true);
  assert(
    (
      await service.rpc("scout_email_begin", {
        owner_id: bob.id,
        destination: alice.email,
        token_hash: hash("x"),
        mail_payload: {},
        use_account: true,
      })
    ).error,
  );
  check(
    "only server-authorized opt-in can reuse the authenticated owner’s verified email",
  );

  const tokenHash = hash(randomUUID());
  const replacement = `replacement-${randomUUID()}@example.invalid`;

  addresses.push(replacement);
  ok(
    await service.rpc("scout_email_begin", {
      owner_id: alice.id,
      destination: replacement,
      token_hash: tokenHash,
      mail_payload: emailTemplate(
        "Verify",
        [],
        "https://scout.test/email/verify#secret",
        "Verify",
      ),
    }),
  );
  state = SnapshotSchema.parse((await alice.client.rpc("scout_snapshot")).data);
  assert.equal(state.emailConnection.address, alice.email);
  assert.equal(state.emailConnection.pendingAddress, replacement);
  assert(
    (await bob.client.rpc("scout_email_verify", { token_hash: tokenHash }))
      .error,
  );

  const verification = (
    await sql`select * from app_private.email_outbox where user_id=${alice.id} and kind='verification'`
  )[0]!;
  let sends = 0;
  let mode = "accept";
  let early = false;
  let lastBody = "";

  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url.includes("gateway.thegraph.com")) {
      throw new Error("Controlled Graph unavailability");
    }

    if (url !== "https://api.resend.com/emails") {
      return originalFetch(input, init);
    }

    sends++;
    lastBody = String(init?.body);
    assert.equal(
      new Headers(init?.headers)
        .get("Idempotency-Key")
        ?.startsWith("scout-email/"),
      true,
    );

    if (mode === "network") {
      throw new Error("Controlled interruption");
    }

    const provider = providerPrefix + sends;

    if (early) {
      ok(
        await service.rpc("scout_email_event", {
          event_id: "event-early-" + provider,
          provider,
          event_type: "email.delivered",
          occurred_at: new Date().toISOString(),
        }),
      );
    }

    return new Response(JSON.stringify({ id: provider }));
  };

  await deliverEmail(sql, job(verification.id), config);
  await deliverEmail(sql, job(verification.id), config);
  assert.equal(sends, 1);
  assert.equal(
    (
      await sql`select payload from app_private.email_outbox where id=${verification.id}`
    )[0]!.payload,
    null,
  );
  await sql`update app_private.email_verifications set expires_at=now()-interval '1 minute' where user_id=${alice.id}`;
  assert(
    (await alice.client.rpc("scout_email_verify", { token_hash: tokenHash }))
      .error,
  );

  const freshHash = hash(randomUUID());

  ok(
    await service.rpc("scout_email_begin", {
      owner_id: alice.id,
      destination: replacement,
      token_hash: freshHash,
      mail_payload: emailTemplate(
        "Verify",
        [],
        "https://scout.test/email/verify#new",
        "Verify",
      ),
    }),
  );
  ok(await alice.client.rpc("scout_email_verify", { token_hash: freshHash }));
  assert(
    (await alice.client.rpc("scout_email_verify", { token_hash: freshHash }))
      .error,
  );
  check(
    "verification is owner-bound, expiring, single-use; old destination survives until replacement verification",
  );
  ok(
    await alice.client.rpc("scout_preferences", {
      preferences: {
        timezone: "Africa/Casablanca",
        email: true,
        telegram: true,
        cooldownSeconds: 300,
      },
    }),
  );
  await sql`insert into app_private.telegram_connections(user_id,chat_id,telegram_user_id) values(${alice.id},${"chat-" + alice.id},${"tg-" + alice.id})`;

  const spec = { ...defaultSpec(), cooldownSeconds: 300 };
  const draft = await alice.client.rpc("scout_save_watch_v2", {
    watch_spec: z.json().parse(spec),
    original_prompt: DEFAULT_PROMPT,
    save_draft: true,
  });

  ok(draft);

  const wid = z.uuid().parse(draft.data);

  assert.equal(
    (await sql`select * from public.pipeline_deployments where watch_id=${wid}`)
      .length,
    0,
  );
  state = SnapshotSchema.parse((await alice.client.rpc("scout_snapshot")).data);
  assert.equal(state.watches[0]?.status, "draft");
  assert.equal(state.preferences.timezone, "Africa/Casablanca");

  const activated = await alice.client.rpc("scout_save_watch_v2", {
    watch_spec: z.json().parse(spec),
    original_prompt: DEFAULT_PROMPT,
    existing_id: wid,
    save_draft: false,
  });

  ok(activated);

  const dep = await loadDeployment(
    sql,
    (
      await sql`select id from public.pipeline_deployments where watch_id=${wid}`
    )[0]!.id,
  );

  assert.equal(dep.spec.notifications.email, true);

  const owner = randomUUID();

  await sql`insert into app_private.pipeline_leases(deployment_id,owner,expires_at) values(${dep.id},${owner},now()+interval '2 minutes')`;

  for (const e of fixtureEvents().slice(0, 3)) {
    await persistBlock(
      sql,
      dep,
      owner,
      {
        type: "block",
        cursor: "fixture-" + e.blockNumber,
        number: e.blockNumber,
        hash: e.blockHash,
        timestamp: e.timestamp,
        swaps: [],
      },
      [e],
      true,
    );
  }

  const incident = (
    await sql`select * from public.incidents where watch_id=${wid}`
  )[0]!;

  assert(incident);
  await handleJob(
    {
      id: randomUUID(),
      kind: "enrich",
      payload: { incidentId: incident.id },
      attempts: 1,
      max_attempts: 5,
    },
    sql,
    service,
    ethereum(config.ETHEREUM_RPC_URL),
    config,
    new AbortController().signal,
  );

  const deliveries =
    await sql`select * from public.notification_deliveries where incident_id=${incident.id}`;

  assert.equal(deliveries.length, 2);
  assert(deliveries.some((d) => d.channel === "telegram"));
  assert(deliveries.some((d) => d.channel === "email"));
  assert(
    incident.group_key.endsWith(
      String(Math.floor(fixtureEvents()[2]!.timestamp / 300)),
    ),
  );
  check(
    "draft activation creates real durable jobs and detection queues distinct Telegram/email outboxes using reviewed grouping",
  );
  assert.equal(
    (await bob.client.rpc("scout_watch_detail", { watch_id: wid })).data,
    null,
  );
  assert.equal(
    (await bob.client.rpc("scout_incident", { incident_id: incident.id })).data,
    null,
  );
  assert.deepEqual(
    (
      await bob.client.rpc("scout_delivery_history", {
        incident_id: incident.id,
      })
    ).data,
    [],
  );

  const full = (
    await alice.client.rpc("scout_incident", { incident_id: incident.id })
  ).data as { evidence: unknown[] };

  assert.equal(full.evidence.length, 3);
  check(
    "watch details, evidence and per-destination delivery history deny cross-account access",
  );

  const emailDelivery = deliveries.find((d) => d.channel === "email")!;

  mode = "network";
  await assert.rejects(deliverEmail(sql, job(emailDelivery.id), config));
  assert.equal(
    (
      await sql`select status from public.notification_deliveries where id=${emailDelivery.id}`
    )[0]!.status,
    "queued",
  );
  mode = "accept";
  early = true;
  await deliverEmail(sql, job(emailDelivery.id, 2), config);
  early = false;
  assert.match(lastBody, /watches\/.*\/incidents\//);
  assert.match(lastBody, /Disable alerts to this email/);

  const delivered = (
    await sql`select * from public.notification_deliveries where id=${emailDelivery.id}`
  )[0]!;

  assert.equal(delivered.status, "delivered");

  const before = sends;

  await sql`update app_private.email_outbox set first_attempt_at=now()-interval '2 days' where id=${emailDelivery.id}`;
  await deliverEmail(sql, job(emailDelivery.id, 3), config);
  assert.equal(sends, before);
  check(
    "email retries preserve the same identity and reconcile webhooks arriving before API response; accepted sends never repeat beyond provider retention",
  );

  for (const type of ["email.delivery_delayed", "email.sent"]) {
    ok(
      await service.rpc("scout_email_event", {
        event_id: randomUUID(),
        provider: delivered.provider_id,
        event_type: type,
        occurred_at: new Date().toISOString(),
      }),
    );
  }

  assert.equal(
    (
      await sql`select status from public.notification_deliveries where id=${emailDelivery.id}`
    )[0]!.status,
    "delivered",
  );

  const eid = randomUUID();

  for (let n = 0; n < 2; n++) {
    ok(
      await service.rpc("scout_email_event", {
        event_id: eid,
        provider: delivered.provider_id,
        event_type: "email.complained",
        occurred_at: new Date().toISOString(),
      }),
    );
  }

  ok(
    await service.rpc("scout_email_event", {
      event_id: randomUUID(),
      provider: delivered.provider_id,
      event_type: "email.delivered",
      occurred_at: new Date().toISOString(),
    }),
  );
  assert.equal(
    (await sql`select * from app_private.email_webhook_events where id=${eid}`)
      .length,
    1,
  );
  state = SnapshotSchema.parse((await alice.client.rpc("scout_snapshot")).data);
  assert.equal(state.emailConnection.suppressed, true);
  assert.equal(state.emailConnection.enabled, false);
  assert(
    (await alice.client.rpc("scout_email_action", { action: "enable" })).error,
  );
  check(
    "out-of-order events cannot regress delivery; complaints are idempotent, sticky and suppress future alerts",
  );

  const newAddress = `fresh-${randomUUID()}@example.invalid`;
  const newHash = hash(randomUUID());

  ok(
    await service.rpc("scout_email_begin", {
      owner_id: alice.id,
      destination: newAddress,
      token_hash: newHash,
      mail_payload: emailTemplate(
        "Verify",
        [],
        "https://scout.test/email/verify#fresh",
        "Verify",
      ),
    }),
  );
  ok(await alice.client.rpc("scout_email_verify", { token_hash: newHash }));

  const c = (
    await sql`select * from app_private.email_connections where user_id=${alice.id}`
  )[0]!;
  const old = (
    await sql`select app_private.queue_email(${alice.id},'test',${newAddress},null,${"old-" + randomUUID()},${c.id}) id`
  )[0]!.id;

  await sql`update app_private.email_outbox set first_attempt_at=now()-interval '25 hours' where id=${old}`;

  const beforeOld = sends;

  await deliverEmail(sql, job(old), config);
  assert.equal(sends, beforeOld);
  assert.equal(
    (
      await sql`select status from public.notification_deliveries where id=${old}`
    )[0]!.status,
    "ambiguous",
  );

  const queued = (
    await sql`select app_private.queue_email(${alice.id},'test',${newAddress},null,${"disconnect-" + randomUUID()},${c.id}) id`
  )[0]!.id;

  ok(await alice.client.rpc("scout_email_action", { action: "disconnect" }));
  await deliverEmail(sql, job(queued), config);
  assert.equal(sends, beforeOld);
  assert.equal(
    (
      await sql`select status from public.notification_deliveries where id=${queued}`
    )[0]!.status,
    "suppressed",
  );
  check(
    "expired uncertain sends are never blindly retried; disconnect cancels queued work instead of redirecting it",
  );
  ok(
    await alice.client.rpc("scout_watch_action", {
      watch_id: wid,
      action: "archive",
    }),
  );
  ok(
    await alice.client.rpc("scout_watch_action", {
      watch_id: wid,
      action: "restore",
    }),
  );
  assert.equal(
    (await sql`select status from public.watches where id=${wid}`)[0]!.status,
    "paused",
  );
  assert.equal(
    (await sql`select * from public.incidents where watch_id=${wid}`).length,
    1,
  );
  check(
    "archive and restore preserve incident and delivery history without automatically resuming",
  );
  console.log(
    `${checks} new connection and email database checks passed. All provider responses were controlled; no external email was sent.`,
  );
} finally {
  globalThis.fetch = originalFetch;

  for (const id of ids) {
    await cleanupTestJobs(sql, id);
    await cleanupTestAccount(sql, id);
  }

  await sql`delete from app_private.email_webhook_events where provider_id like ${providerPrefix + "%"}`;

  for (const address of addresses) {
    await sql`delete from app_private.email_suppressions where address=${address}`;
  }

  for (const id of ids) {
    await service.auth.admin.deleteUser(id);
  }

  await sql.end();
}
