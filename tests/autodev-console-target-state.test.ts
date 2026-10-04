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
    "Workspaces"
  ];

  let previousIndex = -1;
  for (const item of nav) {
    const branchIndex = target.indexOf(`├── ${item}`);
    const index =
      branchIndex === -1 ? target.indexOf(`└── ${item}`) : branchIndex;
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
    "**OpenLIT agent discovery/instrumentation and Controller daemon**"
  ]) {
    assert.match(
      target,
      new RegExp(removed.replaceAll(/[*/]/g, String.raw`\$&`))
    );
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
    "docs/metrics-dashboard.md"
  ];

  for (const path of removed) {
    assert.equal(
      existsSync(new URL(path, repositoryRoot)),
      false,
      `${path} must stay removed after consolidation`
    );
  }

  const docsIndex = readFileSync(
    new URL("docs/README.md", repositoryRoot),
    "utf8"
  );
  assert.match(docsIndex, /one broad target-state authority/i);
  assert.match(docsIndex, /autodev-console-target-state\.md/);

  for (const path of [
    "README.md",
    "docs/local-setup.md",
    "docs/provider-routing.md",
    "docs/antigravity-codex-tool-loop.md",
    "docs/prompt-ownership.md"
  ]) {
    const content = readFileSync(new URL(path, repositoryRoot), "utf8");
    assert.doesNotMatch(content, /docs\/AUTODEV_PLATFORM_MIGRATION\.md/);
    assert.doesNotMatch(content, /docs\/metrics-dashboard\.md/);
    assert.doesNotMatch(content, /docs\/merge-conflict-handling\.md/);
    assert.doesNotMatch(content, /127\.0\.0\.1:4100\/dashboard/);
    assert.doesNotMatch(content, /\/Users\/henrykirk/);
  }
});

test("canonical target defines the flat four-module monorepo", () => {
  const target = readFileSync(targetStatePath, "utf8");

  for (const module of ["console/", "runtime/", "core/", "data/"]) {
    assert.match(
      target,
      new RegExp(String.raw`\b${module.replace("/", String.raw`\/`)}`)
    );
  }

  assert.match(target, /small, flat pnpm TypeScript monorepo/);
  assert.match(
    target,
    /Do not introduce `apps\/`, `packages\/`, or `modules\/` wrapper directories/
  );
  assert.match(target, /do not create a package per left-navigation resource/i);
  assert.match(target, /console\/src\/features\//);
  assert.match(target, /runtime\/src\/telemetry\//);
  assert.match(target, /core\/.*infrastructure-independent/s);
  assert.match(target, /Console must not bypass the Control API/);
  assert.match(
    target,
    /Do not create a separate `ui\/` workspace until there is a real second UI consumer/
  );
});

test("monorepo layout, console features, and control API match target state exactly", () => {
  const workspaceYaml = readFileSync(
    new URL("pnpm-workspace.yaml", repositoryRoot),
    "utf8"
  );
  assert.ok(workspaceYaml.includes("- console"));
  assert.ok(workspaceYaml.includes("- runtime"));
  assert.ok(workspaceYaml.includes("- core"));
  assert.ok(workspaceYaml.includes("- data"));

  for (const mod of ["console", "runtime", "core", "data"]) {
    assert.ok(existsSync(new URL(`${mod}/package.json`, repositoryRoot)));
    assert.ok(existsSync(new URL(`${mod}/tsconfig.json`, repositoryRoot)));
    assert.ok(existsSync(new URL(`${mod}/src/index.ts`, repositoryRoot)));
  }

  const expectedNav = [
    "agents",
    "mcps",
    "skills",
    "hooks",
    "memory",
    "evaluations",
    "permissions",
    "tools",
    "usage",
    "prompts",
    "workspaces"
  ];

  for (const feat of expectedNav) {
    assert.ok(
      existsSync(new URL(`console/src/features/${feat}`, repositoryRoot)),
      `console/src/features/${feat} must exist`
    );
  }

  assert.equal(
    existsSync(new URL("console/app/mcps/[name]/page.tsx", repositoryRoot)),
    true,
    "MCP details must have a URL-addressable Console route"
  );
  assert.equal(
    existsSync(
      new URL("console/src/features/mcps/McpDetailView.ts", repositoryRoot)
    ),
    true,
    "MCP detail rendering belongs to the Console feature"
  );

  // Ensure removed concepts are not present as features
  for (const removed of [
    "accounts",
    "users",
    "organizations",
    "environments",
    "projects",
    "rules",
    "openground",
    "gpu"
  ]) {
    assert.equal(
      existsSync(new URL(`console/src/features/${removed}`, repositoryRoot)),
      false,
      `Removed concept ${removed} must not exist in console/src/features`
    );
  }
});

test("root quality scripts validate all code workspaces", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("package.json", repositoryRoot), "utf8")
  ) as { scripts: Record<string, string> };

  assert.match(manifest.scripts.test ?? "", /test:root.*--recursive.*test/u);
  assert.match(
    manifest.scripts.typecheck ?? "",
    /typecheck:root.*--recursive.*typecheck/u
  );
  for (const workspace of ["core", "data", "console", "runtime"])
    assert.match(manifest.scripts.format ?? "", new RegExp(`${workspace}`));
});

