import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

function approvedPullRequestState(mergeCommit: string) {
  return {
    state: "CLOSED",
    isDraft: false,
    merged: true,
    mergedAt: "2026-09-30T10:00:00.000Z",
    mergeCommit,
    reviewDecision: "APPROVED",
    checksState: "SUCCESS"
  };
}

test("Git verifier requires a merged approved PR with successful checks", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    const fileEvidence: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(filePath).href
    };
    const invalidStates = [
      {
        ...approvedPullRequestState(sourceCommit),
        state: "OPEN",
        merged: false,
        mergedAt: null,
        mergeCommit: null
      },
      { ...approvedPullRequestState(sourceCommit), isDraft: true },
      {
        ...approvedPullRequestState(sourceCommit),
        reviewDecision: "CHANGES_REQUESTED"
      },
      {
        ...approvedPullRequestState(sourceCommit),
        reviewDecision: "REVIEW_REQUIRED"
      },
      { ...approvedPullRequestState(sourceCommit), checksState: "FAILURE" },
      { ...approvedPullRequestState(sourceCommit), checksState: null }
    ];

    for (const [index, pullRequestState] of invalidStates.entries()) {
      const verifier = new GitWorkingTreeMemoryVerifier({
        repositories: { resolve: async () => root },
        githubState: async () => ({
          pullRequest: pullRequestState,
          issue: null
        })
      });
      const assessment = await verifier.verify({
        memory: recordWithEvidence([
          {
            kind: "pull_request",
            uri: `https://github.com/owner/repo/pull/${70 + index}`
          },
          fileEvidence
        ]),
        task: "Use state validated from the cited pull request.",
        context: { ...context, runId: `invalid-pr-${index}` },
        asOf: "2026-10-01T12:00:00.000Z"
      });
      assert.equal(
        assessment.compatibility,
        "unknown",
        `invalid PR state ${index}`
      );
      assert.equal(assessment.source, "git_github_pr_review_checks");
    }
  });
});

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

test("Git verifier validates current PR state without overwriting its explicit source revision", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    await writeFile(
      join(root, "README.md"),
      "Later merged documentation change.\n"
    );
    execGit(root, ["add", "README.md"]);
    execGit(root, ["commit", "-q", "-m", "Update unrelated documentation"]);
    const pullRequestMergeCommit = execGit(root, ["rev-parse", "HEAD"]);
    let pullRequestLookups = 0;
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
      repositories: { resolve: async () => root },
      githubState: async () => {
        pullRequestLookups += 1;
        return {
          pullRequest: approvedPullRequestState(pullRequestMergeCommit),
          issue: null
        };
      }
    });

    const assessment = await verifier.verify({
      memory: recordWithEvidence([pullRequestEvidence, fileEvidence]),
      task: "Use the current feature default.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "compatible");
    assert.equal(
      assessment.source,
      "git_github_pr_review_checks_and_file_identity"
    );
    assert.ok(
      assessment.evidence.some(
        (reference) =>
          reference.kind === "pull_request" &&
          reference.uri === pullRequestEvidence.uri &&
          reference.revision === sourceCommit
      ),
      "the explicit source revision must remain intact after live PR validation"
    );
    assert.ok(
      assessment.evidence.some(
        (reference) =>
          reference.kind === "commit" &&
          reference.revision === pullRequestMergeCommit
      )
    );
    assert.equal(
      pullRequestLookups,
      1,
      "a cited PR's current review and check state must be validated even when a commit revision is explicit"
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

test("Git verifier resolves a revisionless PR only after merge, review, and checks pass", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    let lookups = 0;
    const pullRequestEvidence: EvidenceReference = {
      kind: "pull_request",
      uri: "https://github.com/owner/repo/pull/42"
    };
    const fileEvidence: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(filePath).href
    };
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async (repositoryId, uri) => {
        lookups += 1;
        assert.equal(repositoryId, "owner/repo");
        assert.equal(uri, pullRequestEvidence.uri);
        // Production resolves lineage only after all current PR gates pass.
        return {
          pullRequest: approvedPullRequestState(sourceCommit),
          issue: null
        };
      }
    });

    const assessment = await verifier.verify({
      memory: recordWithEvidence([pullRequestEvidence, fileEvidence]),
      task: "Use the merged feature behavior.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "compatible");
    assert.equal(lookups, 1);
    assert.ok(
      assessment.evidence.some(
        (reference) =>
          reference.kind === "pull_request" &&
          reference.uri === pullRequestEvidence.uri &&
          reference.revision === sourceCommit
      ),
      "the resolved merge revision remains visible as provenance"
    );
  });
});

