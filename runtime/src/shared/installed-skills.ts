import { homedir } from "node:os";
import path from "node:path";

/**
 * The directory a user-level skill is installed at.
 *
 * The installer links each canonical `.rulesync/skills/<name>` directory into
 * `$HOME/.agents/skills/<name>`, the directory Codex discovers skills from, so
 * this is the one location where a skill's `SKILL.md` and the `references/`
 * it names by relative path are installed together. Runtime code that points
 * an agent at a skill must use this directory: the materialized runtime tree
 * under `$CODEX_HOME` carries no skills.
 *
 * `home` is read at call time so a process (or test) that sets `HOME` gets its
 * own installed skills.
 */
export function installedSkillDirectory(
  name: string,
  home: string = homedir()
): string {
  return path.join(home, ".agents", "skills", name);
}
