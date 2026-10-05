import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

  // The resource-surface tree contains every implemented nav resource once.
  // A target resource the Console does not ship yet is allowed only while the
  // migration tracker records its route/navigation gap; no removed product
  // surface can sneak in unrecorded.
  const treeSet = new Set(treeEntries);
  for (const item of CANONICAL_NAVIGATION) {
    assert.ok(
      treeSet.has(item),
      `Canonical nav "${item}" must appear in the resource-surface tree`
    );
  }
  assert.equal(
    treeSet.size,
    treeEntries.length,
    "resource-surface tree must not repeat a resource"
  );
  const migration = readFileSync(migrationPath, "utf8");
  const implemented = new Set<string>(CANONICAL_NAVIGATION);
  for (const item of treeEntries.filter((entry) => !implemented.has(entry))) {
    assert.ok(
      migration.includes(
        `The top-level ${item} route and navigation item are not implemented yet`
      ),
      `Target-only resource "${item}" must be recorded as a migration gap`
    );
  }

  // Configure / Observe / Operate must each contain exactly its canonical
  // members from the target doc's tree (mirroring the document; no invented
  // group assignments).
  assert.deepEqual(
    groups.Configure.slice().sort(),
    [
      "Agents",
      "Hooks",
      "MCPs",
      "Permissions",
      "Prompts",
      "Providers",
      "Skills",
      "Tools"
    ],
    "Configure must list exactly its eight canonical nav resources"
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
    treeEntries.length,
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

  // Skill definitions and eligibility have distinct canonical owners; runtime
  // exposure/use remain telemetry facts and missing sources stay explicit.
  assert.match(
    target,
    /Canonical skill definitions and descriptive metadata come from `\.rulesync\/skills`; role eligibility is joined from the execution contract/u
  );
  assert.match(
    target,
    /A missing or invalid RuleSync catalog is not a successful empty catalog/u
  );

  // Providers is the top-level Configure resource and the one editable
  // surface for provider enablement/routing; models and routing stay inside
  // it rather than becoming further top-level nav items.
  assert.match(
    target,
    /\*\*Providers\*\* is a top-level Configure resource in the Console navigation/u
  );
  assert.match(
    target,
    /\| Provider orchestrator\/subagent enablement, model enablement, priority\/fallback groups, per-tier models, routing \| Providers \(Providers and Models tabs\) \|/u
  );

  // Item-scoped controls live with their item: on its list row and in its
  // detail view inside the owning resource, never on a detached page.
  assert.match(target, /^### Contextual controls$/mu);
  assert.match(
    target,
    /appear on that item's row or card in its resource list view \*\*and\*\* in that item's detail view/u
  );
  assert.match(
    target,
    /Pages outside the owning resource show the item's state read-only and link to it/u
  );
  assert.ok(
    !treeSet.has("Models") && !treeSet.has("Routing"),
    "Models/Routing must not appear as top-level nav resources"
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

  // Every canonical nav resource has a Console feature folder.
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

  // Providers keeps provider and model detail inside its own resource.
  for (const route of [
    "console/app/providers/page.tsx",
    "console/app/providers/[id]/page.tsx",
    "console/app/providers/[id]/models/[model]/page.tsx"
  ]) {
    assert.ok(
      existsSync(new URL(route, repositoryRoot)),
      `${route} must be a URL-addressable Providers route`
    );
  }

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
  for (const workspace of ["core", "data", "console", "runtime"]) {
    assert.match(manifest.scripts.format ?? "", new RegExp(`${workspace}`));
    const workspaceManifest = JSON.parse(
      readFileSync(new URL(`${workspace}/package.json`, repositoryRoot), "utf8")
    ) as { scripts: Record<string, string> };
    assert.equal(
      workspaceManifest.scripts.test,
      "node --test",
      `${workspace} must use Node's recursive test discovery without shell globs`
    );
  }
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
    /pnpm run lint:ci passes repository-wide with no errors or warnings/u,
    "lint evidence must record the passing pnpm run lint:ci result"
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
  assert.match(
    migration,
    /p26 trace-detail source applies to p25[\s\S]{0,260}isolated p26 validation image builds successfully[\s\S]{0,120}active image remains p25/u,
    "p26 trace-detail source/build evidence must distinguish isolated build from active runtime acceptance"
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

// --- Console dark-only semantic design token system ------------------------
//
// docs/autodev-console-target-state.md §3 requires a single dark-only
// semantic token set (background/surfaces/input/hover/selected/borders/
// text/accent/success/warning/error/chart series) with no theme feature:
// no light theme, no theme selector/toggle, no prefers-color-scheme product
// behavior, and no persisted theme preference. These tests verify the
// canonical token source (console/app/globals.css), the absence of raw
// Tailwind palette utilities across the Console's own app/src TypeScript,
// and a WCAG AA contrast guarantee for the token palette itself so a future
// color edit cannot silently reintroduce illegible text.

const globalsCssPath = new URL("console/app/globals.css", repositoryRoot);

function collectTsFiles(dirUrl: URL): URL[] {
  const dirPath = fileURLToPath(dirUrl);
  if (!existsSync(dirPath)) return [];
  const results: URL[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const entryUrl = new URL(
      entry.name + (entry.isDirectory() ? "/" : ""),
      dirUrl
    );
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(entryUrl));
    } else if (/\.tsx?$/u.test(entry.name)) {
      results.push(entryUrl);
    }
  }
  return results;
}

function consoleSourceFiles(): URL[] {
  return [
    ...collectTsFiles(new URL("console/app/", repositoryRoot)),
    ...collectTsFiles(new URL("console/src/", repositoryRoot))
  ];
}

// Relative sRGB luminance and WCAG contrast ratio, used to guarantee every
// semantic text token stays readable (>= 4.5:1, the AA threshold for normal
// text) against every realistic Console background token.
function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.039_28 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (
    0.2126 * srgbToLinear(r) +
    0.7152 * srgbToLinear(g) +
    0.0722 * srgbToLinear(b)
  );
}

function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

function compositeHex(
  foreground: string,
  background: string,
  opacity: number
): string {
  const foregroundChannels = [1, 3, 5].map((index) =>
    Number.parseInt(foreground.slice(index, index + 2), 16)
  );
  const backgroundChannels = [1, 3, 5].map((index) =>
    Number.parseInt(background.slice(index, index + 2), 16)
  );
  const channels = foregroundChannels.map((channel, index) =>
    Math.round(
      channel * opacity + (backgroundChannels[index] ?? 0) * (1 - opacity)
    )
  );
  return (
    "#" +
    channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")
  );
}

function parseThemeColorTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of css.matchAll(
    /--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/gu
  )) {
    const name = match[1];
    const hex = match[2];
    if (name && hex) tokens[name] = hex;
  }
  return tokens;
}

