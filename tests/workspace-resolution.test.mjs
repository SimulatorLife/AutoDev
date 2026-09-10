import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  AmbiguousWorkspaceError,
  resolveCwd,
  WorkspaceResolutionError,
} from "../scripts/codex/lib/resolve-workspace.mjs";
import { workspaceContextFromRequest, workspaceMetadataForSession } from "../scripts/codex-model-router.mjs";

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

test("the resolver refuses to let key order pick between real workspaces", async () => {
  await withWorkspace(async (first) => {
    await withWorkspace(async (second) => {
      // Two workspaces that both exist and no statement of which is active.
      // Taking the first made JSON key order decide which repository a coding
      // agent edits -- a turn from one repo could silently land in another.
      const both = (a, b) => ({ "x-codex-turn-metadata": JSON.stringify({ workspaces: { [a]: { git: {} }, [b]: { git: {} } } }) });
      for (const headers of [ both(first, second), both(second, first) ]) {
        assert.throws(() => resolveCwd({}, headers), AmbiguousWorkspaceError);
        // It stays a WorkspaceResolutionError, so every bridge's existing
        // catch still turns it into the same 400 rather than a 500.
        assert.throws(() => resolveCwd({}, headers), WorkspaceResolutionError);
      }

      // The documented operator override settles the ambiguity rather than
      // being shadowed by it.
      assert.equal(resolveCwd({}, both(first, second), second), second);

      // Ambiguity among the value path fields is refused the same way, and a
      // single workspace repeated across key and value is not an ambiguity.
      const values = { "x-codex-turn-metadata": JSON.stringify({ workspaces: { a: { cwd: first }, b: { cwd: second } } }) };
      assert.throws(() => resolveCwd({}, values), AmbiguousWorkspaceError);
      const duplicate = { "x-codex-turn-metadata": JSON.stringify({ workspaces: { a: { cwd: first }, b: { path: first } } }) };
      assert.equal(resolveCwd({}, duplicate), first);

      // An explicit top-level cwd still wins outright: the caller said which.
      assert.equal(resolveCwd({ cwd: second }, both(first, second)), second);
    });
  });
});

test("the router labels a turn with the workspace the bridge will actually use", async () => {
  await withWorkspace(async (real) => {
    // The router and the bridges read the same `workspaces` map from opposite
    // ends -- one to label the turn, one to run it. They used different rules:
    // the router took the first non-empty key, the bridge the first key that
    // is a directory here. A first key that does not exist on this host
    // therefore made telemetry name one repository while the agent edited
    // another, with nothing in the logs showing the split.
    const metadata = JSON.stringify({ workspaces: { "/does/not/exist/on/this/host": { git: {} }, [ real ]: { git: {} } } });
    const label = workspaceContextFromRequest({ headers: {} }, {}, metadata);
    assert.equal(label.cwd, path.basename(real));
    assert.equal(resolveCwd({}, { "x-codex-turn-metadata": metadata }), real);

    // Where the bridge refuses, the router invents no label either.
    await withWorkspace(async (other) => {
      const ambiguous = JSON.stringify({ workspaces: { [ real ]: { git: {} }, [ other ]: { git: {} } } });
      assert.equal(workspaceContextFromRequest({ headers: {} }, {}, ambiguous).cwd, null);
      assert.throws(() => resolveCwd({}, { "x-codex-turn-metadata": ambiguous }), AmbiguousWorkspaceError);
    });
  });
});

test("the router carries a validated workspace across metadata-less continuations", async () => {
  await withWorkspace(async (workspace) => {
    const session = { key: `workspace-session-${workspace}`, scope: "identified" };
    const firstHeader = JSON.stringify({ workspaces: { [workspace]: { git: { branch: "main" } } } });

    // The first request establishes the session's workspace from the same
    // structured metadata the provider bridge will use.
    const established = workspaceMetadataForSession({}, firstHeader, session);
    assert.deepEqual(JSON.parse(established).workspaces, JSON.parse(firstHeader).workspaces);
    assert.equal(JSON.parse(established).workspace_id.startsWith("ws_"), true);

    // A continuation that loses the transport metadata still receives a
    // canonical structured workspace, rather than making the bridge guess.
    const continued = workspaceMetadataForSession({}, null, session);
    assert.equal(resolveCwd({}, { "x-codex-turn-metadata": continued }), workspace);

    // A new/unidentified conversation never inherits another session's path.
    assert.equal(workspaceMetadataForSession({}, null, { key: "process-scope", scope: "process-fallback" }), null);
  });
});

test("workspace continuity does not override an invalid or ambiguous claim", async () => {
  await withWorkspace(async (workspace) => {
    const session = { key: `invalid-workspace-session-${workspace}`, scope: "identified" };
    const firstHeader = JSON.stringify({ workspaces: { [workspace]: { git: {} } } });
    workspaceMetadataForSession({}, firstHeader, session);

    assert.equal(workspaceMetadataForSession({ cwd: "/does/not/exist" }, null, session), null);
    assert.equal(workspaceMetadataForSession({ cwd: 42 }, null, session), null);
    await withWorkspace(async (other) => {
      const ambiguous = JSON.stringify({ workspaces: { [workspace]: { git: {} }, [other]: { git: {} } } });
      assert.equal(workspaceMetadataForSession({}, ambiguous, session), ambiguous);
    });
  });
});
