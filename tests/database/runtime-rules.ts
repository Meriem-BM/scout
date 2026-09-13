import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { connectDatabase, loadDeployment } from "@scout/database";
import { defaultSpec, WatchSpecSchema } from "@scout/domain";

import { persistBlock } from "../../apps/worker/src/ingestion/persist";
import { fixtureEvents } from "../fixtures/swap-events";

import { cleanupTestJobs } from "./cleanup";

const { stdout } = await promisify(execFile)("pnpm", [
  "exec",
  "supabase",
  "status",
  "-o",
  "json",
]);
const local = z
  .object({ API_URL: z.url(), DB_URL: z.url(), SERVICE_ROLE_KEY: z.string() })
  .parse(JSON.parse(stdout));

for (const url of [local.API_URL, local.DB_URL]) {
  assert(["127.0.0.1", "localhost"].includes(new URL(url).hostname));
}

const sql = connectDatabase(local.DB_URL);
const service = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const created = await service.auth.admin.createUser({
  email: `runtime-${randomUUID()}@example.invalid`,
  password: randomUUID() + randomUUID(),
  email_confirm: true,
});

assert(created.data.user, "Isolated test account could not be created");

const userId = created.data.user.id;
const watchId = randomUUID();
const versionId = randomUUID();
const deploymentId = randomUUID();
const owner = randomUUID();

try {
  await sql`insert into app_private.accounts(id,verified_email) values(${userId},${created.data.user.email!})`;

  const spec = WatchSpecSchema.parse({
    ...defaultSpec(),
    streamDirection: "either",
    notifications: {
      inbox: true,
      telegram: false,
      email: false,
      useDefaults: false,
    },
    conditions: [
      {
        kind: "aggregate",
        description: "Volume above twice the previous five-minute rate",
        rule: {
          id: "volume",
          predicates: [],
          groupBy: ["pool"],
          aggregate: { operation: "sum", field: "usdMicros" },
          windowSeconds: 60,
          threshold: "0",
          operator: "gt",
          baseline: {
            windowSeconds: 300,
            multiplierMicros: "2000000",
            minimum: "1",
          },
        },
      },
    ],
  });
  const events = fixtureEvents(spec).slice(0, 3);

  assert(events[0] && events[1] && events[2]);

  const proof = { observationFromTime: events[0].timestamp, testFixture: true };

  await sql.begin(async (tx) => {
    await tx`insert into public.watches(id,user_id,name,pending_version_id) values(${watchId},${userId},${spec.name},${versionId})`;
    await tx`insert into public.watch_versions(id,watch_id,user_id,version,prompt,spec) values(${versionId},${watchId},${userId},1,'Controlled runtime database test',${tx.json(spec)})`;
    await tx`insert into public.pipeline_deployments(id,watch_id,user_id,version_id,state,proof) values(${deploymentId},${watchId},${userId},${versionId},'paused',${tx.json(proof)})`;
    await tx`insert into app_private.pipeline_leases(deployment_id,owner,expires_at) values(${deploymentId},${owner},now()+interval '1 hour')`;
  });

  const deployment = await loadDeployment(sql, deploymentId);

  for (const [index, event] of events.entries()) {
    await persistBlock(
      sql,
      deployment,
      owner,
      {
        type: "block",
        number: event.blockNumber,
        hash: event.blockHash,
        cursor: `fixture-${index}`,
        timestamp: event.timestamp,
        swaps: [],
      },
      [event],
      true,
    );

    const watch = (
      await sql`select active_version_id from public.watches where id=${watchId}`
    )[0];

    assert.equal(
      watch?.active_version_id,
      index < 2 ? null : versionId,
      "Activation must wait for the complete baseline",
    );
  }

  const incidents =
    await sql`select detection from public.incidents where watch_id=${watchId}`;

  assert.equal(incidents.length, 1);

  const aggregation = incidents[0]!.detection.matches[0].aggregation;

  assert.equal(aggregation.status, "MATCH");
  assert.equal(aggregation.baselineEvidenceComplete, true);
  assert.equal(aggregation.baselineEvidence.length, 1);
  assert.equal(aggregation.baselineEvidence[0].id, events[1].id);

  const condition = spec.conditions[0];

  assert(condition?.kind === "aggregate");

  const invalid = {
    ...condition,
    rule: {
      ...condition.rule,
      windowSeconds: 7200,
    },
  };

  await assert.rejects(
    sql`insert into public.watch_versions(watch_id,user_id,version,prompt,spec) values(${watchId},${userId},2,'Invalid history test',${sql.json({ ...spec, conditions: [invalid] })})`,
    /Invalid runtime rule/,
  );
  console.log(
    "PASS persisted baseline gating, activation, detection, baseline evidence and database rule rejection (controlled fixtures; no provider verification claimed).",
  );
} finally {
  await cleanupTestJobs(sql, userId);
  await sql`delete from app_private.accounts where id=${userId}`;
  await service.auth.admin.deleteUser(userId);
  await sql.end();
}
