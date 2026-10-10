import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const TOKEN = "w".repeat(64);
const WORKSPACE_ID = "fixture/game";

function request(
  method: string,
  url: string,
  actor: string,
  body?: Record<string, unknown>
): IncomingMessage {
  const headers: Record<string, string> = {
    host: "127.0.0.1",
    authorization: `Bearer ${TOKEN}`,
    "x-autodev-actor": actor
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return Object.assign(
    Readable.from(body === undefined ? [] : [JSON.stringify(body)]),
    { method, url, headers }
  ) as IncomingMessage;
}

const limits = {
  cpuCores: 1,
  memoryBytes: 256 * 1024 * 1024,
  processCount: 16,
  wallTimeMs: 30_000,
  artifactBytes: 16 * 1024 * 1024,
  workerCount: 1,
  episodeCount: 1000,
  maxStepsPerEpisode: 500,
  critiqueCount: 40
};

function approvalBody(expectedRevision: number | null) {
  return {
    expectedRevision,
    checkoutRoot: "/Users/operator/fixture-game",
    buildSha: "a".repeat(40),
    gameBuild: "fixture-build",
    playtestConfigHash: "b".repeat(64),
    adapterImageDigest: `ghcr.io/owner/adapter@sha256:${"c".repeat(64)}`,
    workingDirectory: ".",
    adapterCommand: ["/usr/bin/node", "adapter.mjs"],
    allowedScenarios: ["tutorial"],
    allowedPolicies: ["heuristic"],
    limits,
    retentionDays: 14,
    issueReporting: "review",
    humanStudyAllowed: false
  };
}

function environment(root: string) {
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(
    path.join(root, "config", "workspaces.json"),
    JSON.stringify({
      schema: "autodev-workspaces-v1",
      workspaces: [
        {
          id: WORKSPACE_ID,
          baseBranch: "main",
          enabled: true,
          agentRoles: null
        }
      ]
    }),
    "utf8"
  );
  const previous = {
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    viewers: process.env.AUTODEV_CONTROL_VIEWERS,
    operators: process.env.AUTODEV_CONTROL_OPERATORS
  };
  process.env.AUTODEV_CONTROL_API_TOKEN = TOKEN;
  process.env.AUTODEV_CONTROL_VIEWERS = "workspace-viewer";
  process.env.AUTODEV_CONTROL_OPERATORS = "workspace-operator";
  return () => {
    if (previous.token === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previous.token;
    if (previous.viewers === undefined)
      delete process.env.AUTODEV_CONTROL_VIEWERS;
    else process.env.AUTODEV_CONTROL_VIEWERS = previous.viewers;
    if (previous.operators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previous.operators;
  };
}

async function call(
  root: string,
  repository: WorkspacePlaytestApprovalRepository,
  method: string,
  route: string,
  actor: string,
  body?: Record<string, unknown>
) {
  const response = responseRecorder();
  await handleControlApiRequest(
    request(method, route, actor, body),
    response,
    new URL(route, "http://127.0.0.1").pathname,
    { repositoryRoot: root, workspacePlaytestApprovalRepository: repository }
  );
  return {
    status: response.statusCode,
    headers: response.headers,
    body: JSON.parse(response.body || "{}") as Record<string, unknown>
  };
}

test("Workspace Control API approval is operator-only, exact, revisioned, and revocable", async () => {
  const rawRoot = mkdtempSync(
    path.join(tmpdir(), "autodev-workspace-approval-api-")
  );
  const root = realpathSync(rawRoot);
  const restore = environment(root);
  const repository = new WorkspacePlaytestApprovalRepository(
    path.join(root, "approvals")
  );
  const base = `/control/workspaces/${encodeURIComponent(WORKSPACE_ID)}/playtesting-approval`;
  try {
    const viewerWrite = await call(
      root,
      repository,
      "POST",
      base,
      "workspace-viewer",
      approvalBody(null)
    );
    assert.equal(viewerWrite.status, 403);

    const approved = await call(
      root,
      repository,
      "POST",
      base,
      "workspace-operator",
      approvalBody(null)
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.workspaceId, WORKSPACE_ID);
    const saved = approved.body.approval as Record<string, unknown>;
    assert.equal(saved.revision, 1);
    assert.equal(saved.approvedBy, "workspace-operator");
    assert.equal(saved.revokedAt, null);

    const viewerRead = await call(
      root,
      repository,
      "GET",
      base,
      "workspace-viewer"
    );
    assert.equal(viewerRead.status, 200);
    assert.deepEqual(viewerRead.body.approval, saved);

    const activeOverwrite = await call(
      root,
      repository,
      "POST",
      base,
      "workspace-operator",
      approvalBody(1)
    );
    assert.equal(activeOverwrite.status, 409);

    const revoked = await call(
      root,
      repository,
      "POST",
      base + "/revoke",
      "workspace-operator",
      {
        expectedRevision: 1,
        approvalId: saved.approvalId,
        reason: "Adapter image review required"
      }
    );
    assert.equal(revoked.status, 200);
    const revokedRecord = revoked.body.approval as Record<string, unknown>;
    assert.equal(revokedRecord.revision, 2);
    assert.equal(revokedRecord.revokedBy, "workspace-operator");
    assert.equal(
      revokedRecord.revocationReason,
      "Adapter image review required"
    );

    const reapproved = await call(
      root,
      repository,
      "POST",
      base,
      "workspace-operator",
      approvalBody(2)
    );
    assert.equal(reapproved.status, 200);
    assert.equal(
      (reapproved.body.approval as Record<string, unknown>).revision,
      3
    );
  } finally {
    restore();
    rmSync(rawRoot, { recursive: true, force: true });
  }
});

test("Workspace Control API rejects unknown workspaces and caller-added approval fields", async () => {
  const rawRoot = mkdtempSync(
    path.join(tmpdir(), "autodev-workspace-approval-invalid-")
  );
  const root = realpathSync(rawRoot);
  const restore = environment(root);
  const repository = new WorkspacePlaytestApprovalRepository(
    path.join(root, "approvals")
  );
  const base = `/control/workspaces/${encodeURIComponent(WORKSPACE_ID)}/playtesting-approval`;
  try {
    const unknown = await call(
      root,
      repository,
      "POST",
      "/control/workspaces/other%2Fgame/playtesting-approval",
      "workspace-operator",
      approvalBody(null)
    );
    assert.equal(unknown.status, 404);

    const extra = await call(
      root,
      repository,
      "POST",
      base,
      "workspace-operator",
      { ...approvalBody(null), workspaceId: "other/game" }
    );
    assert.equal(extra.status, 400);
    assert.equal(repository.read(WORKSPACE_ID), null);
  } finally {
    restore();
    rmSync(rawRoot, { recursive: true, force: true });
  }
});
