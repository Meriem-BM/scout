import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { connectDatabase, type DatabaseConnection } from "@scout/database";
import {
  compileV4LiquidityProgram,
  NormalizedOnchainEventSchema,
  ProgramWatchSpecSchema,
} from "@scout/domain";

import { persistProgramEvent } from "../../apps/worker/src/ingestion/program";
import { ensureDeploymentProgram } from "../../apps/worker/src/pipeline/program-gate";
import fixture from "../fixtures/v4-liquidity.json";

const url = process.env.DATABASE_URL;

assert(
  url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname),
  "Local rollback-only test",
);

const sql = connectDatabase(url, 1);
const rollback = new Error("CONTROLLED_ROLLBACK");
const negative = NormalizedOnchainEventSchema.parse(fixture.negative);
const positive = NormalizedOnchainEventSchema.parse(fixture.positive);

try {
  await assert.rejects(
    sql.begin(async (transaction) => {
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
      const deployment = {
        id: randomUUID(),
        watch_id: watch,
        user_id: user,
        version_id: version,
      };
      const compiled = compileV4LiquidityProgram({
        version: "v4",
        chainId: 1,
        change: "decrease",
        poolId: negative.subject,
        transactionInitiator: null,
        minimumUsd: null,
      });

      assert(compiled.status === "COMPILED");

      const spec = ProgramWatchSpecSchema.parse({
        schemaVersion: 1,
        protocol: "program",
        name: "V4 persistence regression",
        program: compiled.program,
        notifications: {
          inbox: true,
          telegram: false,
          email: false,
          useDefaults: false,
        },
      });

      await db`insert into app_private.accounts(id) values(${user})`;
      await db`insert into public.watches(id,user_id,name,status,desired_state) values(${watch},${user},${spec.name},'starting','running')`;
      await db`insert into public.watch_versions(id,watch_id,user_id,version,prompt,spec) values(${version},${watch},${user},1,'Recorded real V4 event replay',${db.json(spec)})`;
      await db`insert into public.pipeline_deployments(id,watch_id,user_id,version_id,state) values(${deployment.id},${watch},${user},${version},'starting')`;
      await ensureDeploymentProgram(db, deployment.id);
      await persistProgramEvent(db, deployment, positive);
      await persistProgramEvent(db, deployment, negative);
      await persistProgramEvent(db, deployment, negative);

      const findings =
        await db`select f.id,f.primary_subject,d.status from public.watch_findings f join public.finding_decisions d on d.finding_id=f.id where f.watch_id=${watch}`;

      assert.equal(findings.length, 1);
      assert.equal(findings[0]!.status, "ALERT");
      assert.equal(findings[0]!.primary_subject, negative.subject);

      const events =
        await db`select event_id,decoder from app_private.program_events where version_id=${version}`;

      assert.equal(events.length, 2);
      assert(events.every((e) => e.decoder === negative.provenance.decoder));
      await assert.rejects(
        db.begin(async (tx) => {
          await tx`update public.watch_versions set spec=jsonb_set(spec,'{name}','"Changed"') where id=${version}`;
        }),
      );
      console.log(
        JSON.stringify({
          case: "recorded V4 persistence replay",
          events: events.length,
          findings: findings.length,
          decision: "ALERT",
          immutableVersion: true,
          externalDeliveryAttempted: false,
        }),
      );

      throw rollback;
    }),
    (error) => error === rollback,
  );
} finally {
  await sql.end();
}
