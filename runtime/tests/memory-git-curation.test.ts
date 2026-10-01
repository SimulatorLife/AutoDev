import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type {
  EvidenceReference,
  MemoryReadContext,
  MemoryRecord
} from "@simulatorlife/autodev-core";

import {
  GitWorkingTreeMemoryVerifier,
  VerifiedMemoryReconstructor
} from "../src/memory/git-curation.ts";

const context: MemoryReadContext = {
  workspaceId: "workspace-a",
  repositoryId: "owner/repo",
  role: "worker",
  taskId: "task-current",
  runId: "run-current",
  agentId: "agent-current",
  canReadGlobal: false
};

async function withGitRepository(
  run: (input: {
    root: string;
    sourceCommit: string;
    filePath: string;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "autodev-memory-git-"));
  try {
    await mkdir(join(root, "src"));
    const filePath = join(root, "src", "feature.ts");
    await writeFile(filePath, "export const feature = true;\n");
    execGit(root, ["init", "-q"]);
    execGit(root, ["config", "user.name", "AutoDev Memory Tests"]);
    execGit(root, ["config", "user.email", "memory-tests@example.invalid"]);
    execGit(root, ["add", "src/feature.ts"]);
    execGit(root, ["commit", "-q", "-m", "Add feature"]);
    const sourceCommit = execGit(root, ["rev-parse", "HEAD"]);
    await run({ root, sourceCommit, filePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function execGit(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function recordWithEvidence(
  evidence: readonly EvidenceReference[]
): MemoryRecord {
  const createdAt = "2026-09-30T12:00:00.000Z";
  return {
    id: "memory-git-evidence",
    kind: "semantic",
    scope: {
      kind: "repository",
      workspaceId: context.workspaceId,
      repositoryId: context.repositoryId!
    },
    claim: "The source feature flag defaults to enabled.",
    status: "active",
    provenance: {
      experienceIds: ["experience-source"],
      evidence,
      createdBy: "root",
      createdAt,
      lastVerifiedAt: createdAt,
      verificationSource: "prior-reviewed-run"
    },
    validity: {
      state: "verified",
      checkedAt: createdAt,
      verificationSource: "prior-reviewed-run",
      evidence
    },
    createdAt,
    updatedAt: createdAt
  };
}

test("Git verifier retains evidence when the cited commit is ancestral and cited files are unchanged", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    await writeFile(join(root, "README.md"), "Unrelated later change.\n");
    execGit(root, ["add", "README.md"]);
    execGit(root, ["commit", "-q", "-m", "Update unrelated documentation"]);
    const head = execGit(root, ["rev-parse", "HEAD"]);
    const fileEvidence: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(filePath).href,
      revision: sourceCommit
    };
    const commitEvidence: EvidenceReference = {
      kind: "commit",
      uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${sourceCommit}`,
      revision: sourceCommit
    };
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      now: () => "2026-10-01T12:00:00.000Z"
    });

    const assessment = await verifier.verify({
      memory: recordWithEvidence([commitEvidence, fileEvidence]),
      task: "Change a different feature.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "compatible");
    assert.equal(assessment.reasonCode, "verified_current_state");
    assert.ok(
      assessment.evidence.some((reference) => reference.revision === head)
    );
    const reconstructed = await new VerifiedMemoryReconstructor().reconstruct({
      memory: recordWithEvidence([commitEvidence, fileEvidence]),
      task: "Change a different feature.",
      assessment
    });
    assert.equal(reconstructed.disposition, "retain");
    assert.equal(
      reconstructed.guidance,
      "The source feature flag defaults to enabled."
    );
  });
});

test("Git verifier uses a pull-request revision only as commit-lineage evidence", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    const fileEvidence: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(filePath).href,
      revision: sourceCommit
    };
    const pullRequestEvidence: EvidenceReference = {
      kind: "pull_request",
      uri: "https://github.com/owner/repo/pull/42",
      revision: sourceCommit
    };
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root }
    });

    const assessment = await verifier.verify({
      memory: recordWithEvidence([pullRequestEvidence, fileEvidence]),
      task: "Use the current feature default.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "compatible");
    assert.equal(assessment.source, "git_commit_and_file_identity");
    assert.ok(
      assessment.evidence.some(
        (reference) =>
          reference.kind === "commit" && reference.revision === sourceCommit
      )
    );
  });
});

test("Git verifier rejects memories whose cited file changed in the current working tree", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    const evidence: EvidenceReference[] = [
      {
        kind: "commit",
        uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${sourceCommit}`,
        revision: sourceCommit
      },
      {
        kind: "file",
        uri: pathToFileURL(filePath).href,
        revision: sourceCommit
      }
    ];
    await writeFile(filePath, "export const feature = false;\n");
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root }
    });

    const assessment = await verifier.verify({
      memory: recordWithEvidence(evidence),
      task: "Use the current feature flag.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "contradicted");
    assert.equal(assessment.reasonCode, "stale");
    assert.ok(
      assessment.evidence.some((reference) => reference.kind === "commit")
    );
  });
});

test("Git verifier fails closed without repository, commit, and file evidence", async () => {
  const verifier = new GitWorkingTreeMemoryVerifier({
    repositories: { resolve: async () => null }
  });
  const assessment = await verifier.verify({
    memory: recordWithEvidence([]),
    task: "Any task.",
    context,
    asOf: "2026-10-01T12:00:00.000Z"
  });
  assert.equal(assessment.compatibility, "unknown");
  assert.equal(assessment.reasonCode, "verification_inconclusive");
  assert.equal(assessment.evidence.length, 0);
});

