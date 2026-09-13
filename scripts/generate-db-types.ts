import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const { stdout } = await promisify(execFile)(
  "pnpm",
  [
    "exec",
    "supabase",
    "gen",
    "types",
    "typescript",
    "--local",
    "--schema",
    "public",
  ],
  { maxBuffer: 8_000_000 },
);

if (!stdout.includes("export type Database")) {
  throw new Error("Database type generation failed.");
}

await writeFile(
  "packages/database/src/database.types.ts",
  `${stdout.trimEnd()}\n`,
);
console.log("Generated database types from the local migrated schema.");
