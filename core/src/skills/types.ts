import type { AgentRole } from "../agents/types.ts";

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly path: string;
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
