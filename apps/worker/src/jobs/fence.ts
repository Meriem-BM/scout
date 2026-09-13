import type { DatabaseConnection, Job } from "@scout/database";

/** Every workflow transaction carries its claimed job attempt. Database triggers reject stale commits. */
export function fencedWorkflowDatabase(
  sql: DatabaseConnection,
  job: Job,
): DatabaseConnection {
  const configure = async (tx: DatabaseConnection) => {
    await tx`select set_config('scout.job_id',${job.id},true),set_config('scout.job_attempt',${String(job.attempts)},true)`;
  };

  return new Proxy(sql, {
    apply(_target, _this, args) {
      return sql.begin(async (tx) => {
        await configure(tx as unknown as DatabaseConnection);

        return Reflect.apply(tx, tx, args);
      });
    },
    get(target, key) {
      if (key === "begin") {
        return async (fn: (tx: DatabaseConnection) => Promise<unknown>) =>
          sql.begin(async (tx) => {
            await configure(tx as unknown as DatabaseConnection);

            return fn(tx as unknown as DatabaseConnection);
          });
      }

      return Reflect.get(target, key);
    },
  });
}