test("Git verifier validates canonical RuleSync skill evidence and fails closed for untracked skills", async () => {
  await withGitRepository(async ({ root }) => {
    const skillDirectory = join(
      root,
      ".rulesync",
      "skills",
      "review-procedure"
    );
    const skillFile = join(skillDirectory, "SKILL.md");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      skillFile,
      "---\nname: review-procedure\n---\nRun focused tests.\n"
    );
    execGit(root, ["add", ".rulesync/skills/review-procedure/SKILL.md"]);
    execGit(root, ["commit", "-q", "-m", "Add canonical review skill"]);
    const sourceCommit = execGit(root, ["rev-parse", "HEAD"]);
    const skillEvidence: EvidenceReference[] = [
      {
        kind: "commit",
        uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${sourceCommit}`,
        revision: sourceCommit
      },
      {
        kind: "skill",
        uri: "rulesync://skills/review-procedure/SKILL.md",
        revision: sourceCommit
      }
    ];
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root }
    });
    const current = await verifier.verify({
      memory: recordWithEvidence(skillEvidence),
      task: "Use the canonical review workflow.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(current.compatibility, "compatible");

    await writeFile(
      skillFile,
      "---\nname: review-procedure\n---\nSkip validation.\n"
    );
    const stale = await verifier.verify({
      memory: recordWithEvidence(skillEvidence),
      task: "Use the canonical review workflow.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(stale.compatibility, "contradicted");
    assert.equal(stale.reasonCode, "stale");

    const untrackedSkill = join(
      root,
      ".rulesync",
      "skills",
      "untracked",
      "SKILL.md"
    );
    await mkdir(join(root, ".rulesync", "skills", "untracked"), {
      recursive: true
    });
    await writeFile(untrackedSkill, "---\nname: untracked\n---\nA draft.\n");
    const head = execGit(root, ["rev-parse", "HEAD"]);
    const untracked = await verifier.verify({
      memory: recordWithEvidence([
        {
          kind: "commit",
          uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${head}`,
          revision: head
        },
        { kind: "skill", uri: "rulesync://skills/untracked/SKILL.md" }
      ]),
      task: "Use the untracked draft.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(untracked.compatibility, "unknown");
  });
});

test("Git verifier validates canonical RuleSync command references against current files", async () => {
  await withGitRepository(async ({ root, filePath }) => {
    const commandPath = join(root, ".rulesync", "commands", "test-fix.md");
    const hookConfigPath = join(root, ".rulesync", "hooks.jsonc");
    const mcpConfigPath = join(root, ".rulesync", "mcp.jsonc");
    await mkdir(join(root, ".rulesync", "commands"), { recursive: true });
    await writeFile(
      commandPath,
      "---\ndescription: Test fixes\n---\nRun tests.\n"
    );
    await writeFile(hookConfigPath, '{"hooks":[]}\n');
    await writeFile(mcpConfigPath, '{"mcpServers":{}}\n');
    execGit(root, ["add", ".rulesync"]);
    execGit(root, ["commit", "-q", "-m", "Add canonical RuleSync sources"]);
    const sourceCommit = execGit(root, ["rev-parse", "HEAD"]);
    const evidence: EvidenceReference[] = [
      {
        kind: "commit",
        uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${sourceCommit}`,
        revision: sourceCommit
      },
      {
        kind: "file",
        uri: pathToFileURL(filePath).href,
        revision: sourceCommit
      },
      {
        kind: "rule",
        uri: "rulesync://commands/test-fix.md",
        revision: sourceCommit
      },
      {
        kind: "rule",
        uri: "rulesync://hooks.jsonc",
        revision: sourceCommit
      },
      {
        kind: "rule",
        uri: "rulesync://mcp.jsonc",
        revision: sourceCommit
      }
    ];
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root }
    });

    const current = await verifier.verify({
      memory: recordWithEvidence(evidence),
      task: "Repair the failing test.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(current.compatibility, "compatible");
    assert.ok(
      current.evidence.some(
        (reference) =>
          reference.kind === "rule" &&
          reference.uri === "rulesync://commands/test-fix.md"
      )
    );
    assert.ok(
      current.evidence.some(
        (reference) =>
          reference.kind === "rule" &&
          reference.uri === "rulesync://hooks.jsonc"
      )
    );
    assert.ok(
      current.evidence.some(
        (reference) =>
          reference.kind === "rule" && reference.uri === "rulesync://mcp.jsonc"
      )
    );

    await writeFile(
      commandPath,
      "---\ndescription: Test fixes\n---\nSkip tests.\n"
    );
    const stale = await verifier.verify({
      memory: recordWithEvidence(evidence),
      task: "Repair the failing test.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(stale.compatibility, "contradicted");
    assert.equal(stale.reasonCode, "stale");

    const draftPath = join(root, ".rulesync", "commands", "draft.md");
    await writeFile(draftPath, "A local draft.");
    const untracked = await verifier.verify({
      memory: recordWithEvidence([
        evidence[0]!,
        evidence[1]!,
        { kind: "rule", uri: "rulesync://commands/draft.md" }
      ]),
      task: "Use a local draft.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(untracked.compatibility, "unknown");
  });
});
