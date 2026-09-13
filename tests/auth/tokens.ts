import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

export const testKeys = () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" });

export function testJwt(
  key: KeyObject,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT" },
) {
  const body = [header, claims]
    .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
    .join(".");

  return `${body}.${sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
