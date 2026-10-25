import type {
  ScopedSkillDefinition,
  SkillScope
} from "@simulatorlife/autodev-core";

/**
 * The Console's word for each place a skill can be installed.
 *
 * Codex looks for a skill in a fixed hierarchy, and the copy with the highest
 * precedence is the one an agent gets. These are the words for those places:
 * the project this runtime is installed in, the operator's own skills, the
 * machine's shared skills, and the skills Codex ships with.
 */
export const SKILL_SCOPE_LABEL: Record<SkillScope, string> = {
  repo: "Repo",
  user: "User",
  admin: "Admin",
  system: "System"
};

/**
 * The Console's word for a skill that is in the catalogue and installed
 * nowhere.
 *
 * It is a fact about the machine rather than a state of the catalogue: the
 * catalogue says the skill exists, and the read says no agent can reach it.
 * A skill in that state is a configuration defect, not a live skill.
 */
export const NOT_INSTALLED_LABEL = "Not installed";

/**
 * The Console's word for a repo-scoped skill whose repository is not one of
 * the configured workspaces.
 *
 * An unattributed repository is not the same as no repository: the skill is
 * installed inside one, and that repository is not a workspace here, so there
 * is nowhere to assign it.
 */
export const UNATTRIBUTED_WORKSPACE_LABEL = "Not attributed to a workspace";

/**
 * The place a skill is installed, in the words the Console uses for it.
 *
 * A repo-scoped skill belongs to a workspace, so that is what the Console
 * names; every other scope is a directory on this machine, so that is what it
 * names. `null` is a skill that is installed nowhere.
 */
export function skillScopePlace(skill: ScopedSkillDefinition): string | null {
  if (skill.scope === null) return null;
  if (skill.scope === "repo") {
    return skill.workspace ?? UNATTRIBUTED_WORKSPACE_LABEL;
  }
  return skill.scopeLocation;
}
