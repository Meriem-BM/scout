import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { z } from "zod";

const { stdout } = await promisify(execFile)(
  "pnpm",
  ["licenses", "list", "--json"],
  { maxBuffer: 10_000_000 },
);
const data = z
  .record(
    z.string(),
    z.array(
      z
        .object({
          name: z.string(),
          versions: z.array(z.string()),
          homepage: z.string().optional(),
          author: z.unknown().optional(),
          license: z.string().optional(),
        })
        .passthrough(),
    ),
  )
  .parse(JSON.parse(stdout));
// Do not publish machine paths from the package-manager report.
const entries = Object.entries(data)
  .flatMap(([license, packages]) =>
    packages.flatMap((item) =>
      item.versions.map((version) => ({
        name: item.name,
        version,
        license,
        homepage: item.homepage ?? null,
      })),
    ),
  )
  .sort((a, b) => a.name.localeCompare(b.name));

await writeFile(
  "docs/THIRD_PARTY.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString().slice(0, 10),
      source: "pnpm licenses list --json; installed lockfile",
      packages: entries,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Recorded ${entries.length} installed package licenses and provenance URLs.`,
);
