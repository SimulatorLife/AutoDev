import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    const index = target.indexOf(`├── ${item}`) >= 0
      ? target.indexOf(`├── ${item}`)
      : target.indexOf(`└── ${item}`);
    assert.ok(index > previousIndex, `${item} must appear in canonical nav order`);
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

  assert.match(target, /single-user, AutoDev-centric control and observability console/);
  assert.match(target, /Use \*\*Workspaces\*\*, not OpenLIT Projects/);
  assert.match(target, /All AutoDev-owned Console application code[\s\S]*TypeScript\/TSX/);
  assert.match(target, /Do not iframe or visually stitch together/);
  assert.match(target, /OpenLIT Go Controller is not shipped/);
  assert.match(target, /RuleSync tool \*\*as the single source of truth/);
});
