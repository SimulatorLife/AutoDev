import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspacePlaytestApproval } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  workspaceApprovalBadgeLabel,
  workspaceApprovalBadgeVariant,
  workspaceApprovalStatus
} from "../src/features/workspaces/approval-status.ts";
import {
  isWorkspaceId,
  isWorkspacesReturnPath,
  workspacePath
} from "../src/features/workspaces/paths.ts";
import { WorkspaceDetailView } from "../src/features/workspaces/WorkspaceDetailView.ts";

const WORKSPACE_ID = "SimulatorLife/FixtureGame";

const LIMITS = {
  cpuCores: 1,
  memoryBytes: 134_217_728,
  processCount: 2,
  wallTimeMs: 60_000,
  artifactBytes: 1_048_576,
  workerCount: 1,
  episodeCount: 10,
  maxStepsPerEpisode: 500,
  critiqueCount: 5
} as const;

function activeApproval(
  overrides: Partial<WorkspacePlaytestApproval> = {}
): WorkspacePlaytestApproval {
  return {
    schema: "autodev-workspace-playtest-approval-v1",
    workspaceId: WORKSPACE_ID,
    revision: 1,
    approvalId: "11111111-1111-1111-1111-111111111111",
    checkoutRoot: "/home/operator/games/fixture",
    buildSha: "a".repeat(40),
    gameBuild: "fixture-game-1.0.0",
    playtestConfigHash: "e".repeat(64),
    adapterImageDigest: "fixture/adapter@sha256:" + "f".repeat(64),
    workingDirectory: "server",
    adapterCommand: ["node", "server.js"],
    allowedScenarios: ["tutorial"],
    allowedPolicies: ["random"],
    limits: LIMITS,
    retentionDays: 30,
    issueReporting: "disabled",
    humanStudyAllowed: false,
    approvedAt: "2026-01-01T00:00:00.000Z",
    approvedBy: "operator",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...overrides
  };
}

test("paths.ts builds and validates exactly the canonical workspace detail route", () => {
  assert.ok(isWorkspaceId(WORKSPACE_ID));
  assert.equal(
    workspacePath(WORKSPACE_ID),
    "/workspaces/SimulatorLife/FixtureGame"
  );
  assert.ok(isWorkspacesReturnPath("/workspaces"));
  assert.ok(isWorkspacesReturnPath(workspacePath(WORKSPACE_ID)));
  assert.ok(!isWorkspacesReturnPath("https://attacker.test/"));
  assert.ok(!isWorkspacesReturnPath("/workspaces/not-a-workspace-id"));
  assert.ok(!isWorkspacesReturnPath("/workspaces/SimulatorLife%2FFixtureGame"));
  assert.ok(!isWorkspacesReturnPath(null));
});

test("approval status is read from the two facts that decide it, not inferred", () => {
  assert.equal(workspaceApprovalStatus(null), "none");
  assert.equal(workspaceApprovalStatus(activeApproval()), "active");
  assert.equal(
    workspaceApprovalStatus(
      activeApproval({
        revokedAt: "2026-02-01T00:00:00.000Z",
        revokedBy: "operator",
        revocationReason: "superseded"
      })
    ),
    "revoked"
  );
  assert.equal(workspaceApprovalBadgeVariant("active"), "valid");
  assert.equal(workspaceApprovalBadgeVariant("revoked"), "invalid");
  assert.equal(workspaceApprovalBadgeVariant("none"), "not-observed");
  assert.equal(workspaceApprovalBadgeVariant("unavailable"), "unavailable");
  assert.equal(workspaceApprovalBadgeLabel("active"), "Active");
});

test("a disabled workspace with no approval cannot approve, and the form is never rendered", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: false,
        agentRoles: null
      },
      approval: null
    })
  );

  assert.match(markup, /data-workspace-approval-blocked="disabled"/u);
  assert.match(markup, /cannot receive a new playtesting approval/u);
  assert.doesNotMatch(
    markup,
    /data-workspace-approval-form=/u,
    "a disabled workspace must never render the Approve form at all"
  );
  assert.match(markup, /data-status="not-observed"/u);
});