test("canonical target records the current repository quality-gate evidence", () => {
  const target = readFileSync(targetStatePath, "utf8");

  assert.match(
    target,
    /`pnpm run typecheck` passes for the root TypeScript project and all four workspaces/
  );
  assert.match(target, /`pnpm run lint:ci` reports \d+ errors/);
  assert.match(target, /`pnpm run format:check` passes repository-wide/);
  assert.match(
    target,
    /Local p25 acceptance through the unified Console’s server-rendered/
  );
  assert.match(target, /p25 in the standard lock and running local stack/);
  assert.match(target, /live p25 reads return five workspace entries/);
  assert.match(
    target,
    /Data `ConfigRepository` validates the current `\.github\/workflows\/weights\.json` projection as valid\/invalid\/unavailable/
  );
  assert.match(
    target,
    /The p25 image is now promoted to the standard local image lock and running stack/
  );
  assert.doesNotMatch(
    target,
    /root TypeScript project still reports \d+ diagnostics/
  );
});

test("canonical target tracks migration gaps without claiming premature cutover", () => {
  const target = readFileSync(targetStatePath, "utf8");

  assert.match(target, /## 12\. Current migration state and gap ledger/);
  assert.match(target, /Flat monorepo\s+\|\s+\*\*Partial\*\*/);
  assert.match(
    target,
    /Workspaces\s+\|\s+\*\*Partial: Data-owned read; runtime health unknown\*\*/
  );
  assert.match(target, /Workspaces delegates to Data `ConfigRepository`/);
  assert.match(
    target,
    /enabled state, agent\/resource scope, per-workspace configuration health/
  );
  assert.match(target, /model-router LaunchAgent supplies `AUTODEV_REPO_ROOT`/);
  assert.match(target, /Console\s+\|\s+\*\*Runnable foundation\*\*/);
  assert.match(target, /RuleSync ownership\s+\|\s+\*\*Partial\*\*/);
  assert.match(
    target,
    /Telemetry cutover\s+\|\s+\*\*Standalone Collector removed; router cleanup incomplete\*\*/
  );
  assert.match(target, /unknown must remain unknown/i);
  assert.match(target, /Physical migration complete; finish workspace hygiene/);
  assert.match(target, /The root `src\/` implementation tree is absent/);
  assert.match(target, /Finish RuleSync canonical ownership/);
  assert.match(target, /Remaining OpenLIT subtraction/);
  assert.match(target, /Remaining telemetry cleanup/);
  assert.match(target, /Remaining retained-feature integrations/);
  assert.match(target, /Ordered migration sequence/);
  assert.doesNotMatch(
    target,
    /original M0-M6 observability migration is complete/i
  );
});

test("canonical target records the remaining external-project adaptations", () => {
  const target = readFileSync(targetStatePath, "utf8");

  for (const project of [
    "OpenLIT",
    "LiteLLM",
    "LangWatch",
    "MCPJam Inspector",
    "Unleash",
    "Argo CD",
    "Backstage"
  ]) {
    assert.match(
      target,
      new RegExp(project.replaceAll(/[.*+?^$(){}|[\]\\]/g, String.raw`\$&`))
    );
  }

  assert.match(
    target,
    /provider\/model availability, priority, fallback order/
  );
  assert.match(target, /connection\/probe state, Tools, Resources, Prompts/);
  assert.match(target, /desired vs actual, generations, diff, health/);
  assert.match(target, /lightweight typed feature\/route registry/);
});
