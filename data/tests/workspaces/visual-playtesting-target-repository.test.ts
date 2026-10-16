import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspaceVisualPlaytestTargetApproval } from "@simulatorlife/autodev-core";

import {
  WorkspaceVisualPlaytestTargetConflictError,
  WorkspaceVisualPlaytestTargetRepository,
  WorkspaceVisualPlaytestTargetStoreError
} from "../../src/workspaces/visual-playtesting-target-repository.ts";

function temporaryRoot(): {
  readonly path: string;
  readonly cleanup: () => void;
} {
  const rawRoot = mkdtempSync(
    path.join(tmpdir(), "autodev-visual-playtest-targets-")
  );
  const root = realpathSync(rawRoot);
  return {
    path: root,
    cleanup: () => rmSync(rawRoot, { recursive: true, force: true })
  };
}

function target(
  overrides: Partial<WorkspaceVisualPlaytestTargetApproval> = {}
): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: "owner/game",
    targetId: "racing-game-local",
    revision: 1,
    approvalId: "visual-approval-1",
    name: "RacingGame local browser",
    entryUrl: "http://localhost:5173/",
    allowedOrigins: ["http://localhost:5173"],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 80,
      wallTimeMs: 120_000,
      smartRequestsPerEpisode: 30,
      smartTokensPerEpisode: 25_000,
      screenshotCountPerEpisode: 160,
      artifactBytesPerEpisode: 64 * 1024 * 1024
    },
    approvedAt: "2026-10-16T12:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...overrides
  };
}

function key(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("visual target repository persists one workspace-scoped revocable approval per target", () => {
  const root = temporaryRoot();
  try {
    const repository = new WorkspaceVisualPlaytestTargetRepository(root.path);
    assert.equal(repository.read("owner/game", "racing-game-local"), null);
    assert.deepEqual(repository.list("owner/game"), []);

    const first = repository.approve(target(), null);
    assert.equal(first.revision, 1);
    assert.deepEqual(repository.read("owner/game", first.targetId), first);
    assert.deepEqual(repository.list("owner/game"), [first]);
    assert.equal(repository.read("owner/other", first.targetId), null);

    const workspaceDirectory = path.join(root.path, key("owner/game"));
    const targetDirectory = path.join(workspaceDirectory, key(first.targetId));
    const recordPath = path.join(targetDirectory, "approval.json");
    assert.equal(lstatSync(root.path).mode & 0o777, 0o700);
    assert.equal(lstatSync(workspaceDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(targetDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(recordPath).mode & 0o777, 0o600);
    const serialized = readFileSync(recordPath, "utf8");
    assert.equal(serialized.includes("entryUrl"), true);
    assert.equal(serialized.includes("password"), false);

    assert.throws(
      () => repository.approve(target({ approvalId: "other" }), null),
      WorkspaceVisualPlaytestTargetConflictError
    );
    assert.throws(
      () =>
        repository.revoke(
          "owner/game",
          first.targetId,
          first.approvalId,
          9,
          "2026-10-16T12:30:00.000Z",
          "operator-2",
          "Stop browser access"
        ),
      WorkspaceVisualPlaytestTargetConflictError
    );

    const revoked = repository.revoke(
      "owner/game",
      first.targetId,
      first.approvalId,
      1,
      "2026-10-16T12:30:00.000Z",
      "operator-2",
      "Stop browser access"
    );
    assert.equal(revoked.revision, 2);
    assert.equal(revoked.revokedBy, "operator-2");
    assert.deepEqual(repository.read("owner/game", first.targetId), revoked);

    const replacement = repository.approve(
      target({ approvalId: "visual-approval-2", approvedBy: "operator-2" }),
      2
    );
    assert.equal(replacement.revision, 3);
    assert.equal(replacement.approvalId, "visual-approval-2");
    assert.deepEqual(repository.list("owner/game"), [replacement]);

    const second = repository.approve(
      target({ targetId: "another-game", approvalId: "visual-approval-3" }),
      null
    );
    assert.deepEqual(
      repository.list("owner/game").map((approval) => approval.targetId),
      ["another-game", "racing-game-local"]
    );
    assert.equal(second.targetId, "another-game");
  } finally {
    root.cleanup();
  }
});

test("visual target repository rejects symlink roots, workspace directories, and target records", () => {
  const root = temporaryRoot();
  const outside = temporaryRoot();
  try {
    const linkedRoot = path.join(root.path, "linked-root");
    symlinkSync(outside.path, linkedRoot);
    assert.throws(
      () => new WorkspaceVisualPlaytestTargetRepository(linkedRoot),
      WorkspaceVisualPlaytestTargetStoreError
    );

    const repository = new WorkspaceVisualPlaytestTargetRepository(root.path);
    repository.approve(target(), null);
    const workspaceDirectory = path.join(root.path, key("owner/game"));
    const targetDirectory = path.join(
      workspaceDirectory,
      key("racing-game-local")
    );
    const recordPath = path.join(targetDirectory, "approval.json");

    rmSync(recordPath);
    symlinkSync(path.join(outside.path, "approval.json"), recordPath);
    assert.throws(
      () => repository.read("owner/game", "racing-game-local"),
      WorkspaceVisualPlaytestTargetStoreError
    );

    rmSync(recordPath);
    writeFileSync(
      recordPath,
      JSON.stringify(target({ workspaceId: "owner/other" })),
      "utf8"
    );
    assert.throws(
      () => repository.read("owner/game", "racing-game-local"),
      WorkspaceVisualPlaytestTargetStoreError
    );
  } finally {
    root.cleanup();
    outside.cleanup();
  }
});

test("visual target repository fails closed on malformed records and tampered directory keys", () => {
  const root = temporaryRoot();
  try {
    const repository = new WorkspaceVisualPlaytestTargetRepository(root.path);
    repository.approve(target(), null);
    const workspaceDirectory = path.join(root.path, key("owner/game"));
    const targetDirectory = path.join(
      workspaceDirectory,
      key("racing-game-local")
    );
    const recordPath = path.join(targetDirectory, "approval.json");
    writeFileSync(recordPath, "{bad", "utf8");
    assert.throws(
      () => repository.read("owner/game", "racing-game-local"),
      WorkspaceVisualPlaytestTargetStoreError
    );

    writeFileSync(recordPath, JSON.stringify(target()), "utf8");
    assert.equal(repository.read("owner/game", "other-target"), null);
    const tamperedDirectory = path.join(
      workspaceDirectory,
      key("different-target")
    );
    renameSync(targetDirectory, tamperedDirectory);
    assert.throws(
      () => repository.list("owner/game"),
      WorkspaceVisualPlaytestTargetStoreError
    );
  } finally {
    root.cleanup();
  }
});