test("an enabled workspace with no approval renders the keyboard-accessible Approve form", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      },
      approval: null
    })
  );

  assert.match(
    markup,
    new RegExp(
      `data-workspace-approval-form="${WORKSPACE_ID.replace("/", String.raw`\/`)}"`,
      "u"
    )
  );
  // Every field a screen reader needs is a real `<label for>` pointed at a
  // real id, not a placeholder standing in for a name.
  assert.match(markup, /<label[^>]*for="text-checkoutRoot"/u);
  assert.match(markup, /<input[^>]*id="text-checkoutRoot"/u);
  assert.match(markup, /<label[^>]*for="select-issueReporting"/u);
  assert.doesNotMatch(markup, /data-workspace-approval-blocked=/u);
});

test("an active approval shows its exact identity, command, image and limits, and offers Revoke", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      },
      approval: activeApproval()
    })
  );

  assert.match(markup, /data-status="valid"/u);
  assert.match(markup, /fixture-game-1\.0\.0/u);
  assert.match(markup, /fixture\/adapter@sha256:/u);
  assert.match(markup, /node server\.js/u);
  assert.match(markup, /134217728/u);
  assert.match(
    markup,
    new RegExp(
      `data-workspace-revoke-form="${WORKSPACE_ID.replace("/", String.raw`\/`)}"`,
      "u"
    )
  );
  assert.doesNotMatch(markup, /data-workspace-approval-form=/u);
});

test("a disabled workspace still offers Revoke on its existing active approval", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: false,
        agentRoles: null
      },
      approval: activeApproval()
    })
  );

  assert.match(markup, /data-workspace-approval-blocked="disabled-active"/u);
  assert.match(markup, /disabled workspace cannot run Playtests/u);
  assert.match(
    markup,
    new RegExp(
      `data-workspace-revoke-form="${WORKSPACE_ID.replace("/", String.raw`\/`)}"`,
      "u"
    )
  );
});

test("a revoked approval shows its revocation and offers re-approval when the workspace is enabled", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      },
      approval: activeApproval({
        revokedAt: "2026-02-01T00:00:00.000Z",
        revokedBy: "operator",
        revocationReason: "Build superseded"
      })
    })
  );

  assert.match(markup, /data-status="invalid"/u);
  assert.match(markup, /Build superseded/u);
  assert.match(
    markup,
    new RegExp(
      `data-workspace-approval-form="${WORKSPACE_ID.replace("/", String.raw`\/`)}"`,
      "u"
    )
  );
  // Re-approval seeds `expectedRevision` from the revoked record so the Runtime
  // can detect a second, concurrent write to the same approval slot.
  assert.match(
    markup,
    /<input type="hidden" name="expectedRevision" value="1"/u
  );
});

test("a stale revision conflict is surfaced beside the freshly reloaded approval state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      },
      approval: activeApproval(),
      controlFailed: true,
      refusal: "conflicted"
    })
  );

  assert.match(markup, /data-control-outcome="failed"/u);
  assert.match(markup, /data-control-refusal="conflicted"/u);
  assert.match(
    markup,
    /reload it and decide again/iu,
    "the conflict notice must tell the operator to reload, not merely that it failed"
  );
  // The authoritative, freshly reloaded approval renders beside the notice --
  // this is what makes the conflict "reloadable" rather than a dead end.
  assert.match(markup, /data-status="valid"/u);
});

test("an unreadable approval read renders an explicit unavailable state, not a quiet absence", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      },
      approval: null,
      approvalUnavailable: {
        code: "autodev_workspace_playtesting_store_unavailable",
        message: "Workspace approval storage is unavailable."
      }
    })
  );

  assert.match(markup, /data-status="unavailable"/u);
  assert.match(
    markup,
    /data-workspace-approval-unavailable="autodev_workspace_playtesting_store_unavailable"/u
  );
  assert.doesNotMatch(
    markup,
    /No playtesting approval has been granted/u,
    "an unreadable approval state must never be presented as an observed absence"
  );
  assert.doesNotMatch(markup, /data-workspace-approval-form=/u);
});
