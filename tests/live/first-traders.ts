import { readFile, writeFile } from "node:fs/promises";

import { ethereum } from "@scout/integrations/ethereum";
import { DEFAULT_SUBGRAPH_ID, GraphAdapter } from "@scout/integrations/graph";

const saved = JSON.parse(
  await readFile(".scout/evidence/correctness/uniswap-decisions.json", "utf8"),
);
const graph = new GraphAdapter(
  process.env.GRAPH_API_KEY!,
  process.env.GRAPH_SUBGRAPH_ID,
);
const rpc = ethereum(process.env.ETHEREUM_RPC_URL!);
const results = [];

for (const existing of saved.results) {
  try {
    const response = await fetch(
      `https://gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/${process.env.GRAPH_SUBGRAPH_ID ?? DEFAULT_SUBGRAPH_ID}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{swaps(block:{hash:"${existing.prior.blockHash}"},first:1,orderBy:timestamp,orderDirection:asc,where:{origin:"${existing.actor}"}){origin timestamp logIndex amountUSD amount0 amount1 pool{id} transaction{id blockNumber}}}`,
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    const body = await response.json();

    if (body.errors) {
      results.push({
        actor: existing.actor,
        error: "Graph earliest query unavailable",
      });
      continue;
    }

    const swap = body.data.swaps[0];
    const receipt = await rpc.getTransactionReceipt({
      hash: swap.transaction.id,
    });
    const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
    const prior = await graph.checkPriorActivity({
      initiator: receipt.from,
      transactionHash: swap.transaction.id,
      blockNumber: String(block.number),
      blockHash: block.hash,
      timestamp: Number(block.timestamp),
      logIndex: Number(swap.logIndex),
    });

    results.push({ swap, prior });
  } catch {
    results.push({
      actor: existing.actor,
      error: "Historical query unavailable",
    });
  }

  console.log(JSON.stringify(results.at(-1)));
}

await writeFile(
  ".scout/evidence/correctness/first-traders.json",
  JSON.stringify(results, null, 2),
);
