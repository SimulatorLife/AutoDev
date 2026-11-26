/**
 * The canonical RuleSync source the Console reads.
 *
 * The Control API fixture does not simulate the canonical source: it is one.
 * A temporary repository root holds `.rulesync/commands` and `.rulesync/skills`,
 * and every read goes through the product's own `RuleSyncRepository`. The
 * revision a browser acceptance compares is therefore the revision the Runtime
 * compares -- the sha256 of the canonical file -- rather than one a fixture
 * invented.
 *
 * The source is read, never written: the canonical declaration is edited in the
 * repository and applied from there, so the fixture offers a source to read and
 * a way to move it behind the Console's back, and no way to rewrite it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type RuleSyncCommand,
  RuleSyncRepository,
  type RuleSyncSkillSource
} from "@simulatorlife/autodev-data";

/** The two canonical sources the Console shows. */
export type CanonicalSourceKind = "prompt" | "skill";

/** A canonical source as the Control API serves it. */
export interface CanonicalSource {
  readonly kind: CanonicalSourceKind;
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly revision: string;
  /** The body without the frontmatter; `null` for a source that has none. */
  readonly preview: string | null;
}

const COMMAND_SOURCE = `---
name: review
description: Review the pending diff and report what changed.
---

Review the pending diff and report what changed.
`;

const SKILL_SOURCE = `---
name: code-review
description: Review a diff for defects.
---

Review a diff for defects.
`;

const INITIAL_SOURCES: readonly {
  readonly kind: CanonicalSourceKind;
  readonly name: string;
  readonly path: string;
  readonly content: string;
}[] = [
  {
    kind: "prompt",
    name: "review",
    path: ".rulesync/commands/review.md",
    content: COMMAND_SOURCE
  },
  {
    kind: "skill",
    name: "code-review",
    path: ".rulesync/skills/code-review/SKILL.md",
    content: SKILL_SOURCE
  }
];

let repositoryRoot: string | null = null;
let repository: RuleSyncRepository | null = null;
function canonicalRoot(): string {
  if (repositoryRoot !== null) return repositoryRoot;
  const root = mkdtempSync(path.join(tmpdir(), "autodev-canonical-source-"));
  mkdirSync(path.join(root, ".rulesync", "commands"), { recursive: true });
  mkdirSync(path.join(root, ".rulesync", "skills"), { recursive: true });
  for (const source of INITIAL_SOURCES) {
    const target = path.join(root, source.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source.content, "utf8");
  }
  repositoryRoot = root;
  repository = new RuleSyncRepository(root);
  return root;
}

function canonicalRepository(): RuleSyncRepository {
  canonicalRoot();
  if (repository === null)
    throw new Error("The canonical source is unreachable.");
  return repository;
}

/** The canonical source as it stands now, or `null` when there is none. */
export function canonicalSource(
  kind: CanonicalSourceKind,
  name: string
): CanonicalSource | null {
  const source = canonicalRepository();
  if (kind === "skill") {
    try {
      const skill: RuleSyncSkillSource = source.readSkillSource(name);
      return {
        kind,
        name: skill.name,
        path: skill.path,
        content: skill.content,
        revision: skill.revision,
        preview: null
      };
    } catch {
      return null;
    }
  }
  const command = source
    .loadCommands()
    .commands.find((candidate: RuleSyncCommand) => candidate.name === name);
  if (command === undefined) return null;
  return {
    kind,
    name: command.name,
    path: command.path,
    content: command.content,
    revision: command.revision,
    preview: command.prompt
  };
}

/**
 * Changes a canonical source behind the Console's back.
 *
 * The page that has the source open holds the revision it was rendered with,
 * so moving the source here is what makes the page's copy stale rather than a
 * silent overwrite of somebody else's edit.
 */
export function moveCanonicalSource(
  kind: CanonicalSourceKind,
  name: string
): CanonicalSource | null {
  const current = canonicalSource(kind, name);
  if (current === null) return null;
  const moved = `${current.content}\nMoved by another editor.\n`;
  const target = path.join(canonicalRoot(), current.path);
  writeFileSync(target, moved, "utf8");
  return canonicalSource(kind, name);
}

/** Puts the canonical sources back the way the fixture found them. */
export function resetCanonicalSources(): void {
  for (const source of INITIAL_SOURCES) {
    writeFileSync(
      path.join(canonicalRoot(), source.path),
      source.content,
      "utf8"
    );
  }
}
