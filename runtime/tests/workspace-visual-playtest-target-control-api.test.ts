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

import { WorkspaceVisualPlaytestTargetRepository } from "@simulatorlife/autodev-data/workspaces";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const TOKEN = "v".repeat(64);
const WORKSPACE_ID = "fixture/game";
const TARGETS_PATH = `/control/workspaces/${encodeURIComponent(WORKSPACE_ID)}/playtesting-visual-targets`;

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
  episodeCount: 1,
  maxStepsPerEpisode: 80,
  wallTimeMs: 120_000,
  smartRequestsPerEpisode: 30,
  smartTokensPerEpisode: 25_000,
  screenshotCountPerEpisode: 160,
  artifactBytesPerEpisode: 64 * 1024 * 1024
};

function approvalBody(expectedRevision: number | null) {
  return {
    expectedRevision,
    targetId: "racing-game-local",
    name: "RacingGame local browser",
    entryUrl: "http://localhost:5173/",
    allowedOrigins: ["http://localhost:5173"],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    limits
  };
}

function environment(root: string) {
  mkdirSync(path.join(root, "config"), { recursive: true });
  const catalogPath = path.join(root, "config", "workspaces.json");
  writeFileSync(
    catalogPath,
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
  return {
    catalogPath,
    restore: () => {
      if (previous.token === undefined)
        delete process.env.AUTODEV_CONTROL_API_TOKEN;
      else process.env.AUTODEV_CONTROL_API_TOKEN = previous.token;
      if (previous.viewers === undefined)
        delete process.env.AUTODEV_CONTROL_VIEWERS;
      else process.env.AUTODEV_CONTROL_VIEWERS = previous.viewers;
      if (previous.operators === undefined)
        delete process.env.AUTODEV_CONTROL_OPERATORS;
      else process.env.AUTODEV_CONTROL_OPERATORS = previous.operators;
    }
  };
}

async function call(
  root: string,
  repository: WorkspaceVisualPlaytestTargetRepository,
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
    {
      repositoryRoot: root,
      workspaceVisualPlaytestTargetRepository: repository
    }
  );
  return {
    status: response.statusCode,
    headers: response.headers,
    body: JSON.parse(response.body || "{}") as Record<string, unknown>
  };
}

test("visual target approval is operator-only, separate, revisioned, and revocable", async () => {
  const rawRoot = mkdtempSync(
    path.join(tmpdir(), "visual-target-control-api-")
  );
  const root = realpathSync(rawRoot);
  const env = environment(root);
  const repository = new WorkspaceVisualPlaytestTargetRepository(
    path.join(root, "visual-target-approvals")
  );
  try {
    const viewerWrite = await call(
      root,
      repository,
      "POST",
      TARGETS_PATH,
      "workspace-viewer",
      approvalBody(null)
    );
    assert.equal(viewerWrite.status, 403);

    const extra = await call(
      root,
      repository,
      "POST",
      TARGETS_PATH,
      "workspace-operator",
      { ...approvalBody(null), shellCommand: ["node", "server.mjs"] }
    );
    assert.equal(extra.status, 400);
    assert.deepEqual(repository.list(WORKSPACE_ID), []);

    const approved = await call(
      root,
      repository,
      "POST",
      TARGETS_PATH,
      "workspace-operator",
      approvalBody(null)
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.workspaceId, WORKSPACE_ID);
    const targets = approved.body.targets as Record<string, unknown>[];
    assert.equal(targets.length, 1);
    const saved = targets[0]!;
    assert.equal(saved.targetId, "racing-game-local");
    assert.equal(saved.revision, 1);
    assert.equal(saved.approvedBy, "workspace-operator");
    assert.equal(saved.sandboxProfile, "transient-browser-profile");

    const viewerRead = await call(
      root,
      repository,
      "GET",
      TARGETS_PATH,
      "workspace-viewer"
    );
    assert.equal(viewerRead.status, 200);
    assert.deepEqual(viewerRead.body.targets, targets);

    const activeOverwrite = await call(
      root,
      repository,
      "POST",
      TARGETS_PATH,
      "workspace-operator",
      approvalBody(1)
    );
    assert.equal(activeOverwrite.status, 409);

    const revokePath = `${TARGETS_PATH}/racing-game-local/revoke`;
    const revoked = await call(
      root,
      repository,
      "POST",
      revokePath,
      "workspace-operator",
      {
        expectedRevision: 1,
        approvalId: saved.approvalId,
        reason: "The target URL is no longer controlled"
      }
    );
    assert.equal(revoked.status, 200);
    const revokedTarget = (
      revoked.body.targets as Record<string, unknown>[]
    )[0]!;
    assert.equal(revokedTarget.revision, 2);
    assert.equal(revokedTarget.revokedBy, "workspace-operator");

    const reapproved = await call(
      root,
      repository,
      "POST",
      TARGETS_PATH,
      "workspace-operator",
      approvalBody(2)
    );
    assert.equal(reapproved.status, 200);
    assert.equal(
      (reapproved.body.targets as Record<string, unknown>[])[0]?.revision,
      3
    );
  } finally {
    env.restore();
    rmSync(rawRoot, { recursive: true, force: true });
  }
});

test("visual target approval binds workspace scope and refuses unsafe URLs and unknown fields", async () => {
  const rawRoot = mkdtempSync(
    path.join(tmpdir(), "visual-target-invalid-api-")
  );
  const root = realpathSync(rawRoot);
  const env = environment(root);
  const repository = new WorkspaceVisualPlaytestTargetRepository(
    path.join(root, "visual-target-approvals")
  );
  try {
    const unknownWorkspace = await call(
      root,
      repository,
      "POST",
      "/control/workspaces/other%2Fgame/playtesting-visual-targets",
      "workspace-operator",
      approvalBody(null)
    );
    assert.equal(unknownWorkspace.status, 404);

    const query = await call(
      root,
      repository,
      "GET",
      `${TARGETS_PATH}?workspaceId=other%2Fgame`,
      "workspace-viewer"
    );
    assert.equal(query.status, 400);

    const unsafeUrl = await call(
      root,
      repository,
      "POST",
      TARGETS_PATH,
      "workspace-operator",
      {
        ...approvalBody(null),
        entryUrl: "http://games.example.test/"
      }
    );
    assert.equal(unsafeUrl.status, 400);
    assert.deepEqual(repository.list(WORKSPACE_ID), []);

    writeFileSync(
      env.catalogPath,
      JSON.stringify({
        schema: "autodev-workspaces-v1",
        workspaces: [
          {
            id: WORKSPACE_ID,
            baseBranch: "main",
            enabled: false,
            agentRoles: null
          }
        ]
      }),
      "utf8"
    );
    const disabled = await call(
      root,
      repository,
      "POST",
      TARGETS_PATH,
      "workspace-operator",
      approvalBody(null)
    );
    assert.equal(disabled.status, 409);
  } finally {
    env.restore();
    rmSync(rawRoot, { recursive: true, force: true });
  }
});
