/**
 * The canonical RuleSync source the Console's editors read and write.
 *
 * The Control API fixture does not simulate the canonical source: it is one.
 * A temporary repository root holds `.rulesync/commands` and `.rulesync/skills`,
 * and every read and write goes through the product's own `RuleSyncRepository`.
 * The revision a browser acceptance compares is therefore the revision the
 * Runtime compares -- the sha256 of the canonical file -- and a conflict is
 * raised by the rule that raises it in production rather than by a fixture that
 * re-implements the rule and can drift from it.
 *
 * The Runtime's own apply step is not repeated here: the fixture applies the
 * canonical source it was given and reports the two states the Runtime reports
 * separately, a conflict and a projection apply that failed after the source
 * was saved.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type RuleSyncCommand,
  RuleSyncCommandConflictError,
  RuleSyncCommandValidationError,
  RuleSyncRepository,
  RuleSyncSkillConflictError,
  type RuleSyncSkillSource,
  RuleSyncSkillValidationError} from "@simulatorlife/autodev-data";

/** The two canonical sources the Console edits. */
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

/** The body a revision-checked write carries. */
export interface CanonicalSourceWrite {
  readonly content: string;
  readonly expectedRevision: string;
}

/**
 * The outcome of a revision-checked write.
 *
 * `applied` is the only outcome that lets the Console claim the source was
 * saved. `apply-failed` is deliberately *not* the same answer: the Runtime
 * saves the canonical source first and only then generates and applies the
 * projections, so a failure there leaves the source saved and the Console
 * unsure whether the change took effect.
 */
export type CanonicalSourceWriteOutcome =
  | { readonly kind: "invalid-body" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "invalid-source"; readonly message: string }
  | { readonly kind: "apply-failed"; readonly message: string }
  | {
      readonly kind: "applied";
      readonly source: CanonicalSource;
      readonly changed: boolean;
    };

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
/**
 * The sources whose next apply must fail.
 *
 * The Runtime saves the canonical source and then applies the projections, so
 * the failure this records happens *after* the save: the source is written and
 * the projections are not.
 */
const applyFailures = new Set<CanonicalSourceKind>();

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
 * Writes a canonical source the way the Runtime does: compare-and-swap
 * against the revision the caller loaded, then apply.
 */
export async function applyCanonicalSourceWrite(
  kind: CanonicalSourceKind,
  name: string,
  write: CanonicalSourceWrite
): Promise<CanonicalSourceWriteOutcome> {
  if (!write.expectedRevision || !write.content) {
    return { kind: "invalid-body" };
  }
  const source = canonicalRepository();
  try {
    const updated =
      kind === "skill"
        ? await source.updateSkillSource({
            name,
            expectedRevision: write.expectedRevision,
            content: write.content
          })
        : await source.updateCommand({
            name,
            expectedRevision: write.expectedRevision,
            content: write.content
          });
    if (applyFailures.delete(kind)) {
      return {
        kind: "apply-failed",
        message:
          kind === "skill"
            ? "Canonical skill source was updated, but RuleSync projection generation or verification failed. Reload the current source before retrying."
            : "Canonical source was updated, but RuleSync generation or projection apply failed. Reload the prompt before retrying."
      };
    }
    return {
      kind: "applied",
      source: canonicalSource(kind, updated.name) ?? {
        kind,
        name: updated.name,
        path: updated.path,
        content: updated.content,
        revision: updated.revision,
        preview: null
      },
      changed: updated.revision !== write.expectedRevision
    };
  } catch (error) {
    if (
      error instanceof RuleSyncCommandConflictError ||
      error instanceof RuleSyncSkillConflictError
    ) {
      return { kind: "conflict", message: error.message };
    }
    if (
      error instanceof RuleSyncCommandValidationError ||
      error instanceof RuleSyncSkillValidationError
    ) {
      return { kind: "invalid-source", message: error.message };
    }
    throw error;
  }
}

/**
 * Changes a canonical source behind the Console's back.
 *
 * The Console loaded a revision; the source has moved on since. The write it
 * sends carries the old revision, and the service refuses it -- which is the
 * state a compare-and-swap exists for.
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

/**
 * Arms the projection apply to fail for the next write of this kind.
 *
 * The Runtime saves the canonical source before it applies the projections, so
 * the failure this produces leaves the source saved and the projections stale.
 */
export function armCanonicalSourceApplyFailure(
  kind: CanonicalSourceKind
): void {
  applyFailures.add(kind);
}

/** Puts the canonical sources back the way the fixture found them. */
export function resetCanonicalSources(): void {
  applyFailures.clear();
  for (const source of INITIAL_SOURCES) {
    writeFileSync(
      path.join(canonicalRoot(), source.path),
      source.content,
      "utf8"
    );
  }
}
