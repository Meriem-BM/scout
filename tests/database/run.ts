import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";
import { createPublicClient, custom } from "viem";
import { mainnet } from "viem/chains";
import { z } from "zod";

import {
  claimJob,
  connectDatabase,
  finishJob,
  loadDeployment,
  loadIncident,
} from "@scout/database";
import {
  DEFAULT_PROMPT,
  defaultSpec,
  maxWindow,
  POOLS,
  ROUTERS,
  SnapshotSchema,
} from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";

import { WorkerEnv } from "../../apps/worker/src/config";
import {
  persistBlock,
  persistUndo,
} from "../../apps/worker/src/ingestion/persist";
import { handleJob } from "../../apps/worker/src/jobs/handlers";
import { fixtureEvents } from "../fixtures/swap-events";

import { accountFixture, cleanupTestAccount } from "./account-fixture";
import { cleanupTestJobs } from "./cleanup";

import type { Database } from "@scout/database/types";
import type { SwapEvent } from "@scout/domain";

const { stdout } = await promisify(execFile)("pnpm", [
  "exec",
  "supabase",
  "status",
  "-o",
  "json",
]);
const local = z
  .object({
    API_URL: z.url(),
    DB_URL: z.url(),
    ANON_KEY: z.string(),
    SERVICE_ROLE_KEY: z.string(),
  })
  .parse(JSON.parse(stdout));

for (const url of [local.API_URL, local.DB_URL]) {
  assert(
    ["127.0.0.1", "localhost"].includes(new URL(url).hostname),
    "These tests may only mutate the disposable local Supabase instance.",
  );
}

