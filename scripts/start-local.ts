import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Docker Desktop may not read macOS protected Documents folders. Stage only trusted
// public local configuration at a stable path so restarted containers keep
// valid bind mounts. Persistent data stays in named Docker volumes.
const stage = join(tmpdir(), "scout-supabase-local");

await mkdir(join(stage, "supabase"), { recursive: true });

for (const entry of ["config.toml", "seed.sql", "migrations"]) {
  await cp(resolve("supabase", entry), join(stage, "supabase", entry), {
    recursive: true,
  });
}

// Database isolation tests need disposable Supabase identities. Enable their
// login provider only in the staged CI configuration; Scout uses Privy.
if (process.env.CI === "true" && process.env.SCOUT_TEST_EMAIL_AUTH === "1") {
  const configPath = join(stage, "supabase", "config.toml");
  const config = await readFile(configPath, "utf8");

  await writeFile(
    configPath,
    config.replace(
      "[auth.email]\nenable_signup = false",
      "[auth.email]\nenable_signup = true",
    ),
  );
}

console.log(
  "Starting local Supabase from a temporary configuration copy. Database/storage volumes are preserved; no repository secrets were copied.",
);

const child = spawn(
  "pnpm",
  [
    "exec",
    "supabase",
    "start",
    "--workdir",
    stage,
    "-x",
    "studio,edge-runtime,logflare,vector,imgproxy",
  ],
  { stdio: "inherit" },
);

child.on("error", () => {
  console.error("Could not launch the pinned Supabase CLI.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
