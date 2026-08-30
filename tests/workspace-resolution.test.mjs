import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  resolveCwd,
  WorkspaceResolutionError,
} from "../scripts/codex/lib/resolve-workspace.mjs";

async function withWorkspace(callback) {
  const workspace = await mkdtemp(path.join(tmpdir(), "autodev-workspace-"));
  try {
    return await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("shared workspace resolver keeps the structured resolution order", async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(resolveCwd({ cwd: workspace }, {}), workspace);
    assert.equal(resolveCwd({ metadata: { project_root: workspace } }, {}), workspace);

    const metadata = JSON.stringify({
      workspaces: {
        [workspace]: { git: { branch: "main" } },
        stale: { cwd: "/does/not/exist" },
      },
    });
    assert.equal(resolveCwd({}, { "x-codex-turn-metadata": metadata }), workspace);
    assert.equal(
      resolveCwd({ client_metadata: { "x-codex-turn-metadata": { workspaces: { main: workspace } } } }, {}),
      workspace,
    );
  });
});

test("shared workspace resolver preserves explicit override and fails closed", async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(resolveCwd({}, {}, workspace), workspace);
    assert.throws(
      () => resolveCwd({}, {}),
      (error) => error instanceof WorkspaceResolutionError && /refusing to guess a workspace/.test(error.message),
    );
  });
});
