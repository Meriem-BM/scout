import { resolveWatchStarter } from "@scout/domain";
import { GroqAdapter } from "@scout/integrations/ai";
import { IntegrationError } from "@scout/integrations/http";

import type { WorkerConfig } from "../config";

export async function resolveWorkflowIntent(
  prompt: string,
  answers: Array<{ field: string; answer: string }>,
  config: Pick<WorkerConfig, "GROQ_API_KEY" | "GROQ_MODEL">,
) {
  const starter = answers.length === 0 ? resolveWatchStarter(prompt) : null;

  if (starter) {
    return {
      status: "READY" as const,
      intent: starter,
      clarification: null,
      unsupportedReason: null,
      supportedAlternative: null,
    };
  }

  if (!config.GROQ_API_KEY) {
    throw new IntegrationError(
      "GROQ_SETUP_REQUIRED",
      "Custom requests need the AI provider configured on the monitoring worker. You can use an unchanged supported example without AI intent resolution.",
    );
  }

  return new GroqAdapter(config.GROQ_API_KEY, config.GROQ_MODEL).resolveIntent(
    prompt,
    answers,
  );
}
