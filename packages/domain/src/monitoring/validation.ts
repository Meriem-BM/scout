import {
  DATA_CAPABILITIES,
  type DataCapability,
  planProgramCapabilities,
} from "./capabilities";
import { WatchProgramSchema } from "./program";

/** Does not grant deployment authority. Runtime proofs and account bindings are
 * separate gates. No model-supplied support/confidence flag is accepted. */
export function validateProgram(
  input: unknown,
  registry: readonly DataCapability[] = DATA_CAPABILITIES,
) {
  const parsed = WatchProgramSchema.safeParse(input);

  if (!parsed.success) {
    return {
      status: "INVALID_PROGRAM" as const,
      issues: parsed.error.issues.map((issue) => issue.message),
      program: null,
      capabilityPlan: null,
    };
  }

  const capabilityPlan = planProgramCapabilities(
    parsed.data,
    undefined,
    registry,
  );
  const unavailableFields = capabilityPlan.dependencies.filter(
    (d) =>
      d.capability.startsWith("field:") &&
      !["AVAILABLE", "AVAILABLE_WITH_PARAMETERS"].includes(d.status),
  );
  const status =
    unavailableFields.length && capabilityPlan.adapterId
      ? ("INVALID_PROGRAM" as const)
      : capabilityPlan.status === "UNSUPPORTED"
        ? ("UNSUPPORTED" as const)
        : capabilityPlan.status === "NEEDS_CLARIFICATION"
          ? ("NEEDS_CLARIFICATION" as const)
          : !capabilityPlan.adapterId
            ? ("NEEDS_PIPELINE" as const)
            : ("PROGRAM_VALIDATED" as const);

  return {
    status,
    program: parsed.data,
    capabilityPlan,
    issues: capabilityPlan.dependencies
      .filter((d) =>
        [
          "UNSUPPORTED",
          "REQUIRES_CLARIFICATION",
          "REQUIRES_DATA_PIPELINE",
        ].includes(d.status),
      )
      .map((d) => `${d.capability}: ${d.reason}`),
  };
}

export function requireValidatedProgram(input: unknown) {
  const result = validateProgram(input);

  if (result.status !== "PROGRAM_VALIDATED" || !result.program) {
    throw new Error(`${result.status}: ${result.issues.join("; ")}`);
  }

  return result;
}
