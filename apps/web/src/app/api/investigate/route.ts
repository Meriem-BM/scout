import { z } from "zod";

import { SnapshotSchema } from "@scout/domain";
import { evidenceExplanation, GroqAdapter } from "@scout/integrations/ai";
import { authorizedBudget, body, route } from "@/server/http";

export const maxDuration = 30;

export const POST = route(async (request) => {
  const input = await body(
    request,
    z.object({
      id: z.string().uuid(),
      question: z.string().trim().min(3).max(500),
    }),
  );
  const { client } = await authorizedBudget("investigate", 10, 86400);
  const { data, error } = await client.rpc("scout_snapshot");

  if (error) {
    throw new Error("Could not retrieve authorized evidence.");
  }

  const incident = SnapshotSchema.parse(data).incidents.find(
    (item) => item.id === input.id,
  );

  if (!incident) {
    throw new Error("Incident not found.");
  }

  if (!process.env.GROQ_API_KEY) {
    return {
      explanation: evidenceExplanation(incident),
      note: "AI is unavailable. This answer is limited to the recorded rule and evidence.",
    };
  }

  try {
    return {
      explanation: await new GroqAdapter(
        process.env.GROQ_API_KEY,
        process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
      ).explain(incident, input.question),
      note: null,
    };
  } catch {
    return {
      explanation: evidenceExplanation(incident),
      note: "The model did not respond. The deterministic evidence remains available.",
    };
  }
});
