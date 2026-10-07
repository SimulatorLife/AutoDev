import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { MemoryReadContext } from "@simulatorlife/autodev-core";

import {
  MemoryConflictError,
  MemoryValidationError
} from "../src/memory/service.ts";
import { RuleSyncMemorySkillPromoter } from "../src/memory/skill-promotion.ts";

/**
 * The promotion writer is the only place AutoDev memory crosses into canonical,
 * version-controlled RuleSync artifacts -- the boundary the target state names
 * when it says proven procedures must graduate into explicit skills. Every other
 * promotion test substitutes a stub writer, so nothing here was exercised: the
 * governance service could decide a procedure is promotable and the real writer
 * could still be wrong about where it writes or how it reports a refusal.
 *
 * These cases therefore run the real `RuleSyncRepository` against a real
 * directory rather than a double, and each fixture satisfies every *other*
 * precondition, so the guard under test is the only thing that can refuse.
 */

const repositoryContext: MemoryReadContext = {
  workspaceId: "workspace-a",
  repositoryId: "owner/repo",
  role: "worker",
  taskId: "task-current",
  runId: "run-current",
  agentId: "agent-current",
  canReadGlobal: false
};

/** The repository root RuleSync falls back to when it is handed no root at all. */
const AUTODEV_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SKILL = {
  name: "verified-memory-workflow",
  description: "A validated workflow.",
  content: "Re-check evidence and run focused tests."
} as const;

async function withRepositoryRoot<T>(
  run: (root: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "autodev-skill-promoter-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("a promoted procedure becomes a real canonical skill on disk", async () => {
  await withRepositoryRoot(async (root) => {
    const promoter = new RuleSyncMemorySkillPromoter({
      resolve: () => root
    });

    const artifact = await promoter.createSkill({
      ...SKILL,
      context: repositoryContext
    });

    assert.equal(
      artifact.path,
      ".rulesync/skills/verified-memory-workflow/SKILL.md"
    );
    assert.equal(
      artifact.uri,
      "rulesync://skills/verified-memory-workflow/SKILL.md"
    );
    // The stub writers every other promotion test uses fabricate this revision;
    // here it is the real hash of the file that was actually written.
    assert.match(artifact.revision, /^[a-f0-9]{64}$/u);
    const written = await readFile(path.join(root, artifact.path), "utf8");
    assert.match(written, /^---\nname: verified-memory-workflow$/mu);
    assert.ok(written.includes(SKILL.content));
  });
});

test("promotion refuses a context that names no repository, without consulting the resolver", async () => {
  await withRepositoryRoot(async (root) => {
    const asked: MemoryReadContext[] = [];
    // `repositoryId` is optional on the context, so an unscoped read is an
    // ordinary state the writer has to survive rather than a type error.
    const { repositoryId: _scoped, ...unscopedContext } = repositoryContext;
    // The resolver answers any context with a writable root, so it cannot be
    // what refuses. Only the promoter's own scope check can be.
    const promoter = new RuleSyncMemorySkillPromoter({
      resolve: (context) => {
        asked.push(context);
        return root;
      }
    });

    await assert.rejects(
      promoter.createSkill({
        ...SKILL,
        context: unscopedContext
      }),
      /requires an explicit repository scope/u
    );
    assert.deepEqual(
      asked,
      [],
      "an unscoped context is refused before any root is resolved"
    );
    assert.equal(
      await exists(path.join(root, ".rulesync")),
      false,
      "an unscoped context writes nothing"
    );
  });
});

test("promotion refuses when no trusted root resolves rather than falling back to a default", async () => {
  await withRepositoryRoot(async (root) => {
    const promoter = new RuleSyncMemorySkillPromoter({ resolve: () => null });

    await assert.rejects(
      promoter.createSkill({ ...SKILL, context: repositoryContext }),
      /No trusted repository root is available/u
    );
    assert.equal(await exists(path.join(root, ".rulesync")), false);
    // `RuleSyncRepository` defaults its root to the AutoDev checkout, so a
    // missing-root fallthrough would write a canonical skill into this
    // repository's own tracked `.rulesync` tree.
    assert.equal(
      await exists(path.join(AUTODEV_ROOT, ".rulesync", "skills", SKILL.name)),
      false,
      "no canonical skill is written into the AutoDev checkout"
    );
  });
});

test("a name already bound to different canonical content is a memory conflict, and the existing skill is not overwritten", async () => {
  await withRepositoryRoot(async (root) => {
    const promoter = new RuleSyncMemorySkillPromoter({
      resolve: () => root
    });
    await promoter.createSkill({ ...SKILL, context: repositoryContext });

    const failure = await promoter
      .createSkill({
        ...SKILL,
        content: "Different instructions for the same skill name.",
        context: repositoryContext
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    assert.ok(
      failure instanceof MemoryConflictError,
      "a name collision is a memory conflict, not a crash or a validation error"
    );
    const written = await readFile(
      path.join(root, ".rulesync/skills/verified-memory-workflow/SKILL.md"),
      "utf8"
    );
    assert.ok(
      written.includes(SKILL.content),
      "the canonical skill that already owns the name is left untouched"
    );
  });
});

test("a skill body RuleSync refuses is reported as validation, not an internal failure", async () => {
  await withRepositoryRoot(async (root) => {
    const promoter = new RuleSyncMemorySkillPromoter({
      resolve: () => root
    });

    // `promoteProcedureToSkill` bounds the name, description and content length
    // but not control characters, so this is a body that passes memory
    // governance and is refused by the canonical writer underneath it. Without
    // the translation the operator sees the MCP facade's generic
    // "Memory operation failed.", which is indistinguishable from a crash.
    const failure = await promoter
      .createSkill({
        ...SKILL,
        content: `Run the steps.\u0007`,
        context: repositoryContext
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    assert.ok(
      failure instanceof MemoryValidationError,
      `expected a memory validation error, received ${String(failure)}`
    );
    assert.equal(
      await exists(path.join(root, ".rulesync")),
      false,
      "a refused body leaves no partial canonical directory behind"
    );
  });
});
