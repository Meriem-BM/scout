import { isDeepStrictEqual } from "node:util";

import {
  ExecutableWatchSpecSchema,
  migrateExecutableProgram,
  requireValidatedProgram,
  WatchProgramSchema,
} from "@scout/domain";

import type { DatabaseConnection } from "@scout/database";

/** Legacy contracts are migration input only. No build or provider session is
 * admitted without an immutable, validated program bound to that exact version. */
export async function ensureDeploymentProgram(
  sql: DatabaseConnection,
  deploymentId: string,
) {
  return sql.begin(async (tx) => {
    const row = (
      await tx`select d.version_id,d.watch_id,d.user_id,v.spec from public.pipeline_deployments d join public.watch_versions v on v.id=d.version_id where d.id=${deploymentId} for share of d,v`
    )[0];

    if (!row) {
      throw new Error("Program deployment not found");
    }

    const draft = migrateExecutableProgram(
      ExecutableWatchSpecSchema.parse(row.spec),
    );

    if (!draft) {
      throw new Error(
        "INVALID_PROGRAM: This legacy rule has no complete WatchProgram migration; revalidation is required before running.",
      );
    }

    const validation = requireValidatedProgram(draft);
    const program = validation.program;

    await tx`insert into public.watch_programs(version_id,watch_id,user_id,language_version,chain_id,event_type,program) values(${row.version_id},${row.watch_id},${row.user_id},1,${program.source.chainId},${program.source.eventType},${tx.json(program)}) on conflict do nothing`;

    const stored = (
      await tx`select program from public.watch_programs where version_id=${row.version_id}`
    )[0];

    if (
      !isDeepStrictEqual(WatchProgramSchema.parse(stored?.program), program)
    ) {
      throw new Error(
        "Immutable WatchProgram does not match its executable version",
      );
    }

    return validation;
  });
}
