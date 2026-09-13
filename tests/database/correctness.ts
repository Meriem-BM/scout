import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import {
  connectDatabase,
  type DatabaseConnection,
  loadDeployment,
} from "@scout/database";
import {
  BASE_USDC,
  CandidateEventSchema,
  ContextSchema,
  defaultSpec,
  Erc20WatchSpecSchema,
  evaluateTransfer,
  eventId,
  normalizeLegacySwap,
} from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";
import { GraphAdapter } from "@scout/integrations/graph";
import { TelegramAdapter } from "@scout/integrations/telegram";
import { swapCandidate } from "@scout/integrations/uniswap-candidate";

import { WorkerEnv } from "../../apps/worker/src/config";
import { persistCandidate } from "../../apps/worker/src/ingestion/candidates";
import { persistBlock } from "../../apps/worker/src/ingestion/persist";
import { fencedWorkflowDatabase } from "../../apps/worker/src/jobs/fence";
import {
  deliverFindingTelegram,
  mirrorLegacyDecision,
} from "../../apps/worker/src/jobs/findings";
import { handleJob } from "../../apps/worker/src/jobs/handlers";
import { ensureDeploymentProgram } from "../../apps/worker/src/pipeline/program-gate";
import { withSubstreamsSession } from "../../apps/worker/src/pipeline/sessions";
import { fixtureEvents } from "../fixtures/swap-events";

const config = { ...WorkerEnv.parse(process.env), GROQ_API_KEY: undefined };

assert(
  ["127.0.0.1", "localhost"].includes(new URL(config.DATABASE_URL).hostname),
  "Local rollback-only tests",
);

const sql = connectDatabase(config.DATABASE_URL, 1);
const rollback = new Error("CONTROLLED_ROLLBACK");
const original = GraphAdapter.prototype.context;
const results: unknown[] = [];

