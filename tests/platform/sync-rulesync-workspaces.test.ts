import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadRulesyncWorkspaces,
  slugifyWorkspace,
  syncRulesyncWorkspaces
} from "../../src/platform/sync-rulesync-workspaces.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

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

test("syncRulesyncWorkspaces synchronizes workspaces idempotently to OpenLIT projects", async () => {
  try {
    const result1 = await syncRulesyncWorkspaces({ repositoryRoot });
    assert.equal(result1.totalWorkspaces, 5);

    // Second run must be completely unchanged (idempotent)
    const result2 = await syncRulesyncWorkspaces({ repositoryRoot });
    assert.equal(result2.inserted.length, 0, "Second run should insert 0");
    assert.equal(
      result2.unchanged.length,
      5,
      "All 5 workspaces must be reported unchanged"
    );
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
