import { connectDatabase } from "@scout/database";
import { SwapEventSchema } from "@scout/domain";
import { baseRpc } from "@scout/integrations/erc20";
import { GraphAdapter } from "@scout/integrations/graph";

const sql = connectDatabase(process.env.DATABASE_URL!, 1);

try {
  const rows =
    await sql`select payload from public.incident_evidence order by event_id limit 3`;
  const graph = new GraphAdapter(
    process.env.GRAPH_API_KEY!,
    process.env.GRAPH_SUBGRAPH_ID,
  );

  for (const row of rows) {
    const event = SwapEventSchema.parse(row.payload);
    const result = await graph.checkPriorActivity(event);

    console.log(
      JSON.stringify({
        test: "real_graph_prior_activity",
        eventId: event.id,
        ...result,
        deliveryAttempted: false,
      }),
    );
  }

  const rpc = baseRpc(process.env.BASE_RPC_URL ?? "https://mainnet.base.org");

  console.log(
    JSON.stringify({
      test: "base_rpc",
      chain: await rpc.getChainId(),
      head: (await rpc.getBlock({ blockTag: "finalized" })).number.toString(),
      deliveryAttempted: false,
    }),
  );
  console.log(
    JSON.stringify({
      configuration: {
        baseEndpoint: !!process.env.BASE_SUBSTREAMS_ENDPOINT,
        telegram: !!process.env.TELEGRAM_BOT_TOKEN,
        email: !!process.env.RESEND_API_KEY,
      },
    }),
  );
} finally {
  await sql.end();
}
