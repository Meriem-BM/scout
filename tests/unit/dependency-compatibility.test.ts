import { createRequire } from "node:module";

import { expect, it } from "vitest";

import type * as NodeFs from "node:fs";
import type * as NodePath from "node:path";

const require = createRequire(import.meta.url);

it("the wallet URL decoder keeps CommonJS and legacy decoding semantics with bounded malformed input", () => {
  const privy = createRequire(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  const auth = createRequire(privy.resolve("@privy-io/react-auth"));
  // Resolve via the installed transitive package directory so the assertion
  // exercises pnpm's patched artifact, not a copied test implementation.
  const { readdirSync } = require("node:fs") as typeof NodeFs;
  const { resolve } = require("node:path") as typeof NodePath;
  const folder = readdirSync("node_modules/.pnpm").find((name) =>
    name.startsWith("decode-uri-component@0.2.2_patch_hash="),
  );

  expect(folder).toBeTruthy();

  const decode = auth(
    resolve("node_modules/.pnpm", folder!, "node_modules/decode-uri-component"),
  ) as (text: string) => string;

  expect(decode("hello+world%20%E2%82%AC")).toBe("hello world €");
  expect(decode("%C3%A5%FF%C3%A4")).toBe("å%FFä");
  expect(decode("%FF".repeat(20_000))).toBe("%FF".repeat(20_000));
  expect(() => decode(null as unknown as string)).toThrow(TypeError);
});
