import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const targetStatePath = new URL(
  "docs/autodev-console-target-state.md",
  repositoryRoot
);

test("AutoDev Console target stays reduced, unified, and TypeScript-first", () => {
  const target = readFileSync(targetStatePath, "utf8");

  const nav = [
    "Agents",
    "MCPs",
    "Skills",
    "Hooks",
    "Memory",
    "Evaluations",
    "Permissions",
    "Tools",
    "Usage",
    "Prompts",
    "Workspaces",
  ];

  let previousIndex = -1;
  for (const item of nav) {
    const branchIndex = target.indexOf(`├── ${item}`);
    const index =
      branchIndex >= 0 ? branchIndex : target.indexOf(`└── ${item}`);
    assert.ok(
      index > previousIndex,
      `${item} must appear in canonical nav order`
    );
    previousIndex = index;
  }

  for (const removed of [
    "**Accounts/users**",
    "**Organizations/organisations**",
    "**Environments**",
    "**Projects**",
    "**Rule Engine**",
    "**OpenGround**",
    "**GPU monitoring/dashboard**",
    "**OpenLIT agent discovery/instrumentation and Controller daemon**",
  ]) {
    assert.match(target, new RegExp(removed.replaceAll(/[*/]/g, "\\$&")));
  }

  assert.match(
    target,
    /single-user, AutoDev-centric control and observability console/
  );
  assert.match(target, /Use \*\*Workspaces\*\*, not OpenLIT Projects/);
  assert.match(
    target,
    /All AutoDev-owned Console application code[\s\S]*TypeScript\/TSX/
  );
  assert.match(target, /Do not iframe or visually stitch together/);
  assert.match(target, /OpenLIT Go Controller is not shipped/);
  assert.match(target, /RuleSync tool \*\*as the single source of truth/);
});


test("documentation keeps one broad target-state authority", () => {
  const removed = [
    "docs/AUTODEV_PLATFORM_MIGRATION.md",
    "docs/ui-control-plane.md",
    "docs/typescript-target-state.md",
    "docs/prompt-catalog-migration.md",
    "docs/observability-target-state.md",
    "docs/metrics-dashboard.md",
  ];

  for (const path of removed) {
    assert.equal(
      existsSync(new URL(path, repositoryRoot)),
      false,
      `${path} must stay removed after consolidation`
    );
  }

  const docsIndex = readFileSync(new URL("docs/README.md", repositoryRoot), "utf8");
  assert.match(docsIndex, /one broad target-state authority/i);
  assert.match(docsIndex, /autodev-console-target-state\.md/);

  for (const path of [
    "README.md",
    "docs/local-setup.md",
    "docs/provider-routing.md",
    "docs/antigravity-codex-tool-loop.md",
    "docs/prompt-ownership.md",
  ]) {
    const content = readFileSync(new URL(path, repositoryRoot), "utf8");
    assert.doesNotMatch(content, /docs\/AUTODEV_PLATFORM_MIGRATION\.md/);
    assert.doesNotMatch(content, /docs\/metrics-dashboard\.md/);
    assert.doesNotMatch(content, /docs\/merge-conflict-handling\.md/);
    assert.doesNotMatch(content, /127\.0\.0\.1:4100\/dashboard/);
    assert.doesNotMatch(content, /\/Users\/henrykirk/);
  }
});