test("Git verifier keeps unmerged and foreign-repository PR references inconclusive", async () => {
  await withGitRepository(async ({ root, filePath }) => {
    let lookups = 0;
    const fileEvidence: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(filePath).href
    };
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async () => {
        lookups += 1;
        return { pullRequest: null, issue: null };
      }
    });

    const openAssessment = await verifier.verify({
      memory: recordWithEvidence([
        { kind: "pull_request", uri: "https://github.com/owner/repo/pull/43" },
        fileEvidence
      ]),
      task: "Use a proposed feature.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(openAssessment.compatibility, "unknown");
    assert.equal(lookups, 1);

    const foreignAssessment = await verifier.verify({
      memory: recordWithEvidence([
        {
          kind: "pull_request",
          uri: "https://github.com/attacker/other/pull/9"
        },
        fileEvidence
      ]),
      task: "Use unrelated history.",
      context: { ...context, runId: "other-run" },
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(foreignAssessment.compatibility, "unknown");
    assert.equal(lookups, 1, "foreign refs must not trigger an API lookup");
  });
});

test("Git verifier surfaces current issue state without inferring an outcome", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    let lookups = 0;
    const issueUri = "https://github.com/owner/repo/issues/48";
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async (repositoryId, pullRequestUri, issueReference) => {
        lookups += 1;
        assert.equal(repositoryId, "owner/repo");
        assert.equal(pullRequestUri, null);
        assert.equal(issueReference, issueUri);
        return {
          pullRequest: null,
          issue: {
            state: "CLOSED",
            stateReason: "NOT_PLANNED",
            updatedAt: "2026-09-30T12:00:00.000Z"
          }
        };
      }
    });
    const assessment = await verifier.verify({
      memory: recordWithEvidence([
        {
          kind: "commit",
          uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${sourceCommit}`,
          revision: sourceCommit
        },
        { kind: "issue", uri: issueUri },
        { kind: "file", uri: pathToFileURL(filePath).href }
      ]),
      task: "Consider the historical issue alongside current code.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "compatible");
    assert.deepEqual(assessment.issueObservations, [
      {
        uri: issueUri,
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        updatedAt: "2026-09-30T12:00:00.000Z",
        observedAt: assessment.checkedAt
      }
    ]);
    const reconstruction = await new VerifiedMemoryReconstructor().reconstruct({
      memory: recordWithEvidence([
        {
          kind: "commit",
          uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${sourceCommit}`,
          revision: sourceCommit
        },
        { kind: "issue", uri: issueUri },
        { kind: "file", uri: pathToFileURL(filePath).href }
      ]),
      task: "Consider the historical issue alongside current code.",
      assessment
    });
    assert.match(
      reconstruction.rationale,
      /issue state is closed \(not planned\)/u
    );
    assert.match(
      reconstruction.rationale,
      /does not establish task success or memory correctness/u
    );
    assert.equal(lookups, 1);
  });
});

