import type { AgentRole } from "../agents/types.ts";
import type { SkillScope } from "./scope.ts";

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

/**
 * A skill in the catalogue, together with where it is installed.
 *
 * The catalogue says a skill exists; the scope says whether any agent can
 * reach it. A skill that is in the catalogue and nowhere else is a
 * configuration defect rather than a live skill, and a Console that shows the
 * two as the same thing is showing the operator a skill that no role can
 * invoke.
 */
export interface ScopedSkillDefinition extends SkillDefinition {
  /** Where the skill is installed, or `null` when it is not installed anywhere. */
  readonly scope: SkillScope | null;
  /** The directory the skill was found in. */
  readonly scopeLocation: string | null;
  /**
   * The workspace a repo-scoped skill belongs to.
   *
   * `null` for every other scope, and for a repo-scoped skill whose
   * repository is not one of the configured workspaces.
   */
  readonly workspace: string | null;
}

export interface SkillEligibility {
  readonly skill: string;
  readonly roles: readonly AgentRole[];
  readonly workspaces?: readonly string[];
}

export type SkillState =
  "configured" | "eligible" | "exposed" | "used" | "unavailable" | "error";

export function isSkillEligibleForRole(
  skill: string,
  role: string,
  eligibilityList: readonly SkillEligibility[]
): boolean {
  return eligibilityList.some(
    (e) => e.skill === skill && (e.roles as readonly string[]).includes(role)
  );
}
