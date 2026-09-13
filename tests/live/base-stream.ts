import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { connectDatabase } from "@scout/database";
import { BASE_USDC, TRANSFER_SIGNATURE } from "@scout/domain";
import {
  baseRpc,
  normalizeTransfers,
  transferAbi,
} from "@scout/integrations/erc20";
import { consumeOutput } from "@scout/integrations/substreams";

import { withSubstreamsSession } from "../../apps/worker/src/pipeline/sessions";

const sql = connectDatabase(process.env.DATABASE_URL!, 2);

try {
  await withSubstreamsSession(
    sql,
    2,
    "verification",
    AbortSignal.timeout(120000),
    async (signal) => {
      const rpc = baseRpc(
        process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
      );

      assert.equal(await rpc.getChainId(), 8453);

      const head = await rpc.getBlock({ blockTag: "finalized" });
      const start = head.number - 5n;
      const events = [];

      for await (const block of consumeOutput({
        endpoint:
          process.env.BASE_SUBSTREAMS_ENDPOINT ??
          "https://base-mainnet.streamingfast.io:443",
        apiKey: process.env.SUBSTREAMS_API_KEY,
        token: process.env.SUBSTREAMS_API_TOKEN,
        packageBytes: await readFile("substreams/vendor/ethereum-common.spkg"),
        network: "base",
        outputModule: "filtered_events",
        parameters: [
          {
            module: "filtered_events",
            name: "query",
            value: `evt_addr:${BASE_USDC} && evt_sig:${TRANSFER_SIGNATURE}`,
          },
        ],
        startBlock: String(start),
        stopBlock: String(head.number + 1n),
        signal,
      })) {
        if (block.type === "undo") {
          throw Error("undo");
        }

        events.push(...(await normalizeTransfers(block, rpc)));
      }

      const reference = await rpc.getLogs({
        address: BASE_USDC,
        event: transferAbi,
        fromBlock: start,
        toBlock: head.number,
      });

      assert(events.length > 0);
      assert.deepEqual(
        new Set(events.map((e) => `${e.transaction.hash}:${e.eventIndex}`)),
        new Set(reference.map((e) => `${e.transactionHash}:${e.logIndex}`)),
      );
      console.log(
        JSON.stringify({
          test: "real_base_substreams",
          from: String(start),
          through: String(head.number),
          events: events.length,
          reference: reference.length,
          unique: new Set(events.map((e) => e.id)).size,
          largestMicros: events
            .reduce(
              (a, e) =>
                BigInt(e.value!.usdMicros) > a ? BigInt(e.value!.usdMicros) : a,
              0n,
            )
            .toString(),
          deliveryAttempted: false,
        }),
      );
    },
  );
} finally {
  await sql.end();
}