test("Git verifier fails closed when a cited issue state cannot be fetched", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    const issueUri = "https://github.com/owner/repo/issues/49";
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async () => null
    });
    const assessment = await verifier.verify({
      memory: recordWithEvidence([
        {
          kind: "commit",
          uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${sourceCommit}`,
          revision: sourceCommit
        },
        { kind: "issue", uri: issueUri },
        { kind: "file", uri: pathToFileURL(filePath).href }
      ]),
      task: "Check the current issue state.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(assessment.compatibility, "unknown");
    assert.equal(assessment.source, "git_github_issue_state");
  });
});

test("Git verifier leaves multiple issue references unknown under the one-query budget", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    let lookups = 0;
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async () => {
        lookups += 1;
        return {
          pullRequest: null,
          issue: {
            state: "OPEN",
            stateReason: null,
            updatedAt: "2026-10-01T00:00:00.000Z"
          }
        };
      }
    });
    const assessment = await verifier.verify({
      memory: recordWithEvidence([
        {
          kind: "commit",
          uri: `git://owner%2Frepo/commit/${sourceCommit}`,
          revision: sourceCommit
        },
        { kind: "issue", uri: "https://github.com/owner/repo/issues/50" },
        { kind: "issue", uri: "https://github.com/owner/repo/issues/51" },
        { kind: "file", uri: pathToFileURL(filePath).href }
      ]),
      task: "Reconcile guidance linked to multiple issues.",
      context: { ...context, runId: "multiple-issue-evidence" },
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "unknown");
    assert.equal(assessment.source, "git_github_issue_state");
    assert.equal(lookups, 0);
  });
});

test("Git verifier does not spend the bounded PR lookup when no cited file can be validated", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    let lookups = 0;
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async () => {
        lookups += 1;
        return {
          pullRequest: approvedPullRequestState(sourceCommit),
          issue: null
        };
      }
    });
    const orphaned = await verifier.verify({
      memory: recordWithEvidence([
        { kind: "pull_request", uri: "https://github.com/owner/repo/pull/48" }
      ]),
      task: "This memory has no file evidence.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(orphaned.compatibility, "unknown");
    assert.equal(lookups, 0);

    const verified = await verifier.verify({
      memory: recordWithEvidence([
        { kind: "pull_request", uri: "https://github.com/owner/repo/pull/49" },
        { kind: "file", uri: pathToFileURL(filePath).href }
      ]),
      task: "Use file-grounded, PR-verified evidence.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(verified.compatibility, "compatible");
    assert.equal(lookups, 1);
  });
});

test("Git verifier leaves multiple cited PRs unknown when one lookup cannot validate all", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    let lookups = 0;
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async () => {
        lookups += 1;
        return {
          pullRequest: approvedPullRequestState(sourceCommit),
          issue: null
        };
      }
    });
    const assessment = await verifier.verify({
      memory: recordWithEvidence([
        {
          kind: "commit",
          uri: `git://owner%2Frepo/commit/${sourceCommit}`,
          revision: sourceCommit
        },
        { kind: "pull_request", uri: "https://github.com/owner/repo/pull/49" },
        { kind: "pull_request", uri: "https://github.com/owner/repo/pull/50" },
        { kind: "file", uri: pathToFileURL(filePath).href }
      ]),
      task: "Use facts backed by multiple pull requests.",
      context: { ...context, runId: "multiple-pr-evidence" },
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "unknown");
    assert.equal(
      lookups,
      0,
      "an over-budget reference set must fail closed without a partial lookup"
    );
  });
});

test("Git verifier caps live PR lookups at one per research context", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    let lookups = 0;
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async () => {
        lookups += 1;
        return {
          pullRequest: approvedPullRequestState(sourceCommit),
          issue: null
        };
      }
    });
    const fileEvidence: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(filePath).href
    };

    const first = await verifier.verify({
      memory: recordWithEvidence([
        { kind: "pull_request", uri: "https://github.com/owner/repo/pull/50" },
        fileEvidence
      ]),
      task: "Apply one reviewed change.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });
    const second = await verifier.verify({
      memory: recordWithEvidence([
        { kind: "pull_request", uri: "https://github.com/owner/repo/pull/51" },
        fileEvidence
      ]),
      task: "Apply another reviewed change.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(first.compatibility, "compatible");
    assert.equal(second.compatibility, "unknown");
    assert.equal(lookups, 1);
  });
});

test("Git verifier caps concurrent PR lookups at one per research context", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    let lookups = 0;
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async () => {
        lookups += 1;
        return {
          pullRequest: approvedPullRequestState(sourceCommit),
          issue: null
        };
      }
    });
    const fileEvidence: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(filePath).href
    };
    const verifyPr = (number: number) =>
      verifier.verify({
        memory: recordWithEvidence([
          {
            kind: "pull_request",
            uri: `https://github.com/owner/repo/pull/${number}`
          },
          fileEvidence
        ]),
        task: `Apply PR ${number}.`,
        context,
        asOf: "2026-10-01T12:00:00.000Z"
      });

    const assessments = await Promise.all([verifyPr(60), verifyPr(61)]);

    assert.equal(lookups, 1);
    assert.deepEqual(
      assessments.map((assessment) => assessment.compatibility).sort(),
      ["compatible", "unknown"]
    );
  });
});

