import { randomUUID } from "node:crypto";

import { IntegrationError } from "@scout/integrations/http";

import type { DatabaseConnection } from "@scout/database";

/** Database-wide capacity, shared by every worker and both chains. One slot is reserved for verification. */
export async function withSubstreamsSession<T>(
  sql: DatabaseConnection,
  capacity: number,
  kind: "live" | "verification",
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const id = randomUUID();
  const granted = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(8453001)`;
    await tx`delete from app_private.substreams_sessions where expires_at<now()`;

    const [counts] =
      await tx`select count(*)::int total,count(*) filter(where kind='live')::int live from app_private.substreams_sessions`;

    if (
      Number(counts!.total) >= capacity ||
      (kind === "live" && Number(counts!.live) >= capacity - 1)
    ) {
      return false;
    }

    await tx`insert into app_private.substreams_sessions(id,kind,expires_at) values(${id},${kind},now()+interval '60 seconds')`;

    return true;
  });

  if (!granted) {
    throw new IntegrationError(
      "SUBSTREAMS_CAPACITY",
      "Substreams session capacity is reserved or occupied. Waiting for an available slot.",
      30,
    );
  }

  const lease = new AbortController();
  const timer = setInterval(() => {
    void sql`update app_private.substreams_sessions set expires_at=now()+interval '60 seconds' where id=${id} and expires_at>now() returning id`
      .then((rows) => {
        if (!rows.length) {
          lease.abort();
        }
      })
      .catch(() => lease.abort());
  }, 15000);

  try {
    return await run(AbortSignal.any([signal, lease.signal]));
  } finally {
    clearInterval(timer);
    await sql`delete from app_private.substreams_sessions where id=${id}`;
  }
}
