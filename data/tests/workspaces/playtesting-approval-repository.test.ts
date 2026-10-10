import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspacePlaytestApproval } from "@simulatorlife/autodev-core";

import {
  WorkspacePlaytestApprovalConflictError,
  WorkspacePlaytestApprovalRepository,
  WorkspacePlaytestApprovalStoreError
} from "../../src/workspaces/playtesting-approval-repository.ts";

function temporaryRoot(): {
  readonly path: string;
  readonly cleanup: () => void;
} {
  const rawRoot = mkdtempSync(
    path.join(tmpdir(), "autodev-workspace-approval-")
  );
  const root = realpathSync(rawRoot);
  return {
    path: root,
    cleanup: () => rmSync(rawRoot, { recursive: true, force: true })
  };
}

function approval(
  overrides: Partial<WorkspacePlaytestApproval> = {}
): WorkspacePlaytestApproval {
  return {
    schema: "autodev-workspace-playtest-approval-v1",
    workspaceId: "owner/game",
    revision: 1,
    approvalId: "approval-1",
    checkoutRoot: "/Users/operator/game",
    buildSha: "a".repeat(40),
    gameBuild: "game-build-1",
    playtestConfigHash: "b".repeat(64),
    adapterImageDigest: `ghcr.io/owner/adapter@sha256:${"c".repeat(64)}`,
    workingDirectory: ".",
    adapterCommand: ["/usr/bin/node", "adapter.mjs"],
    allowedScenarios: ["tutorial"],
    allowedPolicies: ["heuristic"],
    limits: {
      cpuCores: 1,
      memoryBytes: 256 * 1024 * 1024,
      processCount: 16,
      wallTimeMs: 30_000,
      artifactBytes: 16 * 1024 * 1024,
      workerCount: 1,
      episodeCount: 1000,
      maxStepsPerEpisode: 500,
      critiqueCount: 40
    },
    retentionDays: 14,
    issueReporting: "disabled",
    humanStudyAllowed: false,
    approvedAt: "2026-10-10T00:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...overrides
  };
}

test("Workspaces approval repository keeps approvals local, private, versioned, and revocable", () => {
  const root = temporaryRoot();
  try {
    const repository = new WorkspacePlaytestApprovalRepository(root.path);
    assert.equal(repository.read("owner/game"), null);

    const first = repository.approve(approval(), null);
    assert.equal(first.revision, 1);
    assert.deepEqual(repository.read("owner/game"), first);

    const recordDirectory = path.join(
      root.path,
      createHash("sha256").update("owner/game").digest("hex")
    );
    const recordPath = path.join(recordDirectory, "approval.json");
    assert.equal(lstatSync(root.path).mode & 0o777, 0o700);
    assert.equal(lstatSync(recordDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(recordPath).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(recordPath, "utf8").includes("checkoutRoot"),
      true
    );
    assert.equal(repository.read("owner/other"), null);

    assert.throws(
      () => repository.approve(approval({ approvalId: "approval-2" }), null),
      WorkspacePlaytestApprovalConflictError
    );
    assert.throws(
      () =>
        repository.revoke(
          "owner/game",
          "approval-1",
          9,
          "2026-10-10T00:01:00.000Z",
          "operator-2",
          "Pause playtesting pending adapter review"
        ),
      WorkspacePlaytestApprovalConflictError
    );

    const revoked = repository.revoke(
      "owner/game",
      "approval-1",
      1,
      "2026-10-10T00:01:00.000Z",
      "operator-2",
      "Pause playtesting pending adapter review"
    );
    assert.equal(revoked.revision, 2);
    assert.equal(revoked.revokedAt, "2026-10-10T00:01:00.000Z");
    assert.equal(revoked.revokedBy, "operator-2");
    assert.equal(
      revoked.revocationReason,
      "Pause playtesting pending adapter review"
    );
    assert.deepEqual(repository.read("owner/game"), revoked);

    const replacement = repository.approve(
      approval({ approvalId: "approval-2", approvedBy: "operator-2" }),
      2
    );
    assert.equal(replacement.revision, 3);
    assert.equal(replacement.approvalId, "approval-2");
    assert.equal(replacement.revokedAt, null);
  } finally {
    root.cleanup();
  }
});

test("Workspaces approval repository rejects symlink roots and symlinked records", () => {
  const root = temporaryRoot();
  const outside = temporaryRoot();
  try {
    const link = path.join(root.path, "linked-root");
    symlinkSync(outside.path, link);
    assert.throws(
      () => new WorkspacePlaytestApprovalRepository(link),
      WorkspacePlaytestApprovalStoreError
    );

    const repository = new WorkspacePlaytestApprovalRepository(root.path);
    repository.approve(approval(), null);
    const key = createHash("sha256").update("owner/game").digest("hex");
    const recordDirectory = path.join(root.path, key);
    const recordPath = path.join(recordDirectory, "approval.json");
    rmSync(recordPath);
    symlinkSync(path.join(outside.path, "secret.json"), recordPath);
    assert.throws(
      () => repository.read("owner/game"),
      WorkspacePlaytestApprovalStoreError
    );
  } finally {
    root.cleanup();
    outside.cleanup();
  }
});

test("Workspaces approval repository fails closed on malformed JSON and invalid revocation time", () => {
  const root = temporaryRoot();
  try {
    const repository = new WorkspacePlaytestApprovalRepository(root.path);
    repository.approve(approval(), null);
    const key = createHash("sha256").update("owner/game").digest("hex");
    const recordPath = path.join(root.path, key, "approval.json");
    writeFileSync(recordPath, "{bad", "utf8");
    assert.throws(
      () => repository.read("owner/game"),
      WorkspacePlaytestApprovalStoreError
    );

    writeFileSync(recordPath, JSON.stringify(approval()), "utf8");
    assert.throws(
      () =>
        repository.revoke(
          "owner/game",
          "approval-1",
          1,
          "not-a-timestamp",
          "operator-2",
          "Invalid test time"
        ),
      /timestamp is invalid/u
    );
  } finally {
    root.cleanup();
  }
});
