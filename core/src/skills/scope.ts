/**
 * Where a skill lives, and therefore who can reach it.
 *
 * A skill's scope is not a setting and not a label: it is a fact about where
 * the skill is on disk, read live. Codex looks for skills in a fixed
 * hierarchy, and the copy with the highest precedence is the one an agent
 * gets. The Console shows that hierarchy so the operator can see why a skill
 * is reachable by some roles and not by others -- a skill that is not
 * installed anywhere cannot be reached by anybody, no matter which roles the
 * contract assigns it to.
 *
 * The hierarchy, in the order Codex prefers them:
 *
 *   repo    <repository>/.agents/skills/<name>  the project this runtime is
 *                                                installed in
 *   user    $HOME/.agents/skills/<name>         the operator's own skills
 *   user    $CODEX_HOME/skills/<name>           the operator's Codex home
 *   admin   /etc/codex/skills/<name>            the machine's shared skills
 *   system  $CODEX_HOME/skills/.system/<name>   the skills Codex ships with
 *
 * A repo-scoped skill belongs to the workspace whose repository it lives in,
 * so it is that workspace's skill and no other workspace's. The workspace is
 * read from the repository itself (its git remote), never from a setting:
 * a workspace-scoped skill is a fact about where the skill is, and the
 * operator does not get to say otherwise.
 */

export type SkillScope = "repo" | "user" | "admin" | "system";

/**
 * The machine's shared skills.
 *
 * Codex reads them from `/etc/codex/skills`, and the directory does not exist
 * on a machine that has not been set up for it. The path is a constant rather
 * than a root argument because it is the machine's, not the operator's: there
 * is no setting that moves it.
 */
export const ADMIN_SKILLS_DIRECTORY = "/etc/codex/skills";

/**
 * What the live read found for one skill.
 *
 * `scope` is `null` on a skill that is not installed anywhere, and that is a
 * fact worth showing: a skill in the canonical catalog that no agent can
 * reach is a configuration defect, and the Console says so rather than
 * listing it as if it were live.
 */
export interface SkillScopeFacts {
  readonly scope: SkillScope;
  /** The directory the skill was found in. */
  readonly location: string;
  /**
   * The workspace a repo-scoped skill belongs to.
   *
   * `null` for every other scope, and for a repo-scoped skill whose
   * repository could not be attributed to a workspace -- an unattributed
   * repository is not the same as no workspace, and the Console has to be
   * able to say which one it is looking at.
   */
  readonly workspace: string | null;
}

export interface SkillScopeRoots {
  /** The operator's home directory. */
  readonly home: string;
  /** Codex's home directory, where its own skills live. */
  readonly codexHome: string;
  /** The repository this runtime is installed in. */
  readonly repositoryRoot: string;
}

/** One place a skill can be, and what that place means. */
export interface SkillScopeCandidate {
  readonly scope: SkillScope;
  /** The directory the skill would live in. */
  readonly directory: string;
}

/**
 * The directories Codex looks in for a skill, in the order it prefers them.
 *
 * The order is the answer: the first candidate that holds the skill is the
 * copy an agent gets, so a skill that exists in two places is one skill with
 * one scope, and the Console reports the one that wins.
 */
export function skillScopeCandidates(
  name: string,
  roots: SkillScopeRoots
): readonly SkillScopeCandidate[] {
  return [
    {
      scope: "repo",
      directory: `${roots.repositoryRoot}/.agents/skills/${name}`
    },
    { scope: "user", directory: `${roots.home}/.agents/skills/${name}` },
    { scope: "user", directory: `${roots.codexHome}/skills/${name}` },
    { scope: "admin", directory: `${ADMIN_SKILLS_DIRECTORY}/${name}` },
    {
      scope: "system",
      directory: `${roots.codexHome}/skills/.system/${name}`
    }
  ];
}
