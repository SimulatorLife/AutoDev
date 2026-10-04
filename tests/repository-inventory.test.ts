import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface WorkspaceConfig {
  schema: "autodev-workspaces-v1";
  workspaces: Array<{
    id: string;
    baseBranch: string;
    enabled: boolean;
    agentRoles: readonly string[] | null;
  }>;
}
interface WeightConfig {
  repositories: Array<{ workspaceId: string; weight: number }>;
}

const workspaceConfig = JSON.parse(
  await readFile(new URL("../config/workspaces.json", import.meta.url), "utf8")
) as WorkspaceConfig;
const weights = JSON.parse(
  await readFile(
    new URL("../.github/workflows/weights.json", import.meta.url),
    "utf8"
  )
) as WeightConfig;
const expectedRepositories = new Set([
  "SimulatorLife/3DSpider",
  "SimulatorLife/AutoDev",
  "SimulatorLife/Colourful-Life",
  "SimulatorLife/GMLoop",
  "SimulatorLife/RacingGame"
]);

test("canonical Workspace catalog includes the current SimulatorLife repositories", () => {
  assert.equal(workspaceConfig.schema, "autodev-workspaces-v1");
  assert.deepEqual(
    new Set(workspaceConfig.workspaces.map((workspace) => workspace.id)),
    expectedRepositories
  );
});

test("Workspace configuration owns repository identity, branch, enablement, and scope", () => {
  for (const workspace of workspaceConfig.workspaces) {
    assert.match(workspace.id, /^[^/\s]+\/[^/\s]+$/u);
    assert.match(workspace.baseBranch, /^[A-Za-z0-9._/-]+$/u, workspace.id);
    assert.equal(typeof workspace.enabled, "boolean");
    assert.ok(
      workspace.agentRoles === null || Array.isArray(workspace.agentRoles),
      workspace.id
    );
  }
  assert.equal(
    workspaceConfig.workspaces.find(
      (workspace) => workspace.id === "SimulatorLife/Colourful-Life"
    )?.baseBranch,
    "master"
  );
});

test("scheduler policy references every canonical workspace without duplicating identity metadata", () => {
  const ids = new Set<string>();
  for (const entry of weights.repositories) {
    assert.match(entry.workspaceId, /^[^/\s]+\/[^/\s]+$/u);
    assert.equal(expectedRepositories.has(entry.workspaceId), true);
    assert.equal(ids.has(entry.workspaceId), false);
    ids.add(entry.workspaceId);
    assert.equal(Number.isFinite(entry.weight), true);
    assert.equal("name" in entry, false);
    assert.equal("baseBranch" in entry, false);
  }
  assert.deepEqual(ids, expectedRepositories);
});
