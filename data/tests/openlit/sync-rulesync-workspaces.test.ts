import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ConfigRepository } from "../../src/config/config-repository.ts";
import {
  loadRulesyncWorkspaces,
  syncRulesyncWorkspaces
} from "../../src/openlit/sync-rulesync-workspaces.ts";
import { openLitContainerSkipReason } from "./live-services.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const expectedWorkspaceIds = [
  "SimulatorLife/3DSpider",
  "SimulatorLife/AutoDev",
  "SimulatorLife/Colourful-Life",
  "SimulatorLife/GMLoop",
  "SimulatorLife/RacingGame"
];

test("Data's workspace catalog is the single workspace identity and branch source", () => {
  const catalog = new ConfigRepository(repositoryRoot).readWorkspaceCatalog();
  assert.equal(catalog.status, "valid");
  assert.deepEqual(
    catalog.workspaces.map((workspace) => workspace.id),
    expectedWorkspaceIds
  );
  assert.equal(
    catalog.workspaces.find(
      (workspace) => workspace.id === "SimulatorLife/Colourful-Life"
    )?.baseBranch,
    "master"
  );
  assert.ok(catalog.workspaces.every((workspace) => workspace.enabled));
  assert.ok(
    catalog.workspaces.every((workspace) => workspace.agentRoles === null)
  );
});

test("OpenLIT workspace projection consumes Data's canonical workspace ids", () => {
  const workspaces = loadRulesyncWorkspaces(repositoryRoot);
  assert.deepEqual(
    workspaces.map((workspace) => workspace.id),
    expectedWorkspaceIds
  );
});

test("OpenLIT workspace projection fails closed for an invalid canonical registry", async () => {
  const isolatedRoot = await mkdtemp(
    join(tmpdir(), "autodev-workspace-source-")
  );
  try {
    const configDirectory = join(isolatedRoot, "config");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "workspaces.json"),
      JSON.stringify({
        schema: "autodev-workspaces-v1",
        workspaces: [{ id: "SimulatorLife/Missing", enabled: true }]
      }),
      "utf8"
    );
    assert.throws(
      () => loadRulesyncWorkspaces(isolatedRoot),
      /Workspace catalog is invalid/u
    );
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});

test(
  "syncRulesyncWorkspaces synchronizes canonical AutoDev project and collapses silos idempotently",
  { skip: await openLitContainerSkipReason() },
  async () => {
    const result1 = await syncRulesyncWorkspaces({ repositoryRoot });
    assert.equal(result1.organisation, "SimulatorLife");
    assert.equal(result1.project, "AutoDev");
    assert.equal(result1.environment, "production");
    assert.equal(result1.totalWorkspaces, expectedWorkspaceIds.length);
    assert.ok(result1.workspaces.includes("SimulatorLife/AutoDev"));
    assert.ok(result1.workspaces.includes("SimulatorLife/RacingGame"));

    const result2 = await syncRulesyncWorkspaces({ repositoryRoot });
    assert.equal(result2.organisation, "SimulatorLife");
    assert.equal(result2.project, "AutoDev");
    assert.equal(result2.environment, "production");
    assert.equal(
      result2.collapsedProjects.length,
      0,
      "Second run should have 0 projects to collapse"
    );
    assert.equal(result2.totalWorkspaces, expectedWorkspaceIds.length);
  }
);
