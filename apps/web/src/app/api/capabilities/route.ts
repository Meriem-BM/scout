import { getCapabilityCatalog } from "@scout/domain";

export function GET() {
  return Response.json(getCapabilityCatalog(), {
    headers: { "cache-control": "public, no-cache" },
  });
}
