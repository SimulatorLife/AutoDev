import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PROMPT_ROLES, ROLES } from "../src/platform/install-materializer.ts";
import { ROLE_NAMES, ROUTING_POLICY } from "../src/router/routing.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("playtester and playtest-analyst are registered in install/materialization roles", () => {
  assert.ok(ROLES.includes("playtester"), "ROLES must include playtester");
  assert.ok(
    ROLES.includes("playtest-analyst"),
    "ROLES must include playtest-analyst"
  );
  assert.ok(
    PROMPT_ROLES.includes("playtester"),
    "PROMPT_ROLES must include playtester"
  );
  assert.ok(
    PROMPT_ROLES.includes("playtest-analyst"),
    "PROMPT_ROLES must include playtest-analyst"
  );
});

test("router resolves playtest role names, aliases, and tier model assignments", () => {
  assert.ok(
    ROLE_NAMES.includes("playtester"),
    "ROLE_NAMES must include playtester"
  );
  assert.ok(
    ROLE_NAMES.includes("playtest-analyst"),
    "ROLE_NAMES must include playtest-analyst"
  );

  assert.equal(ROUTING_POLICY.roleForModel("autodev/playtester"), "playtester");
  assert.equal(
    ROUTING_POLICY.roleForModel("autodev/playtest-analyst"),
    "playtest-analyst"
  );

  const defaultTier = ROUTING_POLICY.config.roles.playtester?.tier;
  assert.equal(defaultTier, "default", "playtester must map to default tier");

  const smartTier = ROUTING_POLICY.config.roles["playtest-analyst"]?.tier;
  assert.equal(smartTier, "smart", "playtest-analyst must map to smart tier");

  const playtesterCandidates = ROUTING_POLICY.roleCandidates("playtester");
  assert.ok(playtesterCandidates.length > 0);

  const analystCandidates = ROUTING_POLICY.roleCandidates("playtest-analyst");
  assert.ok(analystCandidates.length > 0);

  const catalogIds = ROUTING_POLICY.catalogModelIds([]);
  assert.ok(catalogIds.includes("autodev/playtester"));
  assert.ok(catalogIds.includes("autodev/playtest-analyst"));
});

test("execution contract defines read-only playtest roles with scoped tools", () => {
  const contractPath = join(repoRoot, "config/execution-contract.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
    roles: Record<
      string,
      {
        kind: string;
        readOnly: boolean;
        mcp: string[];
        skills: string[];
        mcpTools?: Record<string, string[]>;
      }
    >;
  };

  const playtester = contract.roles.playtester;
  assert.ok(playtester, "playtester must be declared in execution contract");
  assert.equal(playtester.kind, "leaf");
  assert.equal(playtester.readOnly, true);
  assert.deepEqual(playtester.mcp, ["playtest"]);
  assert.deepEqual(playtester.skills, ["game-playtesting"]);
  assert.deepEqual(playtester.mcpTools?.playtest, [
    "playtest.capabilities",
    "playtest.run",
    "playtest.wait",
    "playtest.activeRuns",
    "playtest.cancel",
    "playtest.listEpisodes",
    "playtest.readEpisode",
    "playtest.readWindow"
  ]);

  const analyst = contract.roles["playtest-analyst"];
  assert.ok(analyst, "playtest-analyst must be declared in execution contract");
  assert.equal(analyst.kind, "leaf");
  assert.equal(analyst.readOnly, true);
  assert.deepEqual(analyst.mcp, ["playtest"]);
  assert.deepEqual(analyst.skills, ["playtest-analysis"]);
  assert.deepEqual(analyst.mcpTools?.playtest, [
    "playtest.listEpisodes",
    "playtest.readEpisode",
    "playtest.readWindow",
    "playtest.metrics",
    "playtest.compare",
    "playtest.submitReview"
  ]);

  // Ensure smart role does not have playtest MCP server added
  const smart = contract.roles.smart;
  assert.ok(smart, "smart must be declared");
  assert.ok(!smart.mcp.includes("playtest"), "smart must not inherit playtest");
});
