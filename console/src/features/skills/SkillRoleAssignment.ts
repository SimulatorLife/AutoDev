import type {
  ConvergenceStatus,
  SkillDefinition
} from "@simulatorlife/autodev-core";

/** Why an immediate skill-assignment mutation did not persist. */
export type SkillAssignmentSaveOutcome =
  | "conflict"
  | "validation"
  | "wrong-workspace"
  | "not-found"
  | "failed"
  | "pending"
  | "not-observed"
  | "unconfirmed";

const SAVE_OUTCOME_BY_CONVERGENCE: Readonly<
  Record<ConvergenceStatus, SkillAssignmentSaveOutcome | undefined>
> = {
  converged: undefined,
  pending: "pending",
  "not-observed": "not-observed",
  error: "unconfirmed"
};

/** Map the Runtime's reconciliation result to the page return state. */
export function saveOutcomeForConvergence(
  convergence: ConvergenceStatus
): SkillAssignmentSaveOutcome | undefined {
  return SAVE_OUTCOME_BY_CONVERGENCE[convergence];
}

export function skillSaveOutcome(
  value: string | readonly string[] | undefined
): SkillAssignmentSaveOutcome | undefined {
  const outcome = typeof value === "string" ? value : value?.[0];
  return outcome === "conflict" ||
    outcome === "validation" ||
    outcome === "wrong-workspace" ||
    outcome === "not-found" ||
    outcome === "failed" ||
    outcome === "pending" ||
    outcome === "not-observed" ||
    outcome === "unconfirmed"
    ? outcome
    : undefined;
}

export const SAVE_OUTCOME_MESSAGES: Readonly<
  Record<SkillAssignmentSaveOutcome, string>
> = {
  conflict:
    "The execution contract changed after this page was loaded, so nothing was written. Reload to see the current assignments and try again.",
  validation:
    "The execution contract refused that assignment, so nothing was written. One of these roles may no longer exist in it.",
  "wrong-workspace":
    "The execution contract refused that assignment because of the workspace it named, so nothing was written. A skill installed inside a repository can only be assigned inside that repository's workspace, and a skill installed anywhere else is assigned globally.",
  "not-found":
    "That skill is not in the RuleSync catalog any more, so nothing was written. Reload to see the current catalog.",
  failed:
    "The assignment request could not be completed. Reload to inspect the current roles before trying again.",
  pending:
    "The desired role set was written, but the Runtime currently reports a different role set. Review the observed roles before retrying.",
  "not-observed":
    "The desired role set was written, but the Runtime returned no actual role observation. Reload before retrying; an empty role set is not a confirmed unassignment.",
  unconfirmed:
    "The response could not confirm whether the assignment was applied. Reload to inspect observed roles before retrying."
};

/** Why assignment controls are absent for every skill in the current source. */
export function assignmentUnavailableReason({
  executionContractRevision,
  assignmentRoles,
  skills,
  sourceValidity
}: {
  readonly executionContractRevision: string | null;
  readonly assignmentRoles: readonly string[];
  readonly skills: readonly SkillDefinition[];
  readonly sourceValidity: boolean | null;
}): string | null {
  if (executionContractRevision === null) {
    return "No execution contract was found, so no skill can be assigned to a role. Roles are declared there, and there is nothing to edit.";
  }
  if (assignmentRoles.length === 0) {
    return "The execution contract declares no roles, so there is nothing to assign a skill to.";
  }
  if (sourceValidity === false) {
    return "The RuleSync skill catalog is invalid, so the skills that could be assigned are not known.";
  }
  if (skills.length === 0) {
    return "No skills are in the catalog, so there is nothing to assign.";
  }
  return null;
}
