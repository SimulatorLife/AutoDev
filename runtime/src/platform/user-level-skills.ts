import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The canonical skills the installer links into `$HOME/.agents/skills`.
 *
 * A skill's own Rulesync frontmatter decides its reach, so the set is read
 * from the canonical source rather than kept as a second hand-written list
 * (which once omitted three skills that roles enable, leaving them reachable
 * by no agent). A skill that keeps Rulesync's default targets is
 * repository-only: Rulesync generates it into every repository skill folder
 * and it is never installed at user level. A skill that declares `targets`
 * (`[]`, or only `copilot`, whose cloud agent has no user level) reaches
 * local tools from the user level.
 */
const CURATED_SKILLS_DIR = ".curated";
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const TARGETS_KEY_PATTERN = /^targets\s*:/mu;

export function userLevelSkills(skillsRoot: string): string[] {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== CURATED_SKILLS_DIR)
    .map((entry) => entry.name)
    .filter((name) =>
      declaresTargets(
        readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8")
      )
    )
    .sort();
}

/** Whether a `SKILL.md`'s frontmatter declares a top-level `targets` key. */
function declaresTargets(document: string): boolean {
  const match = FRONTMATTER_PATTERN.exec(document);
  if (!match) throw new Error("invalid-skill-document missing frontmatter");
  return TARGETS_KEY_PATTERN.test(match[1]!);
}
