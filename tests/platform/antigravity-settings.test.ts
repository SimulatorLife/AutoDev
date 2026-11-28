import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  antigravitySkillsStatus,
  expectedPermissionGrants,
  missingAntigravityPermissions,
  normalizedReadRoots,
  projectedAntigravityBaseline,
  updateAntigravityPermissions,
  updateAntigravitySkills
} from "@simulatorlife/autodev-runtime/platform/antigravity-settings";

import { withTempDir } from "../support/test-helpers.ts";

test("normalizes Antigravity read roots without allowing duplicates", () =>
  withTempDir((directory) => {
    const home = join(directory, "home");
    const workspace = join(directory, "workspace");
    assert.deepEqual(
      normalizedReadRoots([workspace, workspace, "~/project"], home),
      [workspace, join(home, "project")]
    );
    const grants = expectedPermissionGrants([workspace], home);
    assert.ok(grants.includes(`read_file(${join(home, ".agents")})`));
    assert.ok(grants.includes(`read_file(${join(home, ".codex")})`));
    assert.deepEqual(grants.slice(-2), [
      `read_file(${workspace})`,
      `read_file(${workspace}/**)`
    ]);
  }));

test("permission update projects .rulesync/permissions.jsonc, preserves user grants, prunes disabled MCPs, and is idempotent", () =>
  withTempDir((directory) => {
    const path = join(directory, "settings.json");
    const home = join(directory, "home");
    const baseline = projectedAntigravityBaseline(home);
    assert.ok(baseline.deny.includes("command(ccc)"));
    assert.ok(baseline.deny.includes("unsandboxed(ccc)"));
    assert.ok(baseline.deny.includes("mcp(playwright/*)"));
    assert.ok(baseline.deny.includes("mcp(playtest/*)"));
    assert.ok(baseline.deny.includes("read_url"));
    assert.ok(baseline.allow.includes("mcp(filesystem/*)"));
    assert.ok(baseline.allow.includes("mcp(context7/*)"));
    assert.ok(baseline.allow.includes("mcp(googleDeveloperKnowledge/*)"));
    assert.ok(baseline.allow.includes("mcp(exa/*)"));
    assert.equal(baseline.topLevelOverrides.agentMode, "accept-edits");

    writeFileSync(
      path,
      JSON.stringify({
        permissions: {
          allow: [
            "user-grant",
            "mcp(playwright)",
            "mcp(playwright/*)",
            "mcp(playtest)",
            "mcp(playtest/*)",
            "mcp(codegraphcontext/*)",
            "mcp(codegraphcontext/delete_repository)"
          ]
        },
        other: true
      })
    );
    const missingBefore = missingAntigravityPermissions(
      path,
      [directory],
      home
    );
    for (const denial of baseline.deny) {
      assert.ok(
        missingBefore.includes(denial),
        `expected missing denial ${denial}`
      );
    }
    assert.ok(missingBefore.includes('agentMode="accept-edits"'));

    updateAntigravityPermissions(path, [directory], home);
    const first = readFileSync(path, "utf8");
    updateAntigravityPermissions(path, [directory, directory], home);
    const second = readFileSync(path, "utf8");
    assert.equal(second, first);

    const config = JSON.parse(second) as {
      agentMode: string;
      permissions: { allow: string[]; deny: string[] };
      other: boolean;
    };
    assert.equal(config.other, true);
    assert.equal(config.agentMode, "accept-edits");
    assert.ok(config.permissions.allow.includes("user-grant"));
    assert.ok(config.permissions.deny.includes("read_url"));
    assert.equal(config.permissions.allow.includes("read_url"), false);
    assert.ok(config.permissions.allow.includes("unsandboxed(pwd)"));
    assert.ok(config.permissions.allow.includes("unsandboxed(pnpm test)"));
    assert.deepEqual(
      config.permissions.allow.filter((entry) =>
        entry.startsWith("mcp(playwright")
      ),
      []
    );
    assert.deepEqual(
      config.permissions.allow.filter((entry) =>
        entry.startsWith("mcp(playtest")
      ),
      []
    );
    assert.deepEqual(
      config.permissions.allow
        .filter((entry) => entry.startsWith("mcp(codegraphcontext/"))
        .sort((a, b) => a.localeCompare(b)),
      baseline.allow
        .filter((entry) => entry.startsWith("mcp(codegraphcontext/"))
        .sort((a, b) => a.localeCompare(b))
    );
    assert.equal(
      config.permissions.allow.filter(
        (entry) => entry === `read_file(${directory})`
      ).length,
      1
    );
    for (const denial of baseline.deny) {
      assert.ok(
        config.permissions.deny.includes(denial),
        `expected denial ${denial}`
      );
    }
    assert.deepEqual(
      missingAntigravityPermissions(path, [directory], home),
      []
    );
  }));

test("skill update replaces managed and obsolete entries while preserving unrelated entries", () =>
  withTempDir((directory) => {
    const path = join(directory, "skills.json");
    const expected = join(directory, "canonical");
    const obsolete = join(directory, "obsolete");
    const unrelated = {
      path: join(directory, "unrelated"),
      include_only: ["mine"]
    };
    writeFileSync(
      path,
      JSON.stringify({
        entries: [
          { path: obsolete, include_only: ["ccc"] },
          { path: expected, include_only: ["old"] },
          unrelated
        ]
      })
    );
    updateAntigravitySkills(path, expected, [obsolete]);
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      entries: { path: string; include_only: string[] }[];
    };
    assert.deepEqual(config.entries, [
      unrelated,
      {
        path: expected,
        include_only: ["ccc", "lsp-mcp-server", "orchestration"]
      }
    ]);
    assert.deepEqual(antigravitySkillsStatus(path, expected, [obsolete]), {
      missing: false,
      stale: []
    });
  }));

test("skill status reports stale and missing registrations", () =>
  withTempDir((directory) => {
    const path = join(directory, "skills.json");
    const expected = join(directory, "canonical");
    const obsolete = join(directory, "obsolete");
    writeFileSync(
      path,
      JSON.stringify({ entries: [{ path: obsolete, include_only: ["ccc"] }] })
    );
    assert.deepEqual(antigravitySkillsStatus(path, expected, [obsolete]), {
      missing: true,
      stale: [obsolete]
    });
  }));
