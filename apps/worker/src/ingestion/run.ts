import { ensureDeploymentProgram } from "../pipeline/program-gate";
import { withSubstreamsSession } from "../pipeline/sessions";

import { runBasePipeline } from "./base";
import { runProgramPipeline } from "./normalized";
import { runUniswapPipeline } from "./uniswap";

/** Shared lifecycle/capacity; protocol-specific evidence stays inside each executor. */
export async function runPipeline(
  ...args: Parameters<typeof runUniswapPipeline>
) {
  const [sql, storage, rpc, config, id, owner, signal] = args;
  const protocol = (
    await sql`select v.spec->>'protocol' protocol from public.pipeline_deployments d join public.watch_versions v on v.id=d.version_id where d.id=${id}`
  )[0]?.protocol;

  const lease = (
    await sql`select generation from app_private.pipeline_leases where deployment_id=${id} and owner=${owner} and expires_at>now()`
  )[0];

  if (!lease) {
    throw new Error("Pipeline lease lost before stream acquisition");
  }

  const generation = Number(lease.generation);

  await ensureDeploymentProgram(sql, id);

  return withSubstreamsSession(
    sql,
    config.SUBSTREAMS_SESSION_CAPACITY,
    "live",
    signal,
    (active) => {
      if (protocol === "program") {
        return runProgramPipeline(
          sql,
          storage,
          config,
          id,
          owner,
          active,
          generation,
        );
      }

      if (protocol === "erc20") {
        return runBasePipeline(
          sql,
          storage,
          config,
          id,
          owner,
          active,
          generation,
        );
      }

      if (protocol === "uniswap_v3") {
        return runUniswapPipeline(
          sql,
          storage,
          rpc,
          config,
          id,
          owner,
          active,
          generation,
        );
      }

      throw new Error(
        "No executable adapter for this persisted Watch protocol",
      );
    },
  );
}
