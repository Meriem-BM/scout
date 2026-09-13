import { z } from "zod";

import { identity } from "@/server/auth";
import { HttpError } from "@/server/errors";
import { readWorkflow } from "@/server/workflow";

const encoder = new TextEncoder();
const encode = (event: string, value: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ watchId: string }> },
) {
  try {
    const auth = await identity();
    const { watchId } = await params;
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(new URL(request.url).searchParams.get("after") ?? 0);

    await readWorkflow(auth, watchId, after);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let cursor = after;
        let previousState = "";
        const deadline = Date.now() + 25_000;

        try {
          while (!request.signal.aborted && Date.now() < deadline) {
            const workflow = await readWorkflow(auth, watchId, cursor);

            if (workflow.events.length || workflow.state !== previousState) {
              controller.enqueue(encode("workflow", workflow));
              cursor = workflow.events.at(-1)?.sequence ?? cursor;
              previousState = workflow.state;
            } else {
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
            }

            if (
              ["LIVE", "FAILED", "NEEDS_CLARIFICATION"].includes(workflow.state)
            ) {
              break;
            }

            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (error) {
          controller.enqueue(
            encode("error", {
              error:
                error instanceof Error
                  ? error.message
                  : "Workflow stream interrupted.",
            }),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "private, no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Workflow stream is unavailable.",
      },
      { status: error instanceof HttpError ? error.status : 500 },
    );
  }
}
