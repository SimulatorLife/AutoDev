import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { CANONICAL_NAVIGATION } from "@simulatorlife/autodev-core";

const repositoryRoot = new URL("../", import.meta.url);
const targetStatePath = new URL(
  "docs/autodev-console-target-state.md",
  repositoryRoot
);
const migrationPath = new URL(
  "docs/autodev-console-migration.md",
  repositoryRoot
);

// Structural helper: every canonical nav resource must be presented in the
// target doc's resource surface. Resources may appear in tree (├── / └──)
// form or as a bolded table heading; both count as canonical presentation.
function canonicalNavSurface(doc: string): {
  presented: string[];
  treeEntries: string[];
  groups: { Configure: string[]; Observe: string[]; Operate: string[] };
} {
  // The canonical resource surface lives in its own code fence and groups
  // items under Configure / Observe / Operate. Other ASCII trees (module
  // map, observability plane, control plane, etc.) are not nav surfaces.
  const treeEntries: string[] = [];
  const groups: { Configure: string[]; Observe: string[]; Operate: string[] } =
    {
      Configure: [],
      Observe: [],
      Operate: []
    };
  const fencePattern = /~~~(?:text)?\n([\s\S]*?)\n~~~/gu;
  for (const fence of doc.matchAll(fencePattern)) {
    const block = fence[1] ?? "";
    if (!/\bConfigure\b/.test(block)) continue;
    if (!/\bObserve\b/.test(block)) continue;
    if (!/\bOperate\b/.test(block)) continue;
    let currentGroup: keyof typeof groups | null = null;
    const groupHeaderRegex = /^[ \t]*(Configure|Observe|Operate)[ \t]*$/;
    const treeEntryRegex = /^[ \t]*[├└]──\s+(\S+?)\s*$/;
    for (const line of block.split("\n")) {
      const headerMatch = groupHeaderRegex.exec(line);
      if (headerMatch && headerMatch[1]) {
        currentGroup = headerMatch[1] as keyof typeof groups;
        continue;
      }
      const m = treeEntryRegex.exec(line);
      if (m && m[1] && currentGroup) {
        treeEntries.push(m[1]);
        groups[currentGroup].push(m[1]);
      }
    }
    break;
  }
  const presented: string[] = [];
  for (const item of CANONICAL_NAVIGATION) {
    const escaped = item.replaceAll(/[.*+?^$(){}|[\]\\]/g, String.raw`\$&`);
    const treeHit = new RegExp(
      `^[ \t]*[├└]──\\s+\\**${escaped}\\**\\s*$`,
      "mu"
    ).test(doc);
    const boldHit = new RegExp(String.raw`\*\*${escaped}\*\*`).test(doc);
    if (treeHit || boldHit) presented.push(item);
  }
  return { presented, treeEntries, groups };
}

