import type { SkillDefinition } from "@simulatorlife/autodev-core";

/** Why an immediate skill-assignment mutation did not persist. */
export type SkillAssignmentSaveOutcome =
  | "conflict"
  | "validation"
  | "not-found"
  | "failed";

export function skillSaveOutcome(
  value: string | readonly string[] | undefined
): SkillAssignmentSaveOutcome | undefined {
  const outcome = typeof value === "string" ? value : value?.[0];
  return outcome === "conflict" ||
    outcome === "validation" ||
    outcome === "not-found" ||
    outcome === "failed"
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
  "not-found":
    "That skill is not in the RuleSync catalog any more, so nothing was written. Reload to see the current catalog.",
  failed: "The role assignment was not applied."
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