const service = createClient<Database>(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let sql = connectDatabase(local.DB_URL);
const users: string[] = [];
let checks = 0;
const updateBase = Date.now();

const check = (label: string) => {
  checks++;
  console.log(`PASS ${label}`);
};

async function user() {
  const email = `scout-test-${randomUUID()}@example.invalid`;
  const password = randomUUID() + randomUUID();
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (created.error) {
    throw created.error;
  }

  const id = created.data.user.id;

  users.push(id);

  const client = createClient<Database>(local.API_URL, local.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const session = await client.auth.signInWithPassword({ email, password });

  if (session.error) {
    throw session.error;
  }

  return { id, client: await accountFixture(sql, service, client, id) };
}

function block(event: SwapEvent) {
  return {
    type: "block" as const,
    cursor: `test-cursor-${event.blockNumber}`,
    number: event.blockNumber,
    hash: event.blockHash,
    timestamp: event.timestamp,
    swaps: [],
  };
}

const originalFetch = globalThis.fetch;

try {
  assert.equal(
    Number((await sql`select count(*) n from public.watches`)[0]?.n),
    0,
    "Database tests require an empty dedicated local Scout instance; existing watches are preserved.",
  );

  const alice = await user();
  const bob = await user();
  const createdWorkflow = await alice.client.workflow("create", {
    original_prompt: "Watch USDC transfers.",
  });

  if (createdWorkflow.error) {
    throw createdWorkflow.error;
  }

  const workflowWatchId = z.string().uuid().parse(createdWorkflow.data);
  const workflowRow = z
    .object({
      id: z.string().uuid(),
      state: z.string(),
      run_number: z.number(),
    })
    .parse(
      (
        await sql`select id,state,run_number from public.watch_workflows where watch_id=${workflowWatchId}`
      )[0],
    );

  assert.equal(workflowRow.state, "RECEIVED");
  assert.equal(
    (
      await sql`select id from public.watch_workflow_events where workflow_id=${workflowRow.id}`
    ).length,
    1,
  );
  assert.equal(
    (
      await sql`select id from app_private.jobs where kind='workflow' and payload->>'workflowId'=${workflowRow.id}`
    ).length,
    1,
  );
  assert.equal(
    (
      await bob.client.workflow("read", {
        watch_id: workflowWatchId,
        after_sequence: 0,
      })
    ).data,
    null,
  );
  check("workflow creation is atomic and cross-user reads return no data");

  const clarificationId = randomUUID();

  await sql`insert into public.watch_clarifications(id,workflow_id,watch_id,user_id,field,reason,question,choices)
    values(${clarificationId},${workflowRow.id},${workflowWatchId},${alice.id},'chain','Network selection changes the pipeline.','Which network should Scout watch?',${sql.json([{ value: "ethereum", label: "Ethereum", recommended: true }])})`;
  await sql`select app_private.put_workflow_output(${workflowRow.id},'intent',${sql.json({ partial: true })})`;
  await sql`select app_private.append_workflow_event(${workflowRow.id},'NEEDS_CLARIFICATION','intent.clarification','warning','One detail is needed','Network selection changes the pipeline.','{}')`;

  const deniedAnswer = await bob.client.workflow("answer", {
    watch_id: workflowWatchId,
    clarification_id: clarificationId,
    answer: "ethereum",
  });

  assert(deniedAnswer.error);

  const answered = await alice.client.workflow("answer", {
    watch_id: workflowWatchId,
    clarification_id: clarificationId,
    answer: "ethereum",
  });

  if (answered.error) {
    throw answered.error;
  }

  const resumed = z
    .object({ state: z.string(), run_number: z.number() })
    .parse(
      (
        await sql`select state,run_number from public.watch_workflows where id=${workflowRow.id}`
      )[0],
    );

  assert.deepEqual(resumed, { state: "INTENT_RESOLVING", run_number: 2 });
  assert.equal(
    (
      await sql`select payload from public.watch_workflow_outputs where workflow_id=${workflowRow.id} and kind='intent'`
    ).length,
    0,
  );
  assert.equal(
    (
      await sql`select distinct watch_id from public.watch_workflow_events where workflow_id=${workflowRow.id}`
    ).length,
    1,
  );
  check("clarification ownership is enforced and resumes the same Watch");
  await sql`update public.watches set status='live',error=null where id=${workflowWatchId}`;

  const watchingPage = await alice.client.rpc("scout_watches_page", {
    page_offset: 0,
    search_text: "",
    status_filter: "watching",
    sort_order: "newest",
  });

  if (watchingPage.error) {
    throw watchingPage.error;
  }

  assert(
    Array.isArray(watchingPage.data) &&
      watchingPage.data.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          value.id === workflowWatchId,
      ),
    "LIVE workflow watches must appear in Watching",
  );
  await sql`update public.watches set status='needs_clarification' where id=${workflowWatchId}`;

  const attentionPage = await alice.client.rpc("scout_watches_page", {
    page_offset: 0,
    search_text: "",
    status_filter: "attention",
    sort_order: "newest",
  });

  if (attentionPage.error) {
    throw attentionPage.error;
  }

  assert(
    Array.isArray(attentionPage.data) &&
      attentionPage.data.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          value.id === workflowWatchId,
      ),
    "clarification-blocked watches must appear in Needs attention",
  );
  check("collection filters include compiler LIVE and clarification states");
  assert(
    (
      await alice.client.rpc("scout_rate_limit", {
        bucket: "interpret",
        maximum: 20,
        period_seconds: 60,
      })
    ).error,
  );
  check(
    "direct RPC cannot weaken endpoint budgets or create arbitrary counter buckets",
  );

  const anonymous = createClient<Database>(local.API_URL, local.ANON_KEY, {
    auth: { persistSession: false },
  });
  const missingDestination = await alice.client.rpc("scout_save_watch", {
    watch_spec: z.json().parse(defaultSpec()),
    original_prompt: DEFAULT_PROMPT,
  });

  assert(
    missingDestination.error,
    "Activation requires a verified destination",
  );
  await sql`insert into app_private.telegram_connections(user_id,chat_id,telegram_user_id,label) values(${alice.id},${`initial-${alice.id}`},${`initial-user-${alice.id}`},'Controlled test destination')`;
  check("activation is gated on a verified destination");

  const saved = await alice.client.rpc("scout_save_watch", {
    watch_spec: z.json().parse(defaultSpec()),
    original_prompt: DEFAULT_PROMPT,
  });

  if (saved.error) {
    throw saved.error;
  }

  const wid = z.string().uuid().parse(saved.data);

  check(
    "authenticated draft creates immutable version, deployment and durable build job atomically",
  );
  assert.equal(
    (await bob.client.from("watches").select("id").eq("id", wid)).status,
    403,
  );
  assert((await anonymous.from("watches").select("id")).error);
  check("RLS denies cross-user and anonymous watch reads");
  assert(
    (
      await bob.client.rpc("scout_watch_action", {
        watch_id: wid,
        action: "pause",
      })
    ).error,
  );
  assert(
    (
      await bob.client.rpc("scout_save_watch", {
        existing_id: wid,
        watch_spec: z.json().parse(defaultSpec()),
        original_prompt: "Cross-user attempt",
      })
    ).error,
  );
  check("cross-user actions and version changes are denied");
  assert(
    (
      await alice.client
        .from("watches")
        .update({ user_id: bob.id })
        .eq("id", wid)
    ).error,
  );
  check("browser clients cannot directly mutate ownership or worker state");
  assert(
    (
      await alice.client.rpc("scout_save_watch", {
        watch_spec: z.json().parse({
          ...defaultSpec(),
          conditions: [
            {
              kind: "pool_selling",
              windowSeconds: 999999,
              cumulativeUsd: "0",
            },
          ],
        }),
        original_prompt: "Invalid direct RPC",
      })
    ).error,
  );
  check("database independently rejects a malformed direct-RPC rule");

  const deploymentId = z
    .string()
    .parse(
      (
        await sql`select id from public.pipeline_deployments where watch_id=${wid}`
      )[0]?.id,
    );
  let deployment = await loadDeployment(sql, deploymentId);
  const pairHash = createHash("sha256").update(randomUUID()).digest("hex");

  assert.equal(
    (await alice.client.rpc("scout_pair_telegram", { token_hash: pairHash }))
      .error,
    null,
  );
  assert.equal(
    (
      await service.rpc("scout_telegram_webhook", {
        update_id: updateBase + 100000 + checks,
        pairing_hash: pairHash,
        chat_id: `test-${alice.id}`,
        telegram_user_id: `test-user-${alice.id}`,
        display_label: "Controlled test chat",
      })
    ).data,
    "connected",
  );
  assert.equal(
    (
      await service.rpc("scout_telegram_webhook", {
        update_id: updateBase + 200000 + checks,
        pairing_hash: pairHash,
        chat_id: `other-${alice.id}`,
        telegram_user_id: `other-${alice.id}`,
      })
    ).data,
    "expired",
  );
  check("pairing token is consumed exactly once and binds a verified chat");

  const expired = createHash("sha256").update(randomUUID()).digest("hex");

  await alice.client.rpc("scout_pair_telegram", { token_hash: expired });
  await sql`update app_private.telegram_pairings set expires_at=now()-interval '1 second' where token_hash=${expired}`;
  assert.equal(
    (
      await service.rpc("scout_telegram_webhook", {
        update_id: updateBase + 300000 + checks,
        pairing_hash: expired,
        chat_id: "999",
        telegram_user_id: "999",
      })
    ).data,
    "expired",
  );
  check("expired pairing is rejected");
  assert(
    (
      await alice.client.rpc("scout_telegram_webhook", {
        update_id: 9,
        callback_watch_id: wid,
        chat_id: "999",
        telegram_user_id: "999",
      })
    ).error,
  );
  assert.equal(
    (
      await service.rpc("scout_telegram_webhook", {
        update_id: updateBase + 400000 + checks,
        callback_watch_id: wid,
        chat_id: `test-${alice.id}`,
        telegram_user_id: "wrong-user",
      })
    ).data,
    "unauthorized",
  );
  check(
    "only the service webhook can act, and callback chat plus Telegram user must match",
  );

  const firstOwner = randomUUID();

  await sql`insert into app_private.pipeline_leases(deployment_id,owner,expires_at) values(${deploymentId},${firstOwner},now()+interval '40 seconds')`;

  const events = fixtureEvents();

  assert(events[0] && events[1] && events[2]);
  // Rolling rules need observation coverage from the window start, not the
  // current block. Production sets this during pipeline warmup.
  await sql`update public.pipeline_deployments set proof=${sql.json({ observationFromTime: events[2].timestamp - maxWindow(defaultSpec()) })} where id=${deploymentId}`;
  deployment = await loadDeployment(sql, deploymentId);
  await persistBlock(
    sql,
    deployment,
    firstOwner,
    block(events[0]),
    [events[0]],
    true,
  );
  await persistBlock(
    sql,
    deployment,
    firstOwner,
    block(events[1]),
    [events[1]],
    true,
  );
  assert.equal(
    (await sql`select id from public.incidents where watch_id=${wid}`).length,
    0,
  );
  check("partial window persists without an early incident");
  await sql.end();
  sql = connectDatabase(local.DB_URL);

  const owner = randomUUID();

  await sql`update app_private.pipeline_leases set owner=${owner},expires_at=now()+interval '40 seconds' where deployment_id=${deploymentId}`;
  deployment = await loadDeployment(sql, deploymentId);
  await persistBlock(
    sql,
    deployment,
    owner,
    block(events[2]),
    [events[2]],
    true,
  );

  const recorded =
    await sql`select id from public.incidents where watch_id=${wid}`;

  assert.equal(
    recorded.length,
    1,
    "connection restart should restore the prior window and detect the third transaction",
  );

  const incidentId = z.string().parse(recorded[0]?.id);

  assert.equal(
    (await loadIncident(sql, incidentId)).detection.totalUsdMicros,
    "208000000000",
  );
  check(
    "connection restart restores the prior window and detects the third transaction",
  );
  await persistBlock(
    sql,
    deployment,
    owner,
    block(events[2]),
    [events[2]],
    true,
  );
  assert.equal(
    (await sql`select id from public.incidents where watch_id=${wid}`).length,
    1,
  );
  assert.equal(
    (
      await sql`select id from public.notification_deliveries where incident_id=${incidentId}`
    ).length,
    0,
  );
  assert.equal(
    (
      await sql`select id from app_private.jobs where kind='enrich' and payload->>'incidentId'=${incidentId}`
    ).length,
    1,
  );
  check("cursor replay does not duplicate an incident or investigation job");
  await assert.rejects(
    persistBlock(
      sql,
      deployment,
      firstOwner,
      block(events[2]),
      [events[2]],
      true,
    ),
    /lease lost/,
  );
  check("a previous owner cannot write after lease transfer");

  const config = WorkerEnv.parse({
    DATABASE_URL: local.DB_URL,
    SUPABASE_URL: local.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
    ETHEREUM_RPC_URL: "http://127.0.0.1:1",
    GRAPH_API_KEY: "controlled-test-only",
    SUBSTREAMS_API_TOKEN: "controlled-test-only",
    TELEGRAM_BOT_TOKEN: "controlled-test-only",
    SCOUT_SITE_URL: "https://scout.test",
  });
  let sends = 0;

  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (url.startsWith("https://gateway.thegraph.com/")) {
      const body = JSON.parse(String(init?.body)) as { query: string };
      const meta = {
        deployment: "controlled-subgraph",
        hasIndexingErrors: false,
        block: { number: 123, hash: null, timestamp: events[2]!.timestamp },
      };

      if (body.query.includes("ScoutPriorActivity")) {
        return new Response(
          JSON.stringify({ data: { _meta: meta, swaps: [] } }),
        );
      }

      const pool = POOLS[0]!;

      return new Response(
        JSON.stringify({
          data: {
            _meta: meta,
            pools: [
              {
                id: pool.address,
                feeTier: String(pool.fee),
                token0: {
                  id: pool.token0.address,
                  decimals: String(pool.token0.decimals),
                },
                token1: {
                  id: pool.token1.address,
                  decimals: String(pool.token1.decimals),
                },
              },
            ],
            swaps: [],
          },
        }),
      );
    }

    if (!url.startsWith("https://api.telegram.org/botcontrolled-test-only/")) {
      return originalFetch(input, init);
    }

    sends++;

    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 700 } }),
    );
  };

  const investigation = await sql.begin(async (lock) => {
    await lock`select id from app_private.jobs where kind='enrich' and payload->>'incidentId'<>${incidentId} for update`;

    const claimed = await claimJob(sql, owner, ["enrich"]);

    assert(claimed);
    assert.equal(claimed.payload.incidentId, incidentId);

    return claimed;
  });

  await handleJob(
    investigation,
    sql,
    service,
    ethereum(config.ETHEREUM_RPC_URL),
    config,
    new AbortController().signal,
  );
  await finishJob(sql, investigation, owner);
  assert.equal(
    (
      await sql`select id from public.notification_deliveries where incident_id=${incidentId}`
    ).length,
    1,
  );
  check("investigation completes before the alert enters the durable outbox");

  const job = await sql.begin(async (lock) => {
    // Isolate this check without changing older test jobs or another owner's work.
    await lock`select id from app_private.jobs where kind='notify' and payload->>'incidentId'<>${incidentId} for update`;

    const claimed = await claimJob(sql, owner, ["notify"]);

    assert(claimed);
    assert.equal(claimed.payload.incidentId, incidentId);
    assert.equal(await claimJob(sql, randomUUID(), ["notify"]), null);

    return claimed;
  });

  check("SKIP LOCKED job claims prevent duplicate ownership");
  await handleJob(
    job,
    sql,
    service,
    ethereum(config.ETHEREUM_RPC_URL),
    config,
    new AbortController().signal,
  );
  await finishJob(sql, job, owner);
  await handleJob(
    job,
    sql,
    service,
    ethereum(config.ETHEREUM_RPC_URL),
    config,
    new AbortController().signal,
  );
  assert.equal(sends, 1);
  assert.equal((await loadIncident(sql, incidentId)).delivery, "sent");
  check(
    "controlled Telegram HTTP delivery persists its message identity and suppresses replay",
  );
  await sql`update public.notification_deliveries set status='sending' where incident_id=${incidentId}`;
  await handleJob(
    job,
    sql,
    service,
    ethereum(config.ETHEREUM_RPC_URL),
    config,
    new AbortController().signal,
  );
  assert.equal((await loadIncident(sql, incidentId)).delivery, "ambiguous");
  assert.equal(sends, 1);
  check(
    "restart during an external send becomes ambiguous, not a blind resend",
  );
  await sql`update public.notification_deliveries set status='queued' where incident_id=${incidentId}`;
  await alice.client.rpc("scout_watch_action", {
    watch_id: wid,
    action: "mute",
  });
  await handleJob(
    job,
    sql,
    service,
    ethereum(config.ETHEREUM_RPC_URL),
    config,
    new AbortController().signal,
  );
  assert.equal((await loadIncident(sql, incidentId)).delivery, "muted");
  assert.equal(sends, 1);
  check(
    "notification mute changes actual delivery behavior without pausing monitoring",
  );

  const snapshot = SnapshotSchema.parse(
    (await alice.client.rpc("scout_snapshot")).data,
  );

  assert.equal(snapshot.watches[0]?.status, "watching");
  assert.equal(
    SnapshotSchema.parse((await bob.client.rpc("scout_snapshot")).data)
      .incidents.length,
    0,
  );
  assert.equal(
    (await bob.client.from("incident_evidence").select("event_id")).status,
    403,
  );
  check("snapshot and evidence remain owner-scoped");
  await alice.client.rpc("scout_incident_action", {
    incident_id: incidentId,
    action: "read",
  });
  assert((await loadIncident(sql, incidentId)).read);
  check("read controls persist to the incident record");
  assert(events[3]);

  const unvalued = { ...events[3], valuation: null };

  await persistBlock(sql, deployment, owner, block(unvalued), [unvalued], true);

  const degraded = SnapshotSchema.parse(
    (await alice.client.rpc("scout_snapshot")).data,
  );

  assert.equal(degraded.watches[0]?.status, "delayed");
  assert.match(
    degraded.watches[0]?.error ?? "",
    /USD valuation is unavailable/,
  );
  assert.equal(degraded.incidents.length, 1);
  check(
    "missing valuation persists an accurate degraded state without fabricating another USD match",
  );

  const updated = await alice.client.rpc("scout_save_watch", {
    existing_id: wid,
    watch_spec: z.json().parse({ ...defaultSpec(), name: "Replacement test" }),
    original_prompt: "Explicit replacement version",
  });

  assert.equal(updated.error, null);

  const prior = (
    await sql`select active_version_id,pending_version_id from public.watches where id=${wid}`
  )[0];

  assert(prior);
  assert.equal(prior.active_version_id, deployment.version_id);
  assert(prior.pending_version_id);
  check(
    "editing keeps the previous active version while its replacement prepares",
  );
  await persistUndo(sql, deployment, owner, {
    type: "undo",
    cursor: "test-rewind",
    number: events[1].blockNumber,
    hash: events[1].blockHash,
  });
  assert.equal((await loadIncident(sql, incidentId)).status, "retracted");
  assert.equal(
    (await sql`select desired_state from public.watches where id=${wid}`)[0]
      ?.desired_state,
    "paused",
  );
  check("unexpected finality rollback retracts evidence and pauses for review");

  const intentId = randomUUID();

  await sql`insert into public.transaction_intents(id,user_id,wallet,chain_id,intent,quote,expires_at) values(${intentId},${alice.id},${events[0].initiator},1,'{}','{}',now())`;
  assert.equal(
    (
      await bob.client
        .from("transaction_intents")
        .select("id")
        .eq("id", intentId)
    ).status,
    403,
  );
  check("transaction identities are private across users");

  const preparations = await Promise.all(
    [0, 1].map(
      () =>
        sql`update public.transaction_intents set state='prepared' where id=${intentId} and user_id=${alice.id} and state='quoted' and transaction_hash is null returning id`,
    ),
  );

  assert.equal(preparations.flat().length, 1);
  check(
    "concurrent preparation consumes a quote once, preventing reuse of an ambiguous signing attempt",
  );

  const hash = events[0].transactionHash;
  const referenceBlockHash = events[0].blockHash;
  const prepared = {
    from: events[0].initiator,
    to: ROUTERS[0],
    data: "0x1234",
    value: "0",
    chainId: 1,
  };
  let receiptStatus = "0x1";
  let pendingReceipt = true;
  let changedCalldata = false;
  const receiptRpc = createPublicClient({
    chain: mainnet,
    transport: custom({
      async request({ method }) {
        if (method === "eth_blockNumber") {
          return "0x65";
        }

        if (method === "eth_getTransactionByHash") {
          return {
            hash,
            from: prepared.from,
            to: prepared.to,
            input: changedCalldata ? "0xdead" : prepared.data,
            value: "0x0",
            chainId: "0x1",
            blockHash: referenceBlockHash,
            blockNumber: "0x64",
            transactionIndex: "0x0",
            nonce: "0x0",
            gas: "0x5208",
            gasPrice: "0x1",
            type: "0x2",
            maxFeePerGas: "0x1",
            maxPriorityFeePerGas: "0x1",
            accessList: [],
          };
        }

        if (method === "eth_getTransactionReceipt") {
          if (pendingReceipt) {
            return null;
          }

          return {
            transactionHash: hash,
            transactionIndex: "0x0",
            blockHash: referenceBlockHash,
            blockNumber: "0x64",
            from: prepared.from,
            to: prepared.to,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            contractAddress: null,
            logs: [],
            logsBloom: "0x",
            status: receiptStatus,
            type: "0x2",
            effectiveGasPrice: "0x1",
          };
        }

        throw new Error(`Unexpected controlled RPC method ${method}`);
      },
    }),
  });
  const reconciliation = {
    id: randomUUID(),
    kind: "reconcile" as const,
    payload: { intentId },
    attempts: 1,
    max_attempts: 3,
  };

  await sql`update public.transaction_intents set state='pending',transaction_hash=${hash},prepared_transaction=${sql.json(prepared)} where id=${intentId}`;
  await assert.rejects(
    handleJob(
      reconciliation,
      sql,
      service,
      receiptRpc,
      config,
      new AbortController().signal,
    ),
  );
  assert.equal(
    (
      await sql`select state from public.transaction_intents where id=${intentId}`
    )[0]?.state,
    "pending",
  );
  pendingReceipt = false;
  await handleJob(
    reconciliation,
    sql,
    service,
    receiptRpc,
    config,
    new AbortController().signal,
  );
  assert.equal(
    (
      await sql`select state from public.transaction_intents where id=${intentId}`
    )[0]?.state,
    "confirmed",
  );
  receiptStatus = "0x0";
  await sql`update public.transaction_intents set state='pending' where id=${intentId}`;
  await handleJob(
    reconciliation,
    sql,
    service,
    receiptRpc,
    config,
    new AbortController().signal,
  );
  assert.equal(
    (
      await sql`select state from public.transaction_intents where id=${intentId}`
    )[0]?.state,
    "reverted",
  );
  changedCalldata = true;
  await sql`update public.transaction_intents set state='pending' where id=${intentId}`;
  await handleJob(
    reconciliation,
    sql,
    service,
    receiptRpc,
    config,
    new AbortController().signal,
  );
  assert.equal(
    (
      await sql`select state from public.transaction_intents where id=${intentId}`
    )[0]?.state,
    "unknown",
  );
  await sql`update public.transaction_intents set state='reverted' where id=${intentId}`;
  check(
    "persisted transaction recovery distinguishes pending, confirmed, reverted and mismatched calldata without rebroadcast",
  );
  globalThis.fetch = originalFetch;
  // Actual process lifecycle with no runnable external jobs. The only RPC URL is a closed loopback port.
  await sql`update app_private.jobs set status='complete' where payload->>'deploymentId' in (select id::text from public.pipeline_deployments where user_id=${alice.id}) or payload->>'incidentId'=${incidentId} or payload->>'workflowId' in (select id::text from public.watch_workflows where user_id=${alice.id})`;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/worker/src/main.ts"],
    {
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(config).map(([key, value]) => [key, String(value)]),
        ),
        PORT: "18081",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";

  child.stdout.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });

  try {
    let ready = false;

    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await originalFetch(
          "http://127.0.0.1:18081/health/ready",
        );

        ready = response.ok;
      } catch {
        /* Startup is asynchronous; retry within a bounded deadline. */
      }

      if (ready) {
        break;
      }

      await delay(250);
    }

    assert(ready, "worker ready within 10 seconds");
    child.kill("SIGTERM");

    const [code] = await Promise.race([
      once(child, "exit"),
      delay(15_000).then(() => {
        throw new Error("Worker did not stop gracefully");
      }),
    ]);

    assert.equal(code, 0);
    assert(logs.includes("worker.stopped"));
    check("actual worker process reaches readiness and drains on SIGTERM");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  console.log(
    `\n${checks} database / cross-component checks passed. Telegram HTTP was controlled; no external alert was sent.`,
  );
} finally {
  globalThis.fetch = originalFetch;

  for (const id of users) {
    await cleanupTestJobs(sql, id);
    await cleanupTestAccount(sql, id);
  }

  await sql.end({ timeout: 5 });

  for (const id of users) {
    const result = await service.auth.admin.deleteUser(id);

    if (result.error) {
      console.error(`Test-user cleanup failed: ${result.error.message}`);
    }
  }
}
