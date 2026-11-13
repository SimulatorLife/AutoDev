import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as publicPlaytesting from "../src/playtesting/index.ts";
import * as mcp from "../src/playtesting/mcp.ts";
import * as runControl from "../src/playtesting/run-control.ts";

const playtestingSource = (file: string): string =>
  readFileSync(new URL(`../src/playtesting/${file}`, import.meta.url), "utf8");

test("run-control.ts owns the Playtest run owner; mcp.ts is only the gateway", () => {
  assert.equal(typeof runControl.createPlaytestRunControl, "function");
  assert.equal("createPlaytestRunControl" in mcp, false);
  assert.equal(typeof mcp.createPlaytestMcpServer, "function");
  assert.equal("createPlaytestMcpServer" in runControl, false);
  assert.equal(typeof publicPlaytesting.createPlaytestRunControl, "function");
  assert.equal("authorizeWorkspace" in publicPlaytesting, false);
});

test("run-control ownership has no cycle and its service consumes the owner directly", () => {
  assert.doesNotMatch(
    playtestingSource("run-control.ts"),
    /from "\.\/mcp\.ts"/
  );
  const service = playtestingSource("run-control-service.ts");
  assert.match(service, /from "\.\/run-control\.ts"/);
  assert.doesNotMatch(service, /from "\.\/mcp\.ts"/);
});
