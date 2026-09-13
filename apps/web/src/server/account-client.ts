import "server-only";

import type { Database, Json } from "@scout/database/types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Functions = Database["public"]["Functions"];
type AccountOperation = Exclude<
  keyof Functions,
  | "scout_authenticate"
  | "scout_account_rpc"
  | "scout_logout"
  | "scout_email_begin"
  | "scout_email_event"
  | "scout_email_disable"
  | "scout_telegram_webhook"
>;

export function accountClient(
  service: SupabaseClient<Database>,
  subject: string,
  session: string,
) {
  return {
    async rpc<Name extends AccountOperation>(
      name: Name,
      args?: Functions[Name]["Args"],
    ) {
      const result = await service.rpc("scout_account_rpc", {
        privy_subject: subject,
        privy_session: session,
        operation: name,
        args: (args ?? {}) as Json,
      });

      return {
        ...result,
        data: result.data as Functions[Name]["Returns"] | null,
      };
    },
  };
}
