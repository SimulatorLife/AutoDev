import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadRulesyncWorkspaces,
  slugifyWorkspace,
  syncRulesyncWorkspaces
} from "@simulatorlife/autodev-data/openlit";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("slugifyWorkspace generates clean, lowercase alphanumeric URL slugs", () => {
  assert.equal(
    slugifyWorkspace("SimulatorLife/AutoDev"),
    "simulatorlife-autodev"
  );
  assert.equal(
    slugifyWorkspace("SimulatorLife/Colourful-Life"),
    "simulatorlife-colourful-life"
  );
  assert.equal(
    slugifyWorkspace("  SimulatorLife/3DSpider! "),
    "simulatorlife-3dspider"
  );
});

test("loadRulesyncWorkspaces extracts all 5 canonical workspaces from weights.json", () => {
  const catalog = loadRulesyncWorkspaces(repositoryRoot);

  const expectedWorkspaces = [
    "SimulatorLife/3DSpider",
    "SimulatorLife/AutoDev",
    "SimulatorLife/Colourful-Life",
    "SimulatorLife/GMLoop",
    "SimulatorLife/RacingGame"
  ];

  assert.equal(catalog.size, expectedWorkspaces.length);

  for (const name of expectedWorkspaces) {
    assert.ok(catalog.has(name), `Catalog must contain workspace "${name}"`);
    const ws = catalog.get(name)!;
    assert.equal(ws.name, name);
    assert.match(ws.baseBranch, /^(main|master)$/u);
    assert.ok(typeof ws.weight === "number" && ws.weight >= 0);
    assert.ok(ws.slug.length > 0);
  }

  // Colourful-Life has base branch 'master'
  const colourfulLife = catalog.get("SimulatorLife/Colourful-Life")!;
  assert.equal(colourfulLife.baseBranch, "master");

  // RacingGame has weight 1
  const racingGame = catalog.get("SimulatorLife/RacingGame")!;
  assert.equal(racingGame.weight, 1);
});

test("loadRulesyncWorkspaces rejects an invalid shared workspace source", async () => {
  const isolatedRoot = await mkdtemp(
    join(tmpdir(), "autodev-workspace-source-")
  );
  try {
    const configDirectory = join(isolatedRoot, ".github", "workflows");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "weights.json"),
      JSON.stringify({
        repositories: [{ name: "missing/base-branch", weight: 1 }]
      }),
      "utf8"
    );
    assert.throws(
      () => loadRulesyncWorkspaces(isolatedRoot),
      /workspace catalog is invalid/u
    );
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});

test("syncRulesyncWorkspaces synchronizes canonical AutoDev project under SimulatorLife organisation and collapses silos idempotently", async () => {
  try {
    const result1 = await syncRulesyncWorkspaces({ repositoryRoot });
    assert.equal(result1.organisation, "SimulatorLife");
    assert.equal(result1.project, "AutoDev");
    assert.equal(result1.environment, "production");
    assert.equal(result1.totalWorkspaces, 5);
    assert.ok(result1.workspaces.includes("SimulatorLife/AutoDev"));
    assert.ok(result1.workspaces.includes("SimulatorLife/RacingGame"));

    // Second run must be completely idempotent (0 collapsed silos)
    const result2 = await syncRulesyncWorkspaces({ repositoryRoot });
    assert.equal(result2.organisation, "SimulatorLife");
    assert.equal(result2.project, "AutoDev");
    assert.equal(result2.environment, "production");
    assert.equal(
      result2.collapsedProjects.length,
      0,
      "Second run should have 0 projects to collapse"
    );
    assert.equal(result2.totalWorkspaces, 5);
  } catch (error) {
    const message = (error as Error).message;
    if (
      message.includes("Cannot connect to the Docker daemon") ||
      message.includes("No such container") ||
      message.includes("ENOENT")
    ) {
      // Docker container not running in this environment — skip gracefully
      return;
    }
    throw error;
  }
});
