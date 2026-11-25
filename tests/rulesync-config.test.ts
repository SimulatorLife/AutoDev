/**
The canonical RuleSync target state.

`rulesync.jsonc` decides which provider projection owns which feature, and
the repository tracks the projections that rule produces. This suite owns
that contract, so the feature suites can derive their expectations from the
configuration instead of keeping a copy of it.
*/

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  configuredFeatures,
  driftedTrackedProjections,
  readRulesyncConfig,
  skillTreesWrittenBy,
  targetsOwningFeature
} from "./support/rulesync-config.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const RULE_SYNC_FEATURES = new Set([
  "rules",
  "ignore",
  "mcp",
  "subagents",
  "commands",
  "skills",
  "hooks",
  "permissions",
  "checks"
]);

test("the canonical target state declares every target's features", () => {
  const config = readRulesyncConfig(repositoryRoot);
  assert.ok(Object.keys(config.targets).length > 0);
  for (const [target, features] of Object.entries(config.targets)) {
    assert.ok(features.length > 0, `${target} declares no feature`);
    for (const feature of features) {
      assert.ok(
        RULE_SYNC_FEATURES.has(feature),
        `${target} declares an unknown feature: ${feature}`
      );
    }
  }
  // The permissions and subagents projections stay with the Runtime's own
  // materializers, which write the provider-specific shapes RuleSync has no
  // target for.
  const features = configuredFeatures(config);
  assert.equal(features.has("permissions"), false);
  assert.equal(features.has("subagents"), false);
  // The configuration declares per-target ownership rather than a flat
  // selection, so no global feature list may narrow it.
  assert.deepEqual(config.features, []);
  assert.equal(config.global, false);
  assert.equal(config.delete, true);
});

test("the canonical target state names an output root for every configured target", () => {
  const config = readRulesyncConfig(repositoryRoot);
  for (const target of Object.keys(config.outputRoots)) {
    assert.ok(
      Object.hasOwn(config.targets, target),
      `${target} has an output root but declares no feature`
    );
  }
  for (const target of Object.keys(config.targets)) {
    const roots = config.outputRoots[target];
    if (roots === undefined) continue;
    assert.ok(roots.length > 0, `${target} declares an empty output root`);
  }
});

test("each skill tree has exactly one configured owner", () => {
  const config = readRulesyncConfig(repositoryRoot);
  const owners = targetsOwningFeature(config, "skills");
  assert.ok(owners.length > 0);

  const ownersByTree = new Map<string, string[]>();
  for (const owner of owners) {
    for (const tree of skillTreesWrittenBy(repositoryRoot, owner)) {
      const treeOwners = ownersByTree.get(tree) ?? [];
      treeOwners.push(owner);
      ownersByTree.set(tree, treeOwners);
    }
  }
  // A shared output tree needs a single owner: two targets writing it would
  // have to produce byte-identical files, and a skill whose frontmatter one
  // client reads and the other ignores makes that impossible.
  const contested = [...ownersByTree].filter(
    ([, treeOwners]) => treeOwners.length > 1
  );
  assert.deepEqual(
    contested,
    [],
    "a skill tree is written by more than one target"
  );
});

test("the tracked projections are the current RuleSync output", () => {
  // RuleSync's own `--check` mode is the drift gate. The generated trees are
  // not tracked, so only a tracked projection that drifted matters.
  assert.deepEqual(driftedTrackedProjections(repositoryRoot), []);
});

test("the drift workflow runs every RuleSync suite", () => {
  const workflow = readFileSync(
    join(
      repositoryRoot,
      ".github",
      "workflows",
      "rulesync-mcp-shadow-drift.yml"
    ),
    "utf8"
  );
  assert.match(workflow, /- "rulesync\.lock"/);
  assert.match(workflow, /- "rulesync-npm\.lock\.json"/);
  assert.match(workflow, /pnpm exec rulesync install --frozen --silent/);
  const suites = readdirSync(join(repositoryRoot, "tests")).filter(
    (entry) => entry.startsWith("rulesync-") && entry.endsWith(".test.ts")
  );
  assert.ok(suites.length > 0);
  for (const suite of suites) {
    assert.ok(
      workflow.includes(`tests/${suite}`),
      `the drift workflow does not run ${suite}`
    );
  }
});
