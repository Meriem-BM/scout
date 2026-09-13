import { z } from "zod";

import { GroqAdapter } from "@scout/integrations/ai";
import { required } from "@/server/env";
import { authorizedBudget, body, route } from "@/server/http";

export const maxDuration = 30;

export const POST = route(async (request) => {
  const input = await body(
    request,
    z.object({ prompt: z.string().trim().min(10).max(2000) }),
  );

  await authorizedBudget("interpret", 10, 86400);

  return new GroqAdapter(
    required("GROQ_API_KEY"),
    process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
  ).interpret(input.prompt);
});