test("Console globals.css defines the required dark-only semantic token set", () => {
  const css = readFileSync(globalsCssPath, "utf8");

  // Exactly one dark-only theme: no light-theme selector, toggle, persisted
  // preference, or prefers-color-scheme product behavior anywhere in the
  // canonical token source. Checks run against the CSS with comments
  // stripped so explanatory prose describing what is intentionally absent
  // (for example "no light theme") cannot itself trip the assertion.
  const cssWithoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  assert.match(cssWithoutComments, /color-scheme:\s*dark/u);
  assert.doesNotMatch(cssWithoutComments, /prefers-color-scheme/u);
  assert.doesNotMatch(
    cssWithoutComments,
    /\[data-theme|theme-toggle|ThemeProvider/u
  );

  const tokens = parseThemeColorTokens(css);

  // Required categories from the target doc: background, surfaces, input,
  // hover, selected, borders, text (primary/secondary), accent, success,
  // warning, error, and at least five chart-series tokens.
  for (const required of [
    "background",
    "surface",
    "surface-raised",
    "input",
    "hover",
    "selected",
    "border",
    "border-strong",
    "fg",
    "fg-secondary",
    "fg-muted",
    "fg-inverse",
    "accent",
    "success",
    "warning",
    "error",
    "neutral"
  ]) {
    assert.ok(tokens[required], `globals.css must define --color-${required}`);
  }

  const chartTokens = Object.keys(tokens).filter((name) =>
    name.startsWith("chart-")
  );
  assert.ok(
    chartTokens.length >= 5,
    "globals.css must define at least five chart-series tokens"
  );
});

test("Console app/src source contains no raw Tailwind palette utilities", () => {
  const rawPalettePattern =
    /(?:bg|text|border|outline|divide|ring|from|to|via|fill|stroke|placeholder|decoration|caret|accent|shadow)-(?:slate|zinc|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b/u;

  for (const file of consoleSourceFiles()) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      rawPalettePattern,
      `${fileURLToPath(file)} must use semantic design tokens, not a raw Tailwind palette utility`
    );
  }
});

test("Console source uses semantic inverse foregrounds instead of text-white", () => {
  for (const file of consoleSourceFiles()) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /\btext-white\b/u,
      "Console action labels must use semantic foreground tokens"
    );
  }
});

const CONSOLE_TEXT_BACKGROUND_TOKENS = [
  "background",
  "surface",
  "surface-raised",
  "input",
  "selected"
] as const;