// Structural helper: confirms a removed OpenLIT surface is documented as an
// explicit, bolded out-of-scope label (the target doc's "**Label:**"
// convention), not merely named anywhere in passing prose.
function hasBoldOutOfScopeLabel(doc: string, phrase: string): boolean {
  const escaped = phrase.replaceAll(/[.*+?^$(){}|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`\*\*[^*\n]*${escaped}[^*\n]*\*\*`, "u").test(
    doc
  );
}

test("AutoDev Console target stays reduced, unified, and TypeScript-first", () => {
  const target = readFileSync(targetStatePath, "utf8");
  const { presented, treeEntries, groups } = canonicalNavSurface(target);

  // Every canonical nav resource from core/src/navigation.ts must be presented.
  assert.deepEqual(
    presented.slice().sort(),
    [...CANONICAL_NAVIGATION].slice().sort(),
    "every CANONICAL_NAVIGATION entry must be presented in the target doc"
  );

  // The resource-surface tree must contain exactly the 12 canonical entries;
  // no extra nav items, no removed product surfaces sneaking in.
  const treeSet = new Set(treeEntries);
  for (const item of CANONICAL_NAVIGATION) {
    assert.ok(
      treeSet.has(item),
      `Canonical nav "${item}" must appear in the resource-surface tree`
    );
  }
  assert.equal(
    treeSet.size,
    CANONICAL_NAVIGATION.length,
    "resource-surface tree must list exactly the 12 canonical nav resources"
  );

  // Configure / Observe / Operate must each contain exactly its canonical
  // members from the target doc's tree (mirroring the document; no invented
  // group assignments).
  assert.deepEqual(
    groups.Configure.slice().sort(),
    ["Agents", "Hooks", "MCPs", "Permissions", "Prompts", "Skills", "Tools"],
    "Configure must list exactly its seven canonical nav resources"
  );
  assert.deepEqual(
    groups.Observe.slice().sort(),
    ["Evaluations", "Memory", "Usage"],
    "Observe must list exactly its three canonical nav resources"
  );
  assert.deepEqual(
    groups.Operate.slice().sort(),
    ["GitHub", "Workspaces"],
    "Operate must list exactly its two canonical nav resources"
  );
  assert.equal(
    groups.Configure.length + groups.Observe.length + groups.Operate.length,
    CANONICAL_NAVIGATION.length,
    "every canonical nav resource must appear under Configure/Observe/Operate"
  );

  // Removed OpenLIT product surfaces must be explicitly listed as out of scope
  // (semantic concept: each removed surface is named as something not shipped).
  for (const removed of [
    "Accounts/users",
    "Organizations/organisations",
    "Environments",
    "Projects",
    "Rule Engine",
    "OpenGround",
    "GPU dashboard/monitoring",
    "OpenLIT agent discovery/instrumentation and Controller daemon",
    "Otter/chat"
  ]) {
    assert.ok(
      hasBoldOutOfScopeLabel(target, removed),
      `Removed OpenLIT surface "${removed}" must be documented with a bolded out-of-scope label`
    );
  }

  // Single-user AutoDev control and observability console (durable product shape).
  assert.match(
    target,
    /single-user[^.\n]*AutoDev control and observability console/u
  );
  assert.match(target, /Use \*\*Workspaces\*\*,\s*not OpenLIT Projects/u);

  // All AutoDev-owned Console code is TypeScript/TSX (no second-language app).
  assert.match(
    target,
    /All AutoDev-owned Console application(?:\/)?control code is TypeScript\/TSX/u
  );

  // No iframe/embed/stitch together of foreign dashboards.
  assert.match(target, /Do not iframe, embed, or visually stitch together/u);

  // OpenLIT Controller / Go Controller daemon is not shipped.
  assert.match(
    target,
    /OpenLIT\s+(?:Go )?Controller(?: daemon)? is not shipped/u
  );

  // RuleSync is the source of truth for losslessly-representable surfaces.
  assert.match(target, /RuleSync tool as the source of truth/u);

  // Provider / model / routing / runtime config is required domain data but
  // remains a secondary surface under Agents (not a top-level nav item).
  assert.match(target, /secondary surfaces? under \*\*Agents\*\*/u);
  assert.ok(
    !treeSet.has("Providers") &&
      !treeSet.has("Models") &&
      !treeSet.has("Routing"),
    "Providers/Models/Routing must not appear as top-level nav resources"
  );
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

  // Flat pnpm TypeScript monorepo (no apps/packages/modules wrappers).
  assert.match(target, /small, flat pnpm TypeScript monorepo/u);
  assert.match(
    target,
    /Do not introduce\s+apps\/,\s+packages\/,\s+or\s+modules\/\s+wrappers/u
  );

  // Each nav resource is a feature folder, not a package per resource.
  assert.match(
    target,
    /do not create a package per (?:left-)?navigation resource/u
  );
  assert.match(target, /keep navigation resources as feature folders/u);
  assert.match(
    target,
    /Do not create (?:agents\/, skills\/, mcps\/, prompts\/, etc\. )?as separate packages/u
  );

  // Producer telemetry path lives under runtime/src/telemetry/.
  assert.match(target, /runtime\/src\/telemetry\//);

  // core/ stays infrastructure-independent (no AutoDev module deps inward).
  assert.match(target, /core\/\s*remains infrastructure-independent/u);

  // Console must mutate canonical/runtime state only through the Control API.
  assert.match(target, /console\/\s*never bypasses the Control API/u);

  // No separate ui/ workspace until a real second UI consumer exists.
  assert.match(target, /until a real second UI consumer exists/u);
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

  // All 12 canonical nav resources have a Console feature folder.
  const featureFolders = CANONICAL_NAVIGATION.map((item) => item.toLowerCase());
  for (const feat of featureFolders) {
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

  // Ensure removed concepts are not present as features.
  for (const removed of [
    "accounts",
    "users",
    "organizations",
    "environments",
    "projects",
    "rules",
    "openground",
    "gpu",
    "otter"
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

test("canonical migration tracker records the current repository quality-gate evidence", () => {
  // Per the docs contract, current implementation state and acceptance evidence
  // live in autodev-console-migration.md. The target doc owns the policy; the
  // migration tracker owns the recorded evidence.
  const target = readFileSync(targetStatePath, "utf8");
  const migration = readFileSync(migrationPath, "utf8");
  assert.ok(
    migration.length > 0,
    "migration tracker must exist and be populated"
  );

  // Quality-gate policy is durable and therefore lives in the target doc.
  assert.match(
    target,
    /all four code workspaces share root formatting\/lint\/test\/TypeScript policy/u
  );

  // Each concrete quality-gate category records its exact current evidence
  // in the migration tracker: the specific pnpm script result, not merely a
  // generic nearby mention of the category name.
  // typecheck
  assert.match(
    migration,
    /pnpm run typecheck passes the root project and all four workspaces/u,
    "typecheck evidence must record the exact pnpm run typecheck result"
  );
  // lint
  assert.match(
    migration,
    /pnpm run lint:ci reports \d+ errors/u,
    "lint evidence must record the exact pnpm run lint:ci error count"
  );
  // format
  assert.match(
    migration,
    /pnpm run format:check passes repository-wide/u,
    "format-check evidence must record the exact pnpm run format:check result"
  );

  // p25 acceptance must record concrete OpenLIT patch-level evidence, not a
  // bare "p25" mention: the patch-application suite result, the patched
  // client typecheck result, and the local live-acceptance probe list.
  assert.match(
    migration,
    /p25 patch-application suite passes \d+\/\d+/u,
    "p25 patch-application suite evidence must be recorded"
  );
  assert.match(
    migration,
    /patched p25 client typecheck passes/u,
    "patched p25 client typecheck evidence must be recorded"
  );
  assert.match(
    migration,
    /local p25 health[\s\S]{0,200}service-token redaction/u,
    "p25 live acceptance probe evidence (health/OTLP/usage/redaction) must be recorded"
  );

  // Data's ConfigRepository must be documented as owning workspaces.json as
  // the canonical workspace registry (ownership, not a bare co-occurrence).
  assert.match(
    migration,
    /config\/workspaces\.json[\s\S]{0,120}canonical workspace registry[\s\S]{0,120}ConfigRepository/u,
    "workspaces.json must be documented as the canonical registry owned by ConfigRepository"
  );

  // The target doc must not regress into claiming root TypeScript still fails.
  assert.doesNotMatch(
    target,
    /root TypeScript project still reports \d+ diagnostics/u
  );
});

test("canonical target and migration tracker track gaps without claiming premature cutover", () => {
  const target = readFileSync(targetStatePath, "utf8");
  const migration = readFileSync(migrationPath, "utf8");

  // Gap ledger section lives in the migration tracker, which is the
  // authoritative place for observed current state and gaps.
  assert.match(migration, /^##\s+Gap ledger\b/gmu);

  // Each tracked gap area must appear as a row in the migration gap ledger
  // (semantic: row label + a Partial/Unknown/Runnable state marker).
  const gapAreas = [
    "Flat monorepo",
    "Workspaces",
    "Console",
    "RuleSync ownership",
    "Telemetry cutover"
  ];
  for (const area of gapAreas) {
    const rowRegex = new RegExp(
      String.raw`\|\s*${area.replaceAll(/[.*+?^$(){}|[\]\\]/g, String.raw`\$&`)}\s*\|\s*\*\*[A-Za-z][^*]*\*\*`
    );
    assert.ok(
      rowRegex.test(migration),
      `gap ledger row for "${area}" must exist with a state marker`
    );
  }

  // Workspaces delegates to Data ConfigRepository (semantic: Data owns the
  // canonical workspace registry).
  assert.match(migration, /workspaces\.json[\s\S]{0,400}ConfigRepository/u);

  // Per-workspace configuration-health and runtime-availability signals are
  // named as remaining target gaps (not silently claimed done).
  assert.match(
    migration,
    /per-workspace configuration-health[\s\S]{0,200}runtime-availability/u
  );

  // State correctness: missing evidence must remain explicit; never synthesize
  // success. This is durable target-state language, so it lives in the target doc.
  assert.match(target, /Missing evidence must remain explicit/u);
  assert.match(target, /Never synthesize ready, converged, healthy/u);

  // Root src/ tree is absent (semantic: obsolete root implementation is gone).
  const rootSrcGone =
    /root src\/\s*is gone/u.test(migration) ||
    /obsolete root implementation tree is gone/u.test(migration) ||
    /no legacy root implementation\/facade returns/u.test(target);
  assert.ok(
    rootSrcGone,
    "obsolete root src/ implementation tree must be recorded as gone"
  );

  // Standalone Collector removal recorded (semantic: telemetry cutover
  // explicitly notes Collector removal status).
  assert.match(migration, /Standalone AutoDev Collector (?:is )?removed/u);

  // Ordered remaining work / migration sequence is recorded structurally.
  assert.match(migration, /^##\s+Remaining work by dependency/mu);
  assert.match(migration, /This is the migration order/u);

  // Remaining retained-feature integrations is still tracked.
  assert.match(migration, /retained-feature integrations/u);

  // No premature completion claim: the canonical target must not assert that
  // the M0-M6 (or any numbered) observability migration is fully complete.
  assert.doesNotMatch(
    target,
    /original M0-M6 observability migration is complete/u
  );
  assert.doesNotMatch(
    migration,
    /original M0-M6 observability migration is complete/u
  );
});

test("canonical target records the remaining external-project adaptations", () => {
  const target = readFileSync(targetStatePath, "utf8");

  // All seven reference projects must be mentioned in the component-reuse
  // / reference-projects section (semantic: each appears as a labelled row
  // or bolded name with adaptation context).
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

  // LiteLLM supplies provider/model/routing semantics with priority + fallback
  // (semantic: row mentions these concepts together, even if reordered).
  assert.match(
    target,
    /provider\/model\/routing semantics:[^.\n]*priority[^.\n]*fallback/u
  );

  // MCPJam supplies MCP Tools/Resources/Prompts inspection with diagnostics.
  assert.match(target, /MCP Tools\/Resources\/Prompts[^.\n]*inspection/u);

  // Argo CD supplies desired/live diff + health semantics.
  assert.match(target, /desired\/live diff[^.\n]*health/u);

  // Backstage supplies a lightweight typed feature/route registry idea.
  assert.match(target, /lightweight (?:typed )?feature(?:\/route)? registry/u);
});
