import { identity } from "@/server/auth";
import { HttpError } from "@/server/errors";
import { readWorkflow } from "@/server/workflow";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ watchId: string }> },
) {
  try {
    const auth = await identity();
    const { watchId } = await params;

    return Response.json(await readWorkflow(auth, watchId), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Workflow could not be loaded.",
      },
      { status: error instanceof HttpError ? error.status : 500 },
    );
  }
}
