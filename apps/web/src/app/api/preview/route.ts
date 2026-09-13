import { TOKENS, WatchSpecSchema } from "@scout/domain";
import { GraphAdapter } from "@scout/integrations/graph";
import { previewMatches } from "@scout/integrations/preview";
import { required } from "@/server/env";
import { authorizedBudget, body, route } from "@/server/http";

export const maxDuration = 60;

export const POST = route(async (request) => {
  const spec = await body(request, WatchSpecSchema);

  await authorizedBudget("preview", 10, 3600);

  const to = Math.floor(Date.now() / 1000);
  const history = await new GraphAdapter(
    required("GRAPH_API_KEY"),
    process.env.GRAPH_SUBGRAPH_ID,
  ).history(spec.pools, to - 86400, to, 250);
  const verified = await previewMatches(
    spec,
    history.swaps,
    required("ETHEREUM_RPC_URL"),
  );

  return {
    status: "partial",
    verified,
    from: history.from,
    to,
    refreshedAt: history.refreshedAt,
    block: history._meta.block,
    subgraphId: history.subgraphId,
    swaps: history.swaps
      .filter(
        (swap) =>
          spec.streamDirection === "either" ||
          (!(
            spec.sellToken === TOKENS[0].address ? swap.amount1 : swap.amount0
          ).startsWith("-") &&
            /[1-9]/.test(
              spec.sellToken === TOKENS[0].address
                ? swap.amount1
                : swap.amount0,
            )),
      )
      .slice(0, 8),
    sampled: history.swaps.length,
    note: spec.conditions.some((condition) => condition.kind === "aggregate")
      ? "This Graph sample cannot establish complete observation-window coverage. Aggregate and baseline rules are not evaluated here; zero preview matches does not mean no qualifying activity. Full comparisons run on the persisted Substreams history. Activity amounts listed below remain Graph estimates."
      : "Up to 12 recent Graph events were checked against finalized transaction identity, attribution and Chainlink prices at their blocks. Matches apply the exact rule to that incomplete sample. Missing events can hide matches; this is not a full backtest or a prediction of alert volume. Activity amounts listed below remain Graph estimates.",
  };
});
