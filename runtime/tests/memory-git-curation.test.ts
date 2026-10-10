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
import type { CurrentStateAssessment } from "../src/memory/service.ts";

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
    checksState: "SUCCESS",
    reviewThreadsComplete: true,
    unresolvedReviewThreadCount: 0,
    // Required, so a fixture that forgets to say whether anything superseded
    // the PR cannot silently stand for "nothing did".
    supersession: null
  };
}

test("Git verifier requires a merged approved PR with successful checks and resolved current threads", async () => {
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
      { ...approvedPullRequestState(sourceCommit), checksState: null },
      {
        ...approvedPullRequestState(sourceCommit),
        unresolvedReviewThreadCount: 1
      },
      {
        ...approvedPullRequestState(sourceCommit),
        reviewThreadsComplete: false
      }
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
    execGit(root, ["add", "src/feature.ts"]);
    execGit(root, ["commit", "-q", "-m", "Add feature"]);
    const sourceCommit = execGit(root, ["rev-parse", "HEAD"]);
    await run({ root, sourceCommit, filePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Git verifier runs independent tracked-file and diff checks concurrently", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    let activeChecks = 0;
    let peakChecks = 0;
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      runGit: async (_repositoryRoot, args) => {
        const command = args[0];
        if (command === "rev-parse") {
          return { exitCode: 0, stdout: sourceCommit };
        }
        if (command === "ls-files" || command === "diff") {
          activeChecks += 1;
          peakChecks = Math.max(peakChecks, activeChecks);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeChecks -= 1;
          return { exitCode: 0, stdout: "" };
        }
        if (command === "merge-base" || command === "log") {
          return { exitCode: 0, stdout: "" };
        }
        throw new Error(`Unexpected Git operation: ${String(command)}`);
      }
    });
    const evidence: EvidenceReference[] = [
      {
        kind: "commit",
        uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${sourceCommit}`,
        revision: sourceCommit
      },
      { kind: "file", uri: pathToFileURL(filePath).href }
    ];

    const assessment = await verifier.verify({
      memory: recordWithEvidence(evidence),
      task: "Use the current feature behavior.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(assessment.compatibility, "compatible");
    assert.equal(peakChecks, 2);
  });
});

function execGit(root: string, args: readonly string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  Object.assign(env, {
    GIT_AUTHOR_NAME: "AutoDev Memory Tests",
    GIT_AUTHOR_EMAIL: "memory-tests@example.invalid",
    GIT_COMMITTER_NAME: "AutoDev Memory Tests",
    GIT_COMMITTER_EMAIL: "memory-tests@example.invalid"
  });
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env
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
    assert.equal(
      assessments[0]?.compatibility,
      "compatible",
      "the first ranked/requested candidate retains the one live PR lookup"
    );
    assert.equal(assessments[1]?.compatibility, "unknown");
  });
});

/**
 * Run the verifier with `gh` replaced by a script that answers with `payload`.
 *
 * One implementation for every test that needs the real `gh api graphql`
 * boundary. Two copies of this looked like the obvious way to avoid coupling and
 * only produced two different answers: the second copy's fake was never
 * executed and the real CLI reached the network, so its "responses" were
 * `Could not resolve to a Repository` and every assertion quietly measured the
 * fail-closed path instead of the parse it was written to cover.
 *
 * The `gh` name is resolved from `PATH`, so the temporary directory is prepended
 * and both `PATH` and `TMPDIR` are restored afterwards. `AUTODEV_MEMORY_TEST_SECRET`
 * is set on purpose: the child environment is an allowlist, and a secret leaking
 * into it would be a real finding rather than a test artefact.
 */
async function withFakeGitHubCli<T>(
  root: string,
  repository: unknown,
  run: (temporary: string) => Promise<T>
): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), "autodev-memory-github-cli-"));
  const previousPath = process.env.PATH;
  const previousTmpDir = process.env.TMPDIR;
  const previousSecret = process.env.AUTODEV_MEMORY_TEST_SECRET;
  try {
    const ghPath = join(temporary, "gh");
    await writeFile(
      join(temporary, "pull-request.json"),
      JSON.stringify({ data: { repository } }),
      "utf8"
    );
    await writeFile(
      ghPath,
      String.raw`#!/bin/sh
printf '%s\n' "$*" > "$TMPDIR/args.txt"
printf '%s\n' "$GH_HOST" > "$TMPDIR/host.txt"
printf '%s\n' "$AUTODEV_MEMORY_TEST_SECRET" > "$TMPDIR/secret.txt"
cat "$TMPDIR/pull-request.json"
`,
      { mode: 0o700 }
    );
    await chmod(ghPath, 0o700);
    process.env.PATH = `${temporary}${delimiter}${previousPath ?? ""}`;
    process.env.TMPDIR = temporary;
    process.env.AUTODEV_MEMORY_TEST_SECRET = "must-not-be-inherited";
    return await run(temporary);
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
}

test("GitHub CLI resolver queries same-repository merge, review, and check state", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    await withFakeGitHubCli(
      root,
      {
        pullRequest: {
          state: "CLOSED",
          isDraft: false,
          merged: true,
          mergedAt: "2026-09-30T10:00:00.000Z",
          mergeCommit: { oid: sourceCommit },
          reviewDecision: "APPROVED",
          statusCheckRollup: { state: "SUCCESS" },
          reviewThreads: { totalCount: 0, nodes: [] },
          // A merged PR closes without naming an outside closer, which is what
          // every normally merged and hand-closed PR reports.
          timelineItems: {
            nodes: [{ __typename: "ClosedEvent", closer: null }]
          }
        },
        issue: {
          state: "CLOSED",
          stateReason: "COMPLETED",
          updatedAt: "2026-09-30T12:00:00.000Z"
        }
      },
      async (temporary) => {
        const argsPath = join(temporary, "args.txt");
        const hostPath = join(temporary, "host.txt");
        const secretPath = join(temporary, "secret.txt");
        const pullRequestPath = join(temporary, "pull-request.json");
        const verifier = new GitWorkingTreeMemoryVerifier({
          repositories: { resolve: async () => root }
        });
        const assess = (runId: string) =>
          verifier.verify({
            memory: recordWithEvidence([
              {
                kind: "pull_request",
                uri: "https://github.com/owner/repo/pull/52"
              },
              { kind: "issue", uri: "https://github.com/owner/repo/issues/53" },
              { kind: "file", uri: pathToFileURL(filePath).href }
            ]),
            task: "Use only fully reviewed current code.",
            context: { ...context, runId },
            asOf: "2026-10-01T12:00:00.000Z"
          });

        const assessment = await assess("github-cli-resolver");
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
        assert.match(args, /reviewThreads\(first: 100\)/u);
        assert.match(args, /isResolved isOutdated/u);
        // Supersession rides in the same bounded query rather than costing a
        // second lookup, so the one-lookup budget is unchanged by reading it.
        // `PullRequest` has no `closedEvent` field: the closer is reached
        // through the timeline, filtered to the one item type that carries it.
        assert.match(args, /timelineItems/u);
        assert.match(args, /itemTypes: \[CLOSED_EVENT\]/u);
        assert.match(args, /on ClosedEvent/u);
        assert.match(args, /closer/u);
        assert.doesNotMatch(args, /comments|body/u);
        assert.equal((await readFile(hostPath, "utf8")).trim(), "github.com");
        assert.equal((await readFile(secretPath, "utf8")).trim(), "");

        const structuredResponse = JSON.parse(
          await readFile(pullRequestPath, "utf8")
        ) as {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  totalCount: number;
                  nodes: Array<{ isResolved: boolean; isOutdated: boolean }>;
                };
              };
            };
          };
        };
        const verifyThreadState = async (
          reviewThreads: {
            totalCount: number;
            nodes: Array<{ isResolved: boolean; isOutdated: boolean }>;
          },
          runId: string
        ) => {
          structuredResponse.data.repository.pullRequest.reviewThreads =
            reviewThreads;
          await writeFile(pullRequestPath, JSON.stringify(structuredResponse));
          return assess(runId);
        };
        const unresolvedThreads = await verifyThreadState(
          { totalCount: 1, nodes: [{ isResolved: false, isOutdated: false }] },
          "unresolved-review-thread"
        );
        assert.equal(unresolvedThreads.compatibility, "unknown");
        const outdatedThread = await verifyThreadState(
          { totalCount: 1, nodes: [{ isResolved: false, isOutdated: true }] },
          "outdated-review-thread"
        );
        assert.equal(outdatedThread.compatibility, "compatible");
        const truncatedThreads = await verifyThreadState(
          {
            totalCount: 101,
            nodes: Array.from({ length: 100 }, () => ({
              isResolved: true,
              isOutdated: false
            }))
          },
          "truncated-review-threads"
        );
        assert.equal(truncatedThreads.compatibility, "unknown");

        // More threads than the query asked for is a response the curation
        // cannot reason about, and it is refused rather than measured -- which
        // is the same `unknown` verdict, arrived at for the opposite reason: a
        // short page means AutoDev is missing threads, while a long one means
        // the answer is not the one it asked for. Nothing tested the second.
        const overlongThreads = await verifyThreadState(
          {
            totalCount: 101,
            nodes: Array.from({ length: 101 }, () => ({
              isResolved: true,
              isOutdated: false
            }))
          },
          "overlong-review-threads"
        );
        assert.equal(
          overlongThreads.compatibility,
          "unknown",
          "a response carrying more review threads than were requested must not be read"
        );

        await writeFile(
          pullRequestPath,
          JSON.stringify({
            ...structuredResponse,
            errors: [{ message: "partial GraphQL response" }]
          })
        );
        const partialResponse = await assess("partial-graphql-response");
        assert.equal(partialResponse.compatibility, "unknown");
      }
    );
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

const SUPERSEDING_PULL_REQUEST = {
  number: 61,
  url: "https://github.com/owner/repo/pull/61"
};

/**
 * Assess a memory against a stubbed GitHub pull-request response.
 *
 * Drives the real `gh api graphql` boundary through the shared harness, so
 * `timelineItems` is parsed by the production parser rather than by a copy of
 * it in this file. A test that re-implements the shape rules proves only that
 * the copy agrees with itself, and it keeps agreeing after production changes.
 */
async function assessAgainstGitHubResponse(input: {
  readonly root: string;
  readonly filePath: string;
  readonly pullRequest: unknown;
  readonly runId: string;
}): Promise<CurrentStateAssessment> {
  return withFakeGitHubCli(
    input.root,
    { pullRequest: input.pullRequest },
    async () =>
      new GitWorkingTreeMemoryVerifier({
        repositories: { resolve: async () => input.root }
      }).verify({
        memory: recordWithEvidence([
          {
            kind: "pull_request",
            uri: "https://github.com/owner/repo/pull/52"
          },
          { kind: "file", uri: pathToFileURL(input.filePath).href }
        ]),
        task: "Apply the approach the cited pull request established.",
        context: { ...context, runId: input.runId },
        asOf: "2026-10-01T12:00:00.000Z"
      })
  );
}

/** The merged, approved, green PR every supersession case starts from. */
function mergedPullRequestPayload(
  mergeCommit: string
): Record<string, unknown> {
  return {
    state: "CLOSED",
    isDraft: false,
    merged: true,
    mergedAt: "2026-09-30T10:00:00.000Z",
    mergeCommit: { oid: mergeCommit },
    reviewDecision: "APPROVED",
    statusCheckRollup: { state: "SUCCESS" },
    reviewThreads: { totalCount: 0, nodes: [] }
  };
}

test("a PR replaced by a later merged PR is superseded even when every cited file is byte-identical", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    // The repository is left untouched after the source commit: no cited path
    // changed, no revert exists, ancestry holds, and the PR itself is merged,
    // approved and green. Every existing check passes. This is the case the
    // verifier previously called `compatible` while the work the memory
    // describes had been replaced outright.
    const assessment = await assessAgainstGitHubResponse({
      root,
      filePath,
      runId: "superseded-pr",
      pullRequest: {
        ...mergedPullRequestPayload(sourceCommit),
        timelineItems: {
          nodes: [
            {
              __typename: "ClosedEvent",
              closer: {
                __typename: "PullRequest",
                ...SUPERSEDING_PULL_REQUEST,
                merged: true
              }
            }
          ]
        }
      }
    });

    assert.equal(assessment.compatibility, "contradicted");
    assert.equal(assessment.reasonCode, "superseded");
    assert.equal(assessment.source, "git_github_pr_supersession");
    // The superseding PR is carried as evidence so an operator can open it
    // rather than being told only that something superseded the memory.
    assert.ok(
      assessment.evidence.some(
        (reference) =>
          reference.kind === "pull_request" &&
          reference.uri === SUPERSEDING_PULL_REQUEST.url
      ),
      `superseding PR missing from ${JSON.stringify(assessment.evidence)}`
    );
    assert.ok(
      assessment.evidence.some((reference) => reference.kind === "commit"),
      "the commit at which this was observed must stay attached"
    );
  });
});

test("supersession is reported ahead of the merge gate, not hidden behind it", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    // A PR closed *by* another PR was, by construction, never itself merged
    // and approved. Before this change the merge/review/checks gate answered
    // first and returned an ordinary inconclusive read, which tells an operator
    // their evidence could not be checked rather than that it was replaced.
    const assessment = await assessAgainstGitHubResponse({
      root,
      filePath,
      runId: "superseded-before-merge-gate",
      pullRequest: {
        ...mergedPullRequestPayload(sourceCommit),
        state: "CLOSED",
        merged: false,
        mergedAt: null,
        reviewDecision: null,
        timelineItems: {
          nodes: [
            {
              __typename: "ClosedEvent",
              closer: {
                __typename: "PullRequest",
                ...SUPERSEDING_PULL_REQUEST,
                merged: true
              }
            }
          ]
        }
      }
    });

    assert.equal(assessment.compatibility, "contradicted");
    assert.equal(assessment.reasonCode, "superseded");
    assert.notEqual(assessment.source, "git_github_pr_review_checks");
  });
});

test("a PR closed by a commit is superseded, and is not given an address nobody observed", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    // GitHub's closer union also names a bare commit, which is how a commit
    // that references an issue closes it. That is a supersession: the PR was
    // closed by something outside its own merge. But no pull request was named,
    // so the assessment must not attach a PR reference an operator would open
    // and find something else at.
    const assessment = await assessAgainstGitHubResponse({
      root,
      filePath,
      runId: "superseded-by-commit",
      pullRequest: {
        ...mergedPullRequestPayload(sourceCommit),
        timelineItems: {
          nodes: [
            { __typename: "ClosedEvent", closer: { __typename: "Commit" } }
          ]
        }
      }
    });

    assert.equal(assessment.compatibility, "contradicted");
    assert.equal(assessment.reasonCode, "superseded");
    assert.deepEqual(
      assessment.evidence.filter(
        (reference) => reference.kind === "pull_request"
      ),
      [],
      "an unattributable supersession must not invent a pull request to cite"
    );
    assert.ok(
      assessment.evidence.some((reference) => reference.kind === "commit"),
      "the commit at which this was observed must stay attached"
    );
  });
});

test("the ways a PR is closed that are not supersession stay compatible", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    // Merging a PR closes it via its own merge commit; closing it by hand
    // closes it with no closer at all; and a PR closed by another that was
    // itself abandoned replaced nothing. None of the three is a supersession,
    // and reading any of them as one would contradict memories that are still
    // the current account of themselves.
    const notSuperseding = [
      {
        label: "closed without naming a closer",
        timelineItems: {
          nodes: [{ __typename: "ClosedEvent", closer: null }]
        }
      },
      {
        label: "open, so it has no close event at all",
        timelineItems: { nodes: [] }
      },
      {
        label: "closer PR never merged",
        timelineItems: {
          nodes: [
            {
              __typename: "ClosedEvent",
              closer: {
                __typename: "PullRequest",
                ...SUPERSEDING_PULL_REQUEST,
                merged: false
              }
            }
          ]
        }
      }
    ];

    for (const [index, timeline] of notSuperseding.entries()) {
      const assessment = await assessAgainstGitHubResponse({
        root,
        filePath,
        runId: `not-superseded-${index}`,
        pullRequest: {
          ...mergedPullRequestPayload(sourceCommit),
          timelineItems: timeline.timelineItems
        }
      });
      assert.equal(
        assessment.compatibility,
        "compatible",
        `${timeline.label} must not read as supersession`
      );
      assert.equal(assessment.reasonCode, "verified_current_state");
    }
  });
});

test("an unreadable close event is unknown, never an observed absence of supersession", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    // Each of these is a response that did not say whether anything superseded
    // the PR. Reporting them as "nothing superseded it" would turn a lookup we
    // could not complete into a clean bill of health for the memory.
    const unreadable: readonly { label: string; timelineItems?: unknown }[] = [
      { label: "timeline absent" },
      { label: "timeline is not an object", timelineItems: "closed" },
      {
        label: "timeline has no nodes array",
        timelineItems: { totalCount: 1 }
      },
      {
        label: "nodes is not an array",
        timelineItems: { nodes: { __typename: "ClosedEvent" } }
      },
      {
        // One close event was requested. More than one means the connection
        // answered a different question, and taking the first would be a guess.
        label: "more than one timeline item",
        timelineItems: {
          nodes: [
            { __typename: "ClosedEvent", closer: null },
            { __typename: "ClosedEvent", closer: null }
          ]
        }
      },
      {
        label: "node has no type name",
        timelineItems: { nodes: [{ closer: null }] }
      },
      {
        label: "node is not a close event",
        timelineItems: { nodes: [{ __typename: "MergedEvent" }] }
      },
      {
        label: "closer is not an object",
        timelineItems: { nodes: [{ __typename: "ClosedEvent", closer: 7 }] }
      },
      {
        label: "closer type is unknown",
        timelineItems: {
          nodes: [{ __typename: "ClosedEvent", closer: { __typename: "Bot" } }]
        }
      },
      {
        label: "closer PR has no merged flag",
        timelineItems: {
          nodes: [
            {
              __typename: "ClosedEvent",
              closer: { __typename: "PullRequest", ...SUPERSEDING_PULL_REQUEST }
            }
          ]
        }
      },
      {
        label: "closer URL is not a canonical pull request URL",
        timelineItems: {
          nodes: [
            {
              __typename: "ClosedEvent",
              closer: {
                __typename: "PullRequest",
                number: 61,
                url: "https://gitlab.com/owner/repo/pull/61",
                merged: true
              }
            }
          ]
        }
      },
      {
        // The URL is what an operator would open and the number is what the
        // rest of the system compares; a response where they disagree is not
        // one to build a verdict on.
        label: "closer number disagrees with its URL",
        timelineItems: {
          nodes: [
            {
              __typename: "ClosedEvent",
              closer: {
                __typename: "PullRequest",
                number: 62,
                url: "https://github.com/owner/repo/pull/61",
                merged: true
              }
            }
          ]
        }
      }
    ];

    for (const [index, shape] of unreadable.entries()) {
      const pullRequest: Record<string, unknown> = {
        ...mergedPullRequestPayload(sourceCommit)
      };
      // An absent key is left absent: that is what "GitHub did not tell us"
      // looks like, and it must not be smoothed into an explicit empty list.
      if ("timelineItems" in shape)
        pullRequest.timelineItems = shape.timelineItems;

      const assessment = await assessAgainstGitHubResponse({
        root,
        filePath,
        runId: `unreadable-closer-${index}`,
        pullRequest
      });
      assert.equal(
        assessment.compatibility,
        "unknown",
        `${shape.label} must not be reported as a clean verification`
      );
      assert.equal(assessment.reasonCode, "verification_inconclusive");
    }
  });
});

test("a memory citing no pull request is unaffected by supersession state", async () => {
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    // Supersession is observable only through a cited PR. A memory grounded in
    // files and a commit has no PR to supersede, and inventing one for it would
    // be inventing evidence.
    const assessment = await new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      githubState: async () => {
        throw new Error("no pull request is cited, so no lookup may be spent");
      }
    }).verify({
      memory: recordWithEvidence([
        { kind: "commit", uri: "git://owner/repo/commit/" + sourceCommit },
        { kind: "file", uri: pathToFileURL(filePath).href }
      ]),
      task: "Apply the approach the cited commit established.",
      context: { ...context, runId: "no-cited-pull-request" },
      asOf: "2026-10-01T12:00:00.000Z"
    });
    assert.equal(assessment.compatibility, "compatible");
    assert.equal(assessment.reasonCode, "verified_current_state");
  });
});

/**
 * What "the cited commit is not in this repository's history" means.
 *
 * The verifier asks `git merge-base --is-ancestor <cited> <current>`, and the
 * answer has three outcomes, not two. Exit 0 means the citation is still in the
 * current history. Exit 1 means git answered, and the answer is *no* -- which is
 * a contradiction of the memory, not an absence of information. Any other
 * non-zero exit means git itself could not answer, which is inconclusive.
 *
 * Only the first was exercised. Every test in this file cites a commit that is
 * genuinely ancestral, so the other two branches -- the contradicted verdict and
 * the fail-closed unknown -- could have been deleted with the file staying
 * green, and the distinction between "the repository disagrees" and "the
 * repository would not say" is the whole point of the question.
 */
test("a cited commit outside the current history contradicts; a git that cannot answer stays unknown", async () => {
  // Two branches from one root: `sourceCommit` is on the history branch and
  // `divergentCommit` is not an ancestor of it, which is what git exit 1 means.
  await withGitRepository(async ({ root, sourceCommit, filePath }) => {
    execGit(root, ["checkout", "-q", "-b", "divergent"]);
    await writeFile(
      join(root, "src", "feature.ts"),
      "export const feature = false;\n"
    );
    execGit(root, ["add", "src/feature.ts"]);
    execGit(root, ["commit", "-q", "-m", "Divergent change"]);
    const divergentCommit = execGit(root, ["rev-parse", "HEAD"]);
    execGit(root, ["checkout", "-q", "-"]);

    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      now: () => "2026-10-01T12:00:00.000Z"
    });
    const divergingEvidence: readonly EvidenceReference[] = [
      {
        kind: "commit",
        uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${divergentCommit}`,
        revision: divergentCommit
      },
      {
        kind: "file",
        uri: pathToFileURL(filePath).href,
        revision: divergentCommit
      }
    ];

    const contradicted = await verifier.verify({
      memory: recordWithEvidence(divergingEvidence),
      task: "Change the feature flag.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(
      contradicted.compatibility,
      "contradicted",
      "a cited commit that is not in the current history is a contradiction of the memory, not a gap in what we know"
    );
    assert.equal(contradicted.reasonCode, "current_state_conflict");
    assert.ok(
      contradicted.evidence.some(
        (reference) => reference.revision === sourceCommit
      ),
      "the contradiction cites the commit the repository is actually at, so an operator can see what replaced the cited one"
    );
  });

  // Git cannot answer: the repository is perfectly good, but the cited revision
  // is an object this clone has never seen -- a shallow clone, a rebase, or a
  // force-push. `merge-base` exits 128 on a name it cannot resolve, which is
  // neither 0 nor 1, and that has to read as inconclusive rather than as a
  // contradiction: reporting "contradicted" here would let a misconfigured clone
  // silently retire every memory in the workspace.
  //
  // A root that is not a repository at all would not do. The verifier resolves
  // the current commit before it reaches the ancestry question, so that is
  // refused earlier and never arrives here -- the first version of this test used
  // it, the assertion passed for the wrong reason, and the branch stayed dark.
  await withGitRepository(async ({ root, filePath }) => {
    const verifier = new GitWorkingTreeMemoryVerifier({
      repositories: { resolve: async () => root },
      now: () => "2026-10-01T12:00:00.000Z"
    });
    const absentCommit = "0123456789abcdef0123456789abcdef01234567";
    const assessment = await verifier.verify({
      memory: recordWithEvidence([
        {
          kind: "commit",
          uri: `git://${encodeURIComponent(context.repositoryId!)}/commit/${absentCommit}`,
          revision: absentCommit
        },
        {
          kind: "file",
          uri: pathToFileURL(filePath).href,
          revision: absentCommit
        }
      ]),
      task: "Change the feature flag.",
      context,
      asOf: "2026-10-01T12:00:00.000Z"
    });

    assert.equal(
      assessment.compatibility,
      "unknown",
      "a git invocation that fails for any reason other than a clean answer is not evidence against the memory"
    );
    assert.equal(assessment.reasonCode, "verification_inconclusive");
  });
});

