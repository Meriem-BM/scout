export function GET() {
  return Response.json(
    { status: "alive", service: "scout-web" },
    { headers: { "cache-control": "no-store" } },
  );
}
