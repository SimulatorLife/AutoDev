/**
Reading the canonical skill and command documents.

`.rulesync/skills/<name>/SKILL.md` and `.rulesync/commands/<name>.md` are
the only tracked sources for the skills and commands this repository
distributes. Their frontmatter carries the routing metadata (`name`,
`description`, `targets`), so the helpers here read that metadata rather
than each suite parsing it on its own.
*/

import { readFileSync } from "node:fs";
import path from "node:path";

export interface SkillDocument {
  readonly front: string;
  readonly body: string;
}

const FRONTMATTER_PATTERN = /^---\n(?<front>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u;
const DESCRIPTION_PATTERN = /^description:[ \t]*(?<value>\S.*)$/mu;
const FOLDED_DESCRIPTION_PATTERN = /^description:[ \t]*>-[ \t]*\n/mu;
const TARGETS_PATTERN = /^targets:[ \t]*\[(?<targets>[^\]]*)\][ \t]*$/mu;

/**
Split a canonical document into its frontmatter and its body.
*/
export function splitFrontmatter(text: string): SkillDocument {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match?.groups) {
    throw new Error("invalid document: missing frontmatter");
  }
  return {
    front: match.groups.front ?? "",
    body: (match.groups.body ?? "").replaceAll(/^\n+|\n+$/gu, "")
  };
}

/**
The `description` a document's frontmatter declares.
*/
export function frontmatterDescription(front: string): string {
  const folded = FOLDED_DESCRIPTION_PATTERN.exec(front);
  let value: string | undefined;
  if (folded) {
    const bodyLines: string[] = [];
    const remainder = front.slice(folded.index + folded[0].length);
    for (const line of remainder.split("\n")) {
      if (/^[ \t]/.test(line)) bodyLines.push(line);
      else break;
    }
    value = bodyLines.join("\n");
  } else {
    value = DESCRIPTION_PATTERN.exec(front)?.groups?.value;
  }
  if (value === undefined) {
    throw new Error("invalid document: missing description");
  }
  return value
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/^['"]|['"]$/gu, "");
}

/**
The targets a document's frontmatter names.

`null` means the document keeps RuleSync's default targets, which reach
every projection. An empty list means it reaches no projection at all: it
is installed at user level, so a repository copy would list it twice.
*/
export function declaredTargets(front: string): string[] | null {
  const match = TARGETS_PATTERN.exec(front);
  if (!match) return null;
  return (match.groups?.targets ?? "")
    .split(",")
    .map((target) => target.trim().replaceAll(/^['"]|['"]$/gu, ""))
    .filter(Boolean);
}

/**
The canonical skill document of `skill`.
*/
export function readSkill(
  repositoryRoot: string,
  skill: string
): SkillDocument {
  return splitFrontmatter(
    readFileSync(
      path.join(repositoryRoot, ".rulesync", "skills", skill, "SKILL.md"),
      "utf8"
    )
  );
}

/**
The canonical command document of `command`.
*/
export function readCommand(
  repositoryRoot: string,
  command: string
): SkillDocument {
  return splitFrontmatter(
    readFileSync(
      path.join(repositoryRoot, ".rulesync", "commands", `${command}.md`),
      "utf8"
    )
  );
}

/**
The headings a markdown body declares.
*/
export function headings(body: string): string[] {
  const titles: string[] = [];
  for (const line of body.split("\n")) {
    let marks = 0;
    while (marks < line.length && line[marks] === "#") marks += 1;
    if (marks === 0 || marks > 6) continue;
    const title = line.slice(marks).trim();
    if (title.length > 0) titles.push(title);
  }
  return titles;
}
