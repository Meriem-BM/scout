import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

import { assertServer, IntegrationError } from "./http";
import { RawSwapSchema } from "./substreams";

const HistoricalOutputSchema = z.object({
  "@module": z.literal("map_watch"),
  "@block": z.number().int().nonnegative(),
  "@data": z.object({ swaps: z.array(RawSwapSchema).default([]) }),
});

export type HistoricalStreamBlock = {
  number: string;
  swaps: z.infer<typeof RawSwapSchema>[];
};

export type HistoricalStreamConfig = {
  endpoint: string;
  apiKey?: string;
  token?: string;
  substreamsBin: string;
  packageBytes: Uint8Array;
  startBlock: string;
  stopBlock: string;
  signal: AbortSignal;
};

function validateConfig(config: HistoricalStreamConfig) {
  const start = BigInt(config.startBlock);
  const stop = BigInt(config.stopBlock);
  const endpoint = new URL(config.endpoint);

  if (
    !/^\d{1,12}$/.test(config.startBlock) ||
    !/^\d{1,12}$/.test(config.stopBlock) ||
    stop <= start ||
    stop - start > 5_000n
  ) {
    throw new Error("Invalid bounded Substreams block range.");
  }

  if (
    endpoint.protocol !== "https:" ||
    !(
      endpoint.hostname === "mainnet.eth.streamingfast.io" ||
      endpoint.hostname.endsWith(".streamingfast.io") ||
      endpoint.hostname.endsWith(".substreams.pinax.network")
    )
  ) {
    throw new Error("Unsupported Substreams execution endpoint.");
  }

  if (
    config.substreamsBin !== "substreams" &&
    (!isAbsolute(config.substreamsBin) ||
      basename(config.substreamsBin) !== "substreams")
  ) {
    throw new Error(
      "SUBSTREAMS_BIN must resolve to the Substreams executable.",
    );
  }

  if (
    config.packageBytes.length < 1_000 ||
    config.packageBytes.length > 50_000_000
  ) {
    throw new Error("Invalid Substreams package size.");
  }
}

function safeCliError(value: string) {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, "[provider URL redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|authorization|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .trim()
    .slice(-2_000);
}

export async function* consumeHistorical(
  config: HistoricalStreamConfig,
): AsyncGenerator<HistoricalStreamBlock> {
  assertServer();
  validateConfig(config);

  if (config.signal.aborted) {
    throw config.signal.reason;
  }

  const directory = await mkdtemp(join(tmpdir(), "scout-substreams-run-"));
  const packagePath = join(directory, "pipeline.spkg");

  await writeFile(packagePath, config.packageBytes, { mode: 0o600 });

  const child = spawn(
    config.substreamsBin,
    [
      "run",
      packagePath,
      "map_watch",
      "--endpoint",
      config.endpoint,
      "--start-block",
      config.startBlock,
      "--stop-block",
      config.stopBlock,
      "--final-blocks-only",
      "--production-mode",
      "--force-protocol-version",
      "3",
      "--limit-processed-blocks",
      "5000",
      "--max-retries",
      "3",
      "--output",
      "jsonl",
    ],
    {
      cwd: directory,
      shell: false,
      env: {
        PATH: process.env.PATH,
        TMPDIR: directory,
        SUBSTREAMS_API_KEY: config.apiKey,
        SUBSTREAMS_API_TOKEN: config.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  let spawnError: Error | null = null;
  const completion = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve(null);
    });
    child.once("close", (code) => resolve(code));
  });
  const abort = () => child.kill("SIGTERM");

  config.signal.addEventListener("abort", abort, { once: true });
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString()}`.slice(-16_000);
  });

  try {
    const lines = createInterface({ input: child.stdout });

    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const output = HistoricalOutputSchema.parse(JSON.parse(line));

      yield {
        number: output["@block"].toString(),
        swaps: output["@data"].swaps,
      };
    }

    const exitCode = await completion;

    if (config.signal.aborted) {
      throw config.signal.reason;
    }

    if (spawnError) {
      throw spawnError;
    }

    if (exitCode !== 0) {
      const detail = safeCliError(diagnostics);

      if (
        /unauthenticated|invalid.*(?:key|token)|permission denied/i.test(detail)
      ) {
        throw new IntegrationError(
          "SUBSTREAMS_AUTHENTICATION",
          "The Graph rejected the Substreams data-plane credential. Authenticate the monitoring worker again, then retry this Watch.",
        );
      }

      throw new IntegrationError(
        "SUBSTREAMS_EXECUTION",
        detail
          ? `Substreams historical execution failed: ${detail}`
          : "Substreams historical execution failed without a provider diagnostic.",
        10,
      );
    }
  } finally {
    config.signal.removeEventListener("abort", abort);

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }

    await rm(directory, { recursive: true, force: true });
  }
}
