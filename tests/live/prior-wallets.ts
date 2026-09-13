import { mkdir, writeFile } from "node:fs/promises";

import { POOLS } from "@scout/domain";
import { ethereum } from "@scout/integrations/ethereum";
import { DEFAULT_SUBGRAPH_ID, GraphAdapter } from "@scout/integrations/graph";

const graph = new GraphAdapter(
  process.env.GRAPH_API_KEY!,
  process.env.GRAPH_SUBGRAPH_ID,
);
const endpoint = `https://gateway.thegraph.com/api/${process.env.GRAPH_API_KEY}/subgraphs/id/${process.env.GRAPH_SUBGRAPH_ID ?? DEFAULT_SUBGRAPH_ID}`;

async function query(query: string) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60000),
  });
  const v = await r.json();

  if (v.errors) {
    throw Error(JSON.stringify(v.errors));
  }

  return v.data;
}

type Swap = {
  origin: string;
  logIndex: string;
  timestamp: string;
  amountUSD: string;
  transaction: { id: `0x${string}`; blockNumber: string };
};

const { swaps } = (await query(
  `{swaps(first:30,orderBy:timestamp,orderDirection:desc,where:{pool_in:${JSON.stringify(POOLS.map((p) => p.address))},amountUSD_gt:100000,amount0_gt:0}){origin logIndex timestamp amountUSD transaction{id blockNumber}}}`,
)) as { swaps: Swap[] };
const origins = [...new Set(swaps.map((x) => x.origin))];
const firsts = await query(
  "{" +
    origins
      .map(
        (o, i) =>
          `a${i}:swaps(first:1,orderBy:timestamp,orderDirection:asc,where:{origin:"${o}"}){transaction{id} timestamp}`,
      )
      .join("\n") +
    "}",
);
const chosen = swaps.filter(
  (s) =>
    firsts["a" + origins.indexOf(s.origin)]?.[0]?.transaction.id ===
    s.transaction.id,
);
const rpc = ethereum(process.env.ETHEREUM_RPC_URL!);
const results = [];

for (const swap of [...chosen.slice(0, 2), swaps[0]!]) {
  const receipt = await rpc.getTransactionReceipt({
    hash: swap.transaction.id,
  });
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
  const anchor = {
    initiator: receipt.from,
    transactionHash: swap.transaction.id,
    blockNumber: String(block.number),
    blockHash: block.hash,
    timestamp: Number(block.timestamp),
    logIndex: Number(swap.logIndex),
  };

  results.push({
    anchor,
    graphAmountUSD: swap.amountUSD,
    prior: await graph.checkPriorActivity(anchor),
    deliveryAttempted: false,
  });
}

await mkdir(".scout/evidence/correctness", { recursive: true });
await writeFile(
  ".scout/evidence/correctness/prior-wallets.json",
  JSON.stringify(
    {
      searched: swaps.length,
      origins: origins.length,
      firstCandidates: chosen.length,
      results,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    searched: swaps.length,
    origins: origins.length,
    firstCandidates: chosen.length,
    results,
  }),
);