try {
  await sql.begin(async (transaction) => {
    const db = new Proxy(transaction, {
      get(target, key) {
        return key === "begin"
          ? target.savepoint.bind(target)
          : Reflect.get(target, key);
      },
    }) as unknown as DatabaseConnection;
    const user = randomUUID();
    const watch = randomUUID();
    const version = randomUUID();
    const deployment = randomUUID();
    const workflow = randomUUID();

    await db`insert into app_private.accounts(id) values(${user})`;
    await db`insert into public.watches(id,user_id,name,status,desired_state) values(${watch},${user},'Controlled correctness test','starting','running')`;

    const spec = {
      ...defaultSpec(),
      sellToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      conditions: [{ kind: "large_swap" as const, usd: "100000" }],
      investigation: { requireNoPriorUniswapSwaps: true },
    };

    await db`insert into public.watch_versions(id,watch_id,user_id,version,prompt,spec) values(${version},${watch},${user},1,'CONTROLLED acceptance fixture',${db.json(spec)})`;
    await db`update public.watches set pending_version_id=${version} where id=${watch}`;
    await db`insert into public.watch_workflows(id,watch_id,user_id,original_prompt,state) values(${workflow},${watch},${user},'CONTROLLED acceptance fixture','DEPLOYMENT_VERIFYING')`;
    await db`insert into public.pipeline_deployments(id,watch_id,user_id,version_id,workflow_id,state) values(${deployment},${watch},${user},${version},${workflow},'starting')`;
    await db`insert into app_private.pipeline_leases(deployment_id,owner,expires_at) values(${deployment},'correctness-test',now()+interval '5 minutes')`;
    await db`insert into app_private.telegram_connections(user_id,chat_id,telegram_user_id) values(${user},'controlled-not-a-recipient','controlled-test-user')`;

    const outputKinds = [
      "intent",
      "data_requirements",
      "package_resolution",
      "pipeline_plan",
      "verification",
      "watch_program",
      "capability_plan",
      "acceptance_report",
    ];

    for (const kind of outputKinds) {
      await db`select app_private.put_workflow_output(${workflow},${kind},'{"revision":1}'::jsonb)`;
      await db`select app_private.put_workflow_output(${workflow},${kind},'{"revision":2}'::jsonb)`;
    }

    const savedOutputs =
      await db`select kind,payload,schema_version from public.watch_workflow_outputs where workflow_id=${workflow}`;

    assert.equal(savedOutputs.length, outputKinds.length);

    for (const saved of savedOutputs) {
      assert.deepEqual(saved.payload, { revision: 2 });
      assert.equal(saved.schema_version, 2);
    }

    await assert.rejects(
      db.begin(async (tx) => {
        await tx`select app_private.put_workflow_output(${workflow},'invented_output','{}'::jsonb)`;
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "23514",
    );
    await db`delete from public.watch_workflow_outputs where workflow_id=${workflow}`;
    results.push({
      case: "workflow output contract",
      acceptedKinds: outputKinds,
      invalidKindRejected: true,
      revisionsPreserved: true,
    });

    const removalRollback = new Error("ROLLBACK_WATCH_REMOVAL");

    await assert.rejects(
      db.begin(async (tx) => {
        await tx`select set_config('request.jwt.claim.sub',${user},true)`;

        const removable = randomUUID();

        for (const id of [
          removable,
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ]) {
          await tx`insert into public.watches(id,user_id,name,status,desired_state) values(${id},${user},'Failed Watch','failed','running')`;
        }

        await assert.rejects(
          tx.savepoint(async (inner) => {
            await inner`select public.scout_create_watch('Watch USDC transfers above $500K on Base')`;
          }),
          /Five-watch limit reached/,
        );
        await tx`select set_config('request.jwt.claim.sub',${randomUUID()},true)`;
        await assert.rejects(
          tx.savepoint(async (inner) => {
            await inner`select public.scout_watch_action(${removable},'archive',60)`;
          }),
          /Watch not found/,
        );
        await tx`select set_config('request.jwt.claim.sub',${user},true)`;
        await tx`select public.scout_watch_action(${removable},'archive',60)`;
        assert.equal(
          (
            await tx`select desired_state from public.watches where id=${removable}`
          )[0]?.desired_state,
          "archived",
        );

        const [created] =
          await tx`select public.scout_create_watch('Watch USDC transfers above $500K on Base') id`;

        assert.ok(created?.id);

        throw removalRollback;
      }),
      (error: unknown) => error === removalRollback,
    );
    results.push({
      test: "failed_watch_removal",
      freesSlot: true,
      ownershipEnforced: true,
      recordPreserved: true,
    });

    const loaded = await loadDeployment(db, deployment);
    const seed = fixtureEvents(spec)[0]!;
    const events = [0, 1, 2].map((index) => {
      const e = {
        ...seed,
        initiator: "0x" + String(index + 1).repeat(40),
        transactionHash: "0x" + String(index + 1).repeat(64),
        logIndex: index,
        valuation: { ...seed.valuation!, usdMicros: "250000000000" },
      };

      return { ...e, id: eventId(e) };
    });
    const block = {
      type: "block" as const,
      cursor: "controlled-cursor",
      number: seed.blockNumber,
      hash: seed.blockHash,
      timestamp: seed.timestamp,
      swaps: [],
    };

    await persistBlock(
      db,
      loaded,
      "correctness-test",
      block,
      events,
      true,
      seed.blockNumber,
    );
    await persistBlock(
      db,
      loaded,
      "correctness-test",
      block,
      events,
      true,
      seed.blockNumber,
    );

    const incidents =
      await db`select id,detection from public.incidents where watch_id=${watch} order by detection->>'initiator'`;

    assert.equal(
      incidents.length,
      3,
      "Wallets must never overwrite one another",
    );

    let status: "FOUND" | "NONE_WITH_PROVEN_COVERAGE" | "UNKNOWN" =
      "NONE_WITH_PROVEN_COVERAGE";

    GraphAdapter.prototype.context = async (incident) =>
      ContextSchema.parse({
        status: "available",
        subgraphId: "controlled-fixture",
        deployment: "controlled-fixture",
        blockNumber: Number(seed.blockNumber),
        blockHash: seed.blockHash,
        refreshedAt: new Date().toISOString(),
        from: 0,
        to: seed.timestamp,
        sampledSwaps: 0,
        volumeUsd: null,
        priorInitiatorTransactions:
          status === "FOUND" ? 1 : status === "UNKNOWN" ? null : 0,
        priorActivity: {
          status,
          protocol: "uniswap_v3",
          actor: incident.detection.initiator!,
          beforeTransaction: incident.evidence[0]!.transactionHash,
          throughBlock: seed.blockNumber,
          blockHash: seed.blockHash,
          deployment: "controlled-fixture",
          evidenceTransaction:
            status === "FOUND" ? "0x" + "4".repeat(64) : null,
          coverage:
            status === "NONE_WITH_PROVEN_COVERAGE"
              ? {
                  fromBlock: "0",
                  throughBlock: seed.blockNumber,
                  blockHash: seed.blockHash,
                  complete: true,
                }
              : undefined,
          reason: "CONTROLLED provider response; not live historical proof",
        },
        note: "Controlled acceptance test",
      });

    const enrich = async (id: string) =>
      handleJob(
        {
          id: randomUUID(),
          kind: "enrich",
          payload: { incidentId: id },
          attempts: 1,
          max_attempts: 3,
        },
        db,
        createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
        ethereum(config.ETHEREUM_RPC_URL),
        config,
        new AbortController().signal,
      );

    await enrich(incidents[0]!.id);
    await enrich(incidents[0]!.id);
    status = "FOUND";
    await enrich(incidents[1]!.id);
    status = "UNKNOWN";
    await enrich(incidents[2]!.id);

    const decisions =
      await db`select status,count(*)::int n from public.investigation_decisions where incident_id=any(${incidents.map((i) => i.id)}) group by status`;

    assert.deepEqual(
      Object.fromEntries(decisions.map((d) => [d.status, d.n])),
      { ALERT: 1, SUPPRESS: 1, PENDING: 1 },
    );
    assert.equal(
      (
        await db`select count(*)::int n from public.notification_deliveries where user_id=${user}`
      )[0]!.n,
      1,
    );
    results.push({
      tests: "A/B/C",
      mode: "CONTROLLED_DATABASE_ROLLBACK",
      decisions,
      deliveryAttempted: false,
      outboxQueued: 1,
      pendingRetry: true,
    });
    status = "NONE_WITH_PROVEN_COVERAGE";
    await enrich(incidents[2]!.id);
    await enrich(incidents[2]!.id);
    assert.equal(
      (
        await db`select count(*)::int n from public.notification_deliveries where user_id=${user}`
      )[0]!.n,
      2,
    );
    assert.equal(
      (
        await db`select count(*)::int n from public.investigation_decisions where incident_id=any(${incidents.map((i) => i.id)})`
      )[0]!.n,
      3,
    );
    results.push({
      test: "F",
      mode: "CONTROLLED_REPLAY",
      incidents: 3,
      finalDecisions: 3,
      outboxRows: 2,
      duplicateRows: 0,
      workflowEvents:
        await db`select type,stage from public.watch_workflow_events where workflow_id=${workflow}`,
      deliveryAttempted: false,
    });

    // A live Watch must evaluate missed blocks after reconnect, even while behind chain head.
    const recoveryEvent = {
      ...events[0]!,
      transactionHash: `0x${"d".repeat(64)}`,
      initiator: `0x${"4".repeat(40)}`,
      blockNumber: String(BigInt(events[0]!.blockNumber) + 1n),
      blockHash: `0x${"e".repeat(64)}`,
      timestamp: events[0]!.timestamp + 1,
    };

    recoveryEvent.valuation = {
      ...recoveryEvent.valuation!,
      blockNumber: recoveryEvent.blockNumber,
    };
    recoveryEvent.id = eventId(recoveryEvent);
    await persistBlock(
      db,
      loaded,
      "correctness-test",
      {
        type: "block",
        cursor: "controlled-recovery",
        number: recoveryEvent.blockNumber,
        hash: recoveryEvent.blockHash,
        timestamp: recoveryEvent.timestamp,
        swaps: [],
      },
      [recoveryEvent],
      false,
      String(BigInt(recoveryEvent.blockNumber) + 50n),
    );
    assert.equal(
      (
        await db`select count(*)::int n from public.incidents where watch_id=${watch}`
      )[0]!.n,
      4,
    );
    results.push({
      test: "active_watch_catchup",
      detectedWhileBehind: true,
      deliveryAttempted: false,
    });

    const baseVersion = randomUUID();
    const baseDeployment = randomUUID();
    const baseSpec = Erc20WatchSpecSchema.parse({
      schemaVersion: 1,
      protocol: "erc20",
      chainId: 8453,
      name: "Controlled Base USDC",
      token: BASE_USDC,
      thresholdMicros: "500000000000",
      operator: "gte",
      valuation: "nominal_usdc",
      confirmation: "finalized",
      notifications: {
        inbox: true,
        telegram: false,
        email: false,
        useDefaults: true,
      },
    });

    await db`insert into public.watch_versions(id,watch_id,user_id,version,prompt,spec) values(${baseVersion},${watch},${user},2,'CONTROLLED Base test',${db.json(baseSpec)})`;
    await db`insert into public.pipeline_deployments(id,watch_id,user_id,version_id) values(${baseDeployment},${watch},${user},${baseVersion})`;
    assert.equal(
      (await ensureDeploymentProgram(db, baseDeployment)).status,
      "PROGRAM_VALIDATED",
    );

    const base = {
      id: baseDeployment,
      watch_id: watch,
      user_id: user,
      version_id: baseVersion,
    };

    for (const [index, value] of ["600000000000", "499999999999"].entries()) {
      const event = CandidateEventSchema.parse({
        id: `controlled:${index}`,
        chainId: 8453,
        block: {
          number: seed.blockNumber,
          hash: seed.blockHash,
          timestamp: seed.timestamp,
        },
        transaction: { hash: seed.transactionHash, initiator: seed.initiator },
        eventIndex: index,
        actor: { address: seed.initiator, role: "sender" },
        subject: { address: BASE_USDC, kind: "token" },
        eventType: "transfer",
        protocol: "erc20",
        assets: [{ address: BASE_USDC, amount: value, decimals: 6 }],
        value: { usdMicros: value, source: "nominal_usdc" },
        metadata: {
          kind: "transfer",
          from: seed.initiator,
          to: seed.recipient,
        },
        finality: "finalized",
        source: "substreams",
      });

      await persistCandidate(
        db,
        base,
        event,
        evaluateTransfer(baseSpec, event),
      );
      await persistCandidate(
        db,
        base,
        event,
        evaluateTransfer(baseSpec, event),
      );
    }

    assert.equal(
      (
        await db`select count(*)::int n from public.candidate_detections where deployment_id=${baseDeployment}`
      )[0]!.n,
      1,
    );
    results.push({
      tests: "D/E",
      mode: "CONTROLLED_DATABASE_ROLLBACK",
      candidateEvents: 2,
      detections: 1,
      duplicates: 0,
      deliveryAttempted: false,
    });

    const finding =
      await db`select f.id,d.status from public.watch_findings f join public.finding_decisions d on d.finding_id=f.id where f.version_id=${baseVersion}`;

    assert.equal(
      finding.length,
      1,
      "Only above-threshold events create generic findings",
    );
    assert.equal(finding[0]!.status, "ALERT");
    assert.equal(
      (
        await db`select count(*)::int n from public.notification_deliveries where finding_id=${finding[0]!.id}`
      )[0]!.n,
      1,
      "Replay queues one generic outbox record",
    );

    const currentVersion = (
      await db`select active_version_id from public.watches where id=${watch}`
    )[0]!.active_version_id;

    await db`update public.watches set active_version_id=${baseVersion} where id=${watch}`;

    const sendFinding = TelegramAdapter.prototype.sendFinding;
    let controlledSends = 0;

    TelegramAdapter.prototype.sendFinding = async () => {
      controlledSends++;

      return 12345;
    };

    try {
      await deliverFindingTelegram(db, finding[0]!.id, {
        ...config,
        TELEGRAM_BOT_TOKEN: "controlled-no-network",
      });
      await deliverFindingTelegram(db, finding[0]!.id, {
        ...config,
        TELEGRAM_BOT_TOKEN: "controlled-no-network",
      });
      assert.equal(
        controlledSends,
        1,
        "A repeated delivery job must not resend",
      );
    } finally {
      TelegramAdapter.prototype.sendFinding = sendFinding;
    }

    await db`update public.watches set active_version_id=${currentVersion} where id=${watch}`;

    const genericDecisions =
      await db`select fd.status,count(*)::int n from public.finding_decisions fd join public.watch_findings f on f.id=fd.finding_id where f.version_id=${version} group by fd.status`;

    assert(
      genericDecisions.some((row) => row.status === "SUPPRESS"),
      "Legacy historical decisions reach generic findings",
    );
    await assert.rejects(
      db.begin(async (tx) => {
        await tx`update public.watch_programs set program=program where version_id=${baseVersion}`;
      }),
      /immutable/,
    );
    results.push({
      test: "generic_program_persistence",
      genericFindings: finding.length,
      immutableProgram: true,
      controlledProviderCalls: controlledSends,
      realDeliveryAttempted: false,
      genericDecisions,
    });

    const isolatedVersion = randomUUID();
    const isolatedDeployment = randomUUID();

    await db`insert into public.watch_versions(id,watch_id,user_id,version,prompt,spec) values(${isolatedVersion},${watch},${user},3,'CONTROLLED version isolation',${db.json(spec)})`;
    await db`insert into public.pipeline_deployments(id,watch_id,user_id,version_id) values(${isolatedDeployment},${watch},${user},${isolatedVersion})`;
    await persistCandidate(
      db,
      {
        id: isolatedDeployment,
        watch_id: watch,
        user_id: user,
        version_id: isolatedVersion,
      },
      swapCandidate(events[0]!),
      null,
      "legacy",
      normalizeLegacySwap(events[0]!),
    );

    const oldIncident = (
      await db`select id from public.incidents where version_id=${version} and detection->>'initiator'=${events[0]!.initiator} limit 1`
    )[0]!;

    await mirrorLegacyDecision(db, oldIncident.id, "ALERT", {
      source: "controlled",
    });
    assert.equal(
      (
        await db`select d.status from public.finding_decisions d join public.watch_findings f on f.id=d.finding_id where f.version_id=${isolatedVersion}`
      )[0]!.status,
      "PENDING",
      "An older Watch version cannot decide a newer finding",
    );
    results.push({ test: "finding_version_isolation", passed: true });

    // Isolate budget rows within this rollback-only transaction. Existing leases return unchanged at rollback.
    await db`delete from app_private.substreams_sessions`;
    await withSubstreamsSession(
      db,
      2,
      "live",
      new AbortController().signal,
      async () => {
        await assert.rejects(
          () =>
            withSubstreamsSession(
              db,
              2,
              "live",
              new AbortController().signal,
              async () => {},
            ),
          /capacity/,
        );
        await withSubstreamsSession(
          db,
          2,
          "verification",
          new AbortController().signal,
          async () => {},
        );
      },
    );

    const job = randomUUID();

    await db`insert into app_private.jobs(id,kind,payload,dedupe_key,status,attempts,leased_until) values(${job},'workflow','{}',${job},'running',1,now()+interval '1 minute')`;

    const fenced = fencedWorkflowDatabase(db, {
      id: job,
      kind: "workflow",
      payload: {},
      attempts: 1,
      max_attempts: 3,
    });

    await fenced`select app_private.put_workflow_output(${workflow},'intent','{}'::jsonb)`;
    await db`select app_private.put_workflow_output(${workflow},'pipeline_plan','{}'::jsonb)`;
    await db`delete from public.watch_workflow_outputs where workflow_id=${workflow} and kind='intent'`;
    assert.equal(
      (
        await db`select count(*)::int n from public.watch_workflow_outputs where workflow_id=${workflow}`
      )[0]!.n,
      0,
    );
    await db`update app_private.jobs set attempts=2 where id=${job}`;
    await assert.rejects(
      () =>
        fenced`select app_private.put_workflow_output(${workflow},'intent','{}'::jsonb)`,
      /Stale workflow/,
    );

    const generation = Number(
      (
        await db`select generation from app_private.pipeline_leases where deployment_id=${deployment}`
      )[0]!.generation,
    );

    await assert.rejects(
      () =>
        persistBlock(
          db,
          loaded,
          "correctness-test",
          block,
          events,
          false,
          block.number,
          generation + 1,
        ),
      /Pipeline lease lost/,
    );
    await db`select set_config('scout.job_id','',true)`;
    await db`update public.watches set status='live' where id=${watch}`;
    await db`update public.pipeline_deployments set last_message_at=now()-interval '4 minutes',last_block_time=now() where id=${deployment}`;
    assert.equal(
      (
        await db`select app_private.watch_json(w)->>'status' status from public.watches w where id=${watch}`
      )[0]!.status,
      "delayed",
    );
    results.push({
      test: "operational",
      reservedVerificationSlot: true,
      staleAttemptRejected: true,
      stalePipelineGenerationRejected: true,
      staleLiveStatusRejected: true,
      downstreamInvalidated: true,
    });

    throw rollback;
  });
} catch (error) {
  if (error !== rollback) {
    throw error;
  }
} finally {
  GraphAdapter.prototype.context = original;
  await sql.end();
}

console.log(JSON.stringify({ results, allChangesRolledBack: true }, null, 2));