/**
 * A memory that did not verify compatible must not reach the model as usable.
 *
 * The reconstructor decides what an injection carries, so its answer for an
 * unverified memory is the last thing between "we could not check" and "the
 * model was told this is still true". It had no failing test, and a memory that
 * could not be verified could have reconstructed as retained guidance.
 */
test("an unverified memory reconstructs as uncertain, not as usable guidance", async () => {
  const reconstructor = new VerifiedMemoryReconstructor();
  const cases = [
    { compatibility: "contradicted", reasonCode: "current_state_conflict" },
    { compatibility: "unknown", reasonCode: "verification_inconclusive" }
  ] as const;

  for (const { compatibility, reasonCode } of cases) {
    const reconstruction = await reconstructor.reconstruct({
      memory: recordWithEvidence([
        {
          kind: "file",
          uri: "file:///workspace/repo/src/feature.ts",
          revision: "abc"
        }
      ]),
      task: "Change the feature flag.",
      assessment: {
        compatibility,
        checkedAt: "2026-10-01T12:00:00.000Z",
        reasonCode,
        source: "git_commit_and_file_identity",
        evidence: []
      }
    });

    assert.equal(
      reconstruction.disposition,
      "uncertain",
      `a ${compatibility} assessment must not reconstruct as usable`
    );
    assert.equal(
      reconstruction.guidance,
      undefined,
      `a ${compatibility} assessment must not carry guidance into the prompt`
    );
    assert.equal(
      reconstruction.rationale,
      "Current authoritative state did not verify this memory."
    );
  }
});