test("GitHub CLI resolver queries same-repository merge, review, and check state", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    const temporary = await mkdtemp(join(tmpdir(), "autodev-memory-fake-gh-"));
    const previousPath = process.env.PATH;
    const previousTmpDir = process.env.TMPDIR;
    const previousSecret = process.env.AUTODEV_MEMORY_TEST_SECRET;
    try {
      const ghPath = join(temporary, "gh");
      const argsPath = join(temporary, "args.txt");
      const hostPath = join(temporary, "host.txt");
      const secretPath = join(temporary, "secret.txt");
      const pullRequestPath = join(temporary, "pull-request.json");
      await writeFile(
        pullRequestPath,
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "CLOSED",
                isDraft: false,
                merged: true,
                mergedAt: "2026-09-30T10:00:00.000Z",
                mergeCommit: { oid: sourceCommit },
                reviewDecision: "APPROVED",
                statusCheckRollup: { state: "SUCCESS" }
              },
              issue: {
                state: "CLOSED",
                stateReason: "COMPLETED",
                updatedAt: "2026-09-30T12:00:00.000Z"
              }
            }
          }
        }),
        "utf8"
      );
      const fakeGitHubCli = String.raw`#!/bin/sh
printf '%s\n' "$*" > "$TMPDIR/args.txt"
printf '%s\n' "$GH_HOST" > "$TMPDIR/host.txt"
printf '%s\n' "$AUTODEV_MEMORY_TEST_SECRET" > "$TMPDIR/secret.txt"
cat "$TMPDIR/pull-request.json"
`;
      await writeFile(ghPath, fakeGitHubCli, { mode: 0o700 });
      await chmod(ghPath, 0o700);
      process.env.PATH = `${temporary}${delimiter}${previousPath ?? ""}`;
      process.env.TMPDIR = temporary;
      process.env.AUTODEV_MEMORY_TEST_SECRET = "must-not-be-inherited";

      const verifier = new GitWorkingTreeMemoryVerifier({
        repositories: { resolve: async () => root }
      });
      const assessment = await verifier.verify({
        memory: recordWithEvidence([
          {
            kind: "pull_request",
            uri: "https://github.com/owner/repo/pull/52"
          },
          { kind: "issue", uri: "https://github.com/owner/repo/issues/53" },
          { kind: "file", uri: pathToFileURL(filePath).href }
        ]),
        task: "Use the merged change after verifying current files.",
        context: { ...context },
        asOf: "2026-10-01T12:00:00.000Z"
      });

      assert.equal(assessment.compatibility, "compatible");
      assert.deepEqual(assessment.issueObservations, [
        {
          uri: "https://github.com/owner/repo/issues/53",
          state: "CLOSED",
          stateReason: "COMPLETED",
          updatedAt: "2026-09-30T12:00:00.000Z",
          observedAt: assessment.checkedAt
        }
      ]);
      const args = await readFile(argsPath, "utf8");
      assert.match(args, /api graphql/u);
      assert.match(args, /owner=owner/u);
      assert.match(args, /name=repo/u);
      assert.match(args, /pullRequestNumber=52/u);
      assert.match(args, /issueNumber=53/u);
      assert.match(args, /stateReason/u);
      assert.match(args, /reviewDecision/u);
      assert.match(args, /statusCheckRollup/u);
      assert.equal((await readFile(hostPath, "utf8")).trim(), "github.com");
      assert.equal((await readFile(secretPath, "utf8")).trim(), "");

      const successfulResponse = JSON.parse(
        await readFile(pullRequestPath, "utf8")
      ) as Record<string, unknown>;
      successfulResponse.errors = [{ message: "partial GraphQL response" }];
      await writeFile(pullRequestPath, JSON.stringify(successfulResponse));
      const partialResponse = await new GitWorkingTreeMemoryVerifier({
        repositories: { resolve: async () => root }
      }).verify({
        memory: recordWithEvidence([
          {
            kind: "pull_request",
            uri: "https://github.com/owner/repo/pull/52"
          },
          { kind: "issue", uri: "https://github.com/owner/repo/issues/53" },
          { kind: "file", uri: pathToFileURL(filePath).href }
        ]),
        task: "Do not authorize partial GitHub state.",
        context: { ...context, runId: "partial-graphql-response" },
        asOf: "2026-10-01T12:00:00.000Z"
      });
      assert.equal(partialResponse.compatibility, "unknown");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
      if (previousSecret === undefined)
        delete process.env.AUTODEV_MEMORY_TEST_SECRET;
      else process.env.AUTODEV_MEMORY_TEST_SECRET = previousSecret;
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

