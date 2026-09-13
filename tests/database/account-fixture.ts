import { randomUUID } from "node:crypto";

import type { DatabaseConnection } from "@scout/database";
import type { Database, Json } from "@scout/database/types";
import type { SupabaseClient } from "@supabase/supabase-js";

// Isolated database tests provision a trusted identity directly. This does not
// bypass or simulate Privy in the application; HTTP JWT verification is tested
// separately with ephemeral ES256 keys against the actual Privy verifier.
export async function accountFixture(
  sql: DatabaseConnection,
  service: SupabaseClient<Database>,
  browser: SupabaseClient<Database>,
  id: string,
) {
  // The fixture represents a server-verified Privy profile. Runtime account
  // creation goes through scout_authenticate; database tests provision the
  // same private account boundary directly.
  await sql`insert into app_private.accounts(id,verified_email)
    select id,lower(email) from auth.users
    where id=${id} and email_confirmed_at is not null
    on conflict(id) do update set verified_email=excluded.verified_email`;

  const subject = `did:privy:test-${randomUUID()}`;
  const session = randomUUID();

  await sql`insert into app_private.privy_accounts(subject,account_id) values(${subject},${id})`;
  await sql`insert into app_private.privy_sessions(session_id,subject,expires_at) values(${session},${subject},now()+interval '1 hour')`;

  return {
    from: browser.from.bind(browser),
    async workflow(
      operation: "create" | "read" | "answer" | "retry" | "duplicate",
      args: Record<string, unknown>,
    ) {
      return service.rpc("scout_workflow_account_rpc", {
        privy_subject: subject,
        privy_session: session,
        operation,
        args: args as Json,
      });
    },
    async rpc<N extends keyof Database["public"]["Functions"]>(
      operation: N,
      args?: Database["public"]["Functions"][N]["Args"],
    ) {
      const result = await service.rpc("scout_account_rpc", {
        privy_subject: subject,
        privy_session: session,
        operation,
        args: (args ?? {}) as Json,
      });

      return {
        ...result,
        data: result.data as
          Database["public"]["Functions"][N]["Returns"] | null,
      };
    },
  };
}

export async function cleanupTestAccount(sql: DatabaseConnection, id: string) {
  await sql`delete from app_private.privy_sessions where subject in(select subject from app_private.privy_accounts where account_id=${id})`;
  await sql`delete from app_private.privy_accounts where account_id=${id}`;
  await sql`delete from app_private.accounts where id=${id}`;
}