function textTokenContrastFailures(tokens: Record<string, string>): string[] {
  const nonTextTokens = new Set<string>([
    ...CONSOLE_TEXT_BACKGROUND_TOKENS,
    "fg-inverse",
    "hover",
    "border",
    "border-strong"
  ]);
  const textTokens = Object.keys(tokens).filter(
    (name) => !nonTextTokens.has(name)
  );
  const failures: string[] = [];

  for (const backgroundName of CONSOLE_TEXT_BACKGROUND_TOKENS) {
    const background = tokens[backgroundName];
    if (!background) continue;
    for (const textName of textTokens) {
      const foreground = tokens[textName];
      if (!foreground) continue;
      const ratio = contrastRatio(foreground, background);
      if (ratio < 4.5) {
        failures.push(
          "text-" +
            textName +
            " on bg-" +
            backgroundName +
            ": " +
            ratio.toFixed(2) +
            ":1 (requires >= 4.5:1)"
        );
      }
    }
  }
  return failures;
}

function maximumStatusSurfaceOpacityByToken(): Map<string, number> {
  const maximumOpacity = new Map<string, number>();
  for (const file of consoleSourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\bbg-(accent|success|warning|error|neutral)\/(\d+)\b/gu
    )) {
      const status = match[1];
      const rawOpacity = match[2];
      if (!status || !rawOpacity) continue;
      const opacity = Number(rawOpacity) / 100;
      maximumOpacity.set(
        status,
        Math.max(maximumOpacity.get(status) ?? 0, opacity)
      );
    }
  }
  return maximumOpacity;
}

function translucentStatusContrastFailures(
  tokens: Record<string, string>
): string[] {
  // A status text color is composited against its tinted surface, not only
  // the untouched page background. Use the highest actual status background
  // opacity in Console source to cover badges, buttons, and callouts.
  const maximumOpacity = maximumStatusSurfaceOpacityByToken();
  const failures: string[] = [];

  for (const [status, opacity] of maximumOpacity) {
    const foreground = tokens[status];
    if (!foreground) continue;
    for (const backgroundName of CONSOLE_TEXT_BACKGROUND_TOKENS) {
      const background = tokens[backgroundName];
      if (!background) continue;
      const tintedBackground = compositeHex(foreground, background, opacity);
      const ratio = contrastRatio(foreground, tintedBackground);
      if (ratio < 4.5) {
        failures.push(
          "text-" +
            status +
            " on bg-" +
            status +
            "/" +
            Math.round(opacity * 100) +
            " over " +
            backgroundName +
            ": " +
            ratio.toFixed(2) +
            ":1 (requires >= 4.5:1)"
        );
      }
    }
  }

  return [...failures, ...unavailableCalloutContrastFailures(tokens)];
}

function unavailableCalloutContrastFailures(
  tokens: Record<string, string>
): string[] {
  // ResourceUnavailable intentionally mixes neutral body/hint text into a
  // translucent error callout on the Console canvas (rather than using the
  // error foreground for every paragraph); verify that exact documented pair.
  const error = tokens.error;
  const canvas = tokens.background;
  if (!error || !canvas) return [];

  const unavailableBackground = compositeHex(error, canvas, 0.1);
  const failures: string[] = [];
  for (const textName of ["error", "fg-secondary", "fg-muted"]) {
    const foreground = tokens[textName];
    if (!foreground) continue;
    const ratio = contrastRatio(foreground, unavailableBackground);
    if (ratio < 4.5) {
      failures.push(
        "text-" +
          textName +
          " on ResourceUnavailable bg-error/10 over background: " +
          ratio.toFixed(2) +
          ":1 (requires >= 4.5:1)"
      );
    }
  }
  return failures;
}

function solidFillButtonContrastFailures(
  tokens: Record<string, string>
): string[] {
  const foreground = tokens["fg-inverse"];
  if (!foreground) return ["missing fg-inverse token"];

  const failures: string[] = [];
  for (const surfaceName of ["accent", "success", "error", "chart-3"]) {
    const surface = tokens[surfaceName];
    if (!surface) {
      failures.push("missing solid-fill token " + surfaceName);
      continue;
    }
    const ratio = contrastRatio(foreground, surface);
    if (ratio < 4.5) {
      failures.push(
        "text-fg-inverse on bg-" +
          surfaceName +
          ": " +
          ratio.toFixed(2) +
          ":1 (requires >= 4.5:1)"
      );
    }
  }
  return failures;
}

test("Console semantic text and status surfaces meet WCAG AA contrast", () => {
  const css = readFileSync(globalsCssPath, "utf8");
  const tokens = parseThemeColorTokens(css);
  const failures = [
    ...textTokenContrastFailures(tokens),
    ...translucentStatusContrastFailures(tokens),
    ...solidFillButtonContrastFailures(tokens)
  ];

  assert.deepEqual(
    failures,
    [],
    "WCAG AA contrast failures in console/app/globals.css:\n" +
      failures.join("\n")
  );
});