test("Git verifier treats reverted cited-path history as stale or unknown even when bytes are restored", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    // Establish a base commit so reverting the source commit (which only
    // adds the cited file) does not delete the file outright.
    await writeFile(
      join(root, "src", "baseline.ts"),
      "export const baseline = true;\n"
    );
    execGit(root, ["add", "src/baseline.ts"]);
    execGit(root, ["commit", "-q", "-m", "Add baseline"]);

    // Capture the source-commit contents before reverting; the revert
    // deletes the file because C1 introduced it.
    const original = await readFile(filePath, "utf8");
    // Standard `git revert <source>` undoes the source change. The revert
    // commit is the only descendant the verifier is expected to inspect.
    execGit(root, ["revert", "--no-edit", sourceCommit]);
    // Re-add a file with byte-identical contents to the source commit so the
    // existing `git diff --quiet sourceCommit -- <file>` check would pass if
    // applied in isolation. The verifier must still fail closed.
    await writeFile(filePath, original);
    execGit(root, ["add", "src/feature.ts"]);
    execGit(root, ["commit", "-q", "-m", "Restore identical source contents"]);
    const head = execGit(root, ["rev-parse", "HEAD"]);
    assert.notEqual(
      head,
      sourceCommit,
      "the post-revert HEAD must move past the source commit"
    );

    const abbreviatedSourceCommit = sourceCommit.slice(0, 7);
    const fileEvidence: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(filePath).href,
      revision: abbreviatedSourceCommit
    };
    const commitEvidence: EvidenceReference = {
      kind: "commit",
      uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${abbreviatedSourceCommit}`,
      revision: abbreviatedSourceCommit
    };
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      now: () => "2026-10-01T12:00:00.000Z"
    });

    const assessment = await verifier.verify({
      memory: recordWithEvidence([commitEvidence, fileEvidence]),
      task: "Use the reverted feature flag.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "contradicted");
    assert.equal(assessment.reasonCode, "stale");
    assert.ok(
      assessment.evidence.some(
        (reference) =>
          reference.kind === "commit" && reference.revision === head
      ),
      "the contradicted assessment must cite the current HEAD"
    );

    // A nonstandard rollback/restoration has no canonical Revert message, so
    // it must remain unknown rather than being misclassified as a standard
    // contradiction or silently treated as unchanged.
    execGit(root, ["checkout", "-q", "-b", "control", sourceCommit]);
    await writeFile(filePath, "export const feature = false;\n");
    execGit(root, ["add", "src/feature.ts"]);
    execGit(root, [
      "commit",
      "-q",
      "-m",
      "Unrelated drift",
      "-m",
      `This reverts commit ${sourceCommit}.`
    ]);
    await writeFile(filePath, original);
    execGit(root, ["add", "src/feature.ts"]);
    execGit(root, ["commit", "-q", "-m", "Restore byte-identical contents"]);

    const reconciled = await verifier.verify({
      memory: recordWithEvidence([commitEvidence, fileEvidence]),
      task: "Reconcile the manually restored feature flag.",
      // A distinct research context refreshes the verifier's per-context HEAD snapshot.
      context: { ...context },
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(reconciled.compatibility, "unknown");
    assert.equal(reconciled.reasonCode, "verification_inconclusive");
    assert.equal(reconciled.source, "git_cited_file_history_changed");
  });
});
