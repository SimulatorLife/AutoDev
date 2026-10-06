/**
 * Patch-set integrity test.
 *
 * Verifies the ordered AutoDev patch series applies cleanly to a fresh clone of
 * the pinned upstream OpenLIT revision (openlit-2.1.0, commit
 * 9938c66638666ca5d3bcb850350faa82e510924b).
 *
 * The full ordered series is applied to pinned OpenLIT, including patches 15-21,
 * then checked for expected additions and removals. Upstream drift requires
 * regenerating the patch series.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const PINNED_COMMIT = "9938c66638666ca5d3bcb850350faa82e510924b";
const PINNED_TAG = "openlit-2.1.0";
const PINNED_IMAGE_TAG = "2.1.0";
const PINNED_IMAGE_DIGEST =
  "sha256:94552ccd09379b5e2fec3c51c4fec1b41d88d6b56b0a5ccc895c116673884fa8";

const PATCHES_DIR = join(repositoryRoot, "patches/openlit");

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
) {
  const res = spawnSync(cmd, args, {
    cwd,
    ...(env ? { env } : {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function patchRangeCount(range: string): number | null {
  const parts = range.split(",");
  if (parts.length > 2 || !parts[0]) return null;
  const start = Number(parts[0]);
  const count = parts.length === 2 ? Number(parts[1]) : 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(count) &&
    count >= 0
    ? count
    : null;
}

function patchHunkCounts(
  header: string
): { oldCount: number; newCount: number } | null {
  if (!header.startsWith("@@ -")) return null;
  const separator = header.indexOf(" +", 4);
  const end = header.indexOf(" @@", separator + 2);
  if (separator === -1 || end === -1) return null;
  const oldCount = patchRangeCount(header.slice(4, separator));
  const newCount = patchRangeCount(header.slice(separator + 2, end));
  return oldCount === null || newCount === null ? null : { oldCount, newCount };
}

function assertPatchHunkCounts(patchPath: string): void {
  const lines = readFileSync(patchPath, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const counts = patchHunkCounts(lines[index] ?? "");
    if (!counts) continue;

    let actualOld = 0;
    let actualNew = 0;
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const line = lines[bodyIndex] ?? "";
      if (line.startsWith("@@ ") || line.startsWith("diff --git ")) break;
      if (line.startsWith(String.raw`\ No newline`)) continue;
      if (line.startsWith(" ")) {
        actualOld += 1;
        actualNew += 1;
      } else if (line.startsWith("-")) {
        actualOld += 1;
      } else if (line.startsWith("+")) {
        actualNew += 1;
      } else {
        break;
      }
    }
    assert.equal(
      actualOld,
      counts.oldCount,
      `${patchPath}:${index + 1} old-line hunk count`
    );
    assert.equal(
      actualNew,
      counts.newCount,
      `${patchPath}:${index + 1} new-line hunk count`
    );
  }
}

function freshClone(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-openlit-patch-check-"));
  const clone = run(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--quiet",
      "https://github.com/openlit/openlit.git",
      dir
    ],
    process.cwd()
  );
  if (clone.status !== 0) {
    throw new Error(`git clone failed: ${clone.stderr}`);
  }
  const checkout = run("git", ["checkout", "--quiet", PINNED_COMMIT], dir);
  if (checkout.status !== 0) {
    throw new Error(`git checkout ${PINNED_COMMIT} failed: ${checkout.stderr}`);
  }
  const rev = run("git", ["rev-parse", "HEAD"], dir);
  if (rev.stdout.trim() !== PINNED_COMMIT) {
    throw new Error(
      `pinned commit mismatch: HEAD is ${rev.stdout.trim()}, expected ${PINNED_COMMIT}`
    );
  }
  return dir;
}

/**
 * The OpenLIT board-authoring and Vault administration products are gone;
 * their surviving read paths are not. Kept out of the apply test body so the
 * per-patch removals stay readable and the callback stays under the
 * complexity ceiling.
 */
function assertRemovedOpenlitAdminSurfaces(dir: string) {
  // The board-authoring product is gone: there is no board,
  // folder, widget or board-widget module, and no ClickHouse table
  // behind them. The AutoDev Usage board survives as a read-only seed
  // that runWidgetQuery reads directly.
  for (const removed of [
    "src/client/src/lib/platform/manage-dashboard/board.ts",
    "src/client/src/lib/platform/manage-dashboard/board-format.ts",
    "src/client/src/lib/platform/manage-dashboard/folder.ts",
    "src/client/src/lib/platform/manage-dashboard/heirarchy.ts",
    "src/client/src/lib/platform/manage-dashboard/derived-value.ts",
    "src/client/src/lib/platform/manage-dashboard/table-details.ts",
    "src/client/src/helpers/server/widget.ts",
    "src/client/src/clickhouse/migrations/create-custom-dashboards-migration.ts",
    "src/client/src/clickhouse/migrations/add-board-variables-column-migration.ts",
    "src/client/src/clickhouse/seed/dashboards.ts",
    "src/client/src/clickhouse/seed-data/openlit-dashboard-LLM-dashboard-layout.json",
    "src/client/src/clickhouse/seed-data/openlit-dashboard-Vector-DB-layout.json",
    "src/client/src/clickhouse/seed-data/openlit-dashboard-coding-agents-layout.json"
  ]) {
    assert.equal(
      existsSync(join(dir, removed)),
      false,
      `${removed} must not survive the board-authoring removal`
    );
  }

  // The surviving reader takes the seeded definition, not a stored id:
  // nothing writes widget rows any more, so an id lookup would fail
  // every panel at run time.
  const widgetRunner = readFileSync(
    join(dir, "src/client/src/lib/platform/manage-dashboard/widget.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    widgetRunner,
    /getWidgetById|createWidget|updateWidget|deleteWidget/u,
    "runWidgetQuery must not depend on a widget catalog"
  );
  // The Usage endpoint is the surviving caller of that reader, so it has to
  // hand the runner the seeded definition rather than an id lookup.
  const usageRoute = readFileSync(
    join(dir, "src/client/src/app/api/autodev/usage/route.ts"),
    "utf8"
  );
  assert.match(
    usageRoute,
    /runWidgetQuery\(seedWidget, \{/u,
    "the Usage endpoint must hand the runner the seeded widget definition"
  );

  // Dropped tables must be dropped on existing installs, not left behind.
  const dropAuthoring = readFileSync(
    join(
      dir,
      "src/client/src/clickhouse/migrations/drop-dashboard-authoring-migration.ts"
    ),
    "utf8"
  );
  for (const table of [
    "openlit_board",
    "openlit_folder",
    "openlit_widget",
    "openlit_board_widget"
  ]) {
    assert.match(
      dropAuthoring,
      new RegExp(`DROP TABLE IF EXISTS ${table}`),
      `${table} must be dropped from existing installs`
    );
  }

  const boardMigrations = readFileSync(
    join(dir, "src/client/src/clickhouse/migrations/index.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    boardMigrations,
    /CreateCustomDashboardsMigration|AddBoardVariablesColumnMigration/u,
    "no migration may create the removed board-authoring tables"
  );
  assert.match(
    boardMigrations,
    /await DropDashboardAuthoringMigration\(databaseConfigId\);/u,
    "the drop migration must run with the other product-removal drops"
  );

  // The Vault administration product is gone; its read paths are not.
  for (const gone of [
    "src/client/src/app/(playground)/vault/page.tsx",
    "src/client/src/components/(playground)/vault/form.tsx",
    "src/client/src/components/(playground)/vault/header.tsx",
    "src/client/src/app/api/vault/route.ts",
    "src/client/src/app/api/vault/get/route.ts",
    "src/client/src/app/api/vault/[id]/route.ts"
  ]) {
    assert.equal(
      existsSync(join(dir, gone)),
      false,
      `${gone} must not survive the Vault administration removal`
    );
  }
  assert.equal(
    existsSync(join(dir, "src/client/src/app/api/vault/get-secrets/route.ts")),
    true,
    "the SDK read endpoint backs both bundled OpenLIT SDKs and must survive"
  );

  const vaultModule = readFileSync(
    join(dir, "src/client/src/lib/platform/vault/index.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    vaultModule,
    /export async function deleteSecret/u,
    "nothing may delete a secret once the admin API is gone"
  );
  for (const reader of [
    "getSecrets",
    "getSecretsFromDatabaseId",
    "getSecretById",
    "upsertSecret"
  ]) {
    assert.match(
      vaultModule,
      new RegExp(String.raw`export async function ${reader}\b`),
      `${reader} is load-bearing and must be kept`
    );
  }

  const vaultSidebar = readFileSync(
    join(dir, "src/client/src/constants/sidebar.tsx"),
    "utf8"
  );
  assert.doesNotMatch(
    vaultSidebar,
    /"\/vault"/u,
    "no sidebar entry may link to a page that no longer exists"
  );

  const vaultRoutes = readFileSync(
    join(dir, "src/client/src/constants/route.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    vaultRoutes,
    /"\/api\/vault",|"\/api\/vault\/",/u,
    "the Vault write routes must leave the demo-account restriction lists"
  );
  assert.match(
    vaultRoutes,
    /"\/api\/vault\/get-secrets"/u,
    "the SDK read endpoint must stay reachable without a session token"
  );

  const vaultMiddleware = readFileSync(
    join(dir, "src/client/src/middleware.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    vaultMiddleware,
    /"\/vault/u,
    "the removed page must leave the middleware matcher list"
  );

  // Removing the list API removes the evaluation screen's ability to pick or
  // create a judge credential. It must say so rather than render an empty
  // picker, and it must keep round-tripping a credential that already exists.
  const evaluationConfig = readFileSync(
    join(
      dir,
      "src/client/src/components/(playground)/evaluations/evaluation-configuration.tsx"
    ),
    "utf8"
  );
  assert.doesNotMatch(
    evaluationConfig,
    /\/api\/vault\/get/u,
    "the evaluation screen must not call the deleted Vault list route"
  );
  assert.match(
    evaluationConfig,
    /vaultId,/u,
    "an already-configured judge credential must still round-trip on save"
  );
  // `dashboards_total` counted a table nothing writes; reporting it would
  // have sent a frozen number to PostHog forever.
  const snapshot = readFileSync(
    join(dir, "src/client/src/lib/platform/telemetry-snapshot/index.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    snapshot,
    /dashboards_total/u,
    "the telemetry snapshot must not count the removed board table"
  );

  // The typed source binding and its SQL-safety rule survive: only the
  // board editor went away.
  const distinctValues = readFileSync(
    join(
      dir,
      "src/client/src/lib/platform/dashboard-variables/distinct-values.ts"
    ),
    "utf8"
  );
  assert.match(
    distinctValues,
    /planAndDistinctValues|adapter\.distinctValues/u,
    "distinct-values binding must use the typed adapter method"
  );
  assert.doesNotMatch(
    distinctValues,
    /\$\{req\.key\}|\$\{.*\.key\}.*SELECT/u,
    "distinct-values binding must never compose SQL with user-controlled keys"
  );

  // The fork's agents workspace duplicated the AutoDev Console's Agents
  // surface and is gone; the data plane it fed is not.
  for (const gone of [
    "src/client/src/app/(playground)/agents/page.tsx",
    "src/client/src/app/(playground)/agents/[agentKey]/page.tsx",
    "src/client/src/components/(playground)/agents/agent-scope-provider.tsx",
    "src/client/src/components/(playground)/coding-agents/coding-agent-detail.tsx"
  ]) {
    assert.equal(
      existsSync(join(dir, gone)),
      false,
      `${gone} must not survive the duplicate-agents-shell removal`
    );
  }
  assert.equal(
    existsSync(
      join(
        dir,
        "src/client/src/components/(playground)/observability/agent-scope-provider.tsx"
      )
    ),
    true,
    "the agent scope provider moved to its only surviving consumer"
  );
  assert.equal(
    existsSync(join(dir, "src/client/src/app/api/agents/materialize/route.ts")),
    true,
    "the materialize cron refreshes the agent summary tables AutoDev syncs"
  );

  const agentsMiddleware = readFileSync(
    join(dir, "src/client/src/middleware.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    agentsMiddleware,
    /"\/agents/u,
    "the removed agents page must leave the middleware matcher list"
  );

  const scopeConsumer = readFileSync(
    join(
      dir,
      "src/client/src/components/(playground)/observability/signal-list.tsx"
    ),
    "utf8"
  );
  assert.match(
    scopeConsumer,
    /observability\/agent-scope-provider/u,
    "signal-list must import the provider from its owning namespace"
  );

  // Documentation chrome and account-scoped preferences are gone; the
  // surfaces AutoDev still owns stay.
  for (const gone of [
    "src/client/src/app/(playground)/openapi-spec/page.tsx",
    "src/client/src/app/(playground)/settings/profile/page.tsx",
    "src/client/src/components/(playground)/api-keys/api-reference.tsx",
    "src/client/src/components/(playground)/coding-agents/coding-sessions-tab.tsx",
    "src/client/src/components/(playground)/coding-agents/coding-users-tab.tsx"
  ]) {
    assert.equal(
      existsSync(join(dir, gone)),
      false,
      `${gone} must not survive the docs/account-surface removal`
    );
  }

  // /settings used to redirect to the profile page; it must land somewhere
  // that still exists rather than on a 404.
  const settingsIndex = readFileSync(
    join(dir, "src/client/src/app/(playground)/settings/page.tsx"),
    "utf8"
  );
  assert.match(
    settingsIndex,
    /router\.replace\("\/settings\/api-keys"\)/u,
    "the settings index must redirect to a surviving page"
  );
  assert.doesNotMatch(
    settingsIndex,
    /\/settings\/profile/u,
    "the settings index must not redirect to a deleted page"
  );

  const settingsTabs = readFileSync(
    join(dir, "src/client/src/constants/settings.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    settingsTabs,
    /\/settings\/profile/u,
    "the removed profile page must leave the settings tab list"
  );

  const apiKeyNav = readFileSync(
    join(dir, "src/client/src/constants/sidebar.tsx"),
    "utf8"
  );
  assert.doesNotMatch(
    apiKeyNav,
    /"\/openapi-spec"|"\/settings\/profile"/u,
    "the sidebar must not link to surfaces that no longer exist"
  );
}

/** Every patch in the maintained OpenLIT series, in apply order. */
const EXPECTED_OPENLIT_PATCH_NAMES = [
  "01-generic-dashboard-variables",
  "02-autodev-pages",
  "03-otlp-receiver-auth",
  "04-autodev-usage-dashboard",
  "05-remove-login-signup",
  "06-autodev-branding",
  "07-autodev-usage-api",
  "08-autodev-memory-connector",
  "09-autodev-memory-lifecycle-actions",
  "10-autodev-memory-action-hardening",
  "11-autodev-memory-lifecycle-ui",
  "12-autodev-memory-outcomes",
  "13-autodev-memory-outcome-cohorts",
  "14-autodev-memory-outcome-reporting",
  "15-remove-gpu-product",
  "16-autodev-memory-session-outcome-cohorts",
  "17-remove-openlit-memory-session-authorization",
  "18-remove-openlit-controller-discovery",
  "19-remove-controller-image-runtime",
  "20-remove-stale-controller-messages",
  "21-remove-controller-clickhouse-schema",
  "22-autodev-memory-injection-use",
  "23-autodev-memory-visible-connector",
  "24-autodev-pricing-empty-history",
  "25-autodev-usage-filter-options",
  "26-autodev-usage-trace-detail",
  "27-remove-otter-chat-docs-onboarding-chrome",
  "28-remove-autodev-pages",
  "29-remove-openground",
  "30-remove-rule-engine",
  "31-remove-theme-switching-and-marketing-404",
  "32-remove-organisations-projects-environments",
  "33-remove-dashboard-authoring",
  "34-remove-board-authoring-tables",
  "35-remove-vault-administration",
  "36-dead-surfaces-and-broken-sidebar-nav",
  "37-remove-duplicate-agents-shell",
  "38-remove-docs-and-account-surfaces"
] as const;
test(
  "openlit patch set applies cleanly to pinned commit",
  { timeout: 180_000 },
  () => {
    const dir = freshClone();

    // Check and apply each patch against the tree produced by all predecessors.
    // Later patches intentionally modify files created by earlier patches.
    const ls = run("ls", ["-1", PATCHES_DIR], repositoryRoot);
    assert.equal(ls.status, 0, `patches dir not readable: ${ls.stderr}`);
    const patches = ls.stdout
      .trim()
      .split("\n")
      .filter((f) => f.endsWith(".patch"));
    const expectedPatchNames = [
      "01-generic-dashboard-variables",
      "02-autodev-pages",
      "03-otlp-receiver-auth",
      "04-autodev-usage-dashboard",
      "05-remove-login-signup",
      "06-autodev-branding",
      "07-autodev-usage-api",
      "08-autodev-memory-connector",
      "09-autodev-memory-lifecycle-actions",
      "10-autodev-memory-action-hardening",
      "11-autodev-memory-lifecycle-ui",
      "12-autodev-memory-outcomes",
      "13-autodev-memory-outcome-cohorts",
      "14-autodev-memory-outcome-reporting",
      "15-remove-gpu-product",
      "16-autodev-memory-session-outcome-cohorts",
      "17-remove-openlit-memory-session-authorization"
    ];
    if (patches.some((p) => p.startsWith("18-"))) {
      expectedPatchNames.push("18-remove-openlit-controller-discovery");
    }
    if (patches.some((p) => p.startsWith("19-"))) {
      expectedPatchNames.push("19-remove-controller-image-runtime");
    }
    if (patches.some((p) => p.startsWith("20-"))) {
      expectedPatchNames.push("20-remove-stale-controller-messages");
    }
    if (patches.some((p) => p.startsWith("21-"))) {
      expectedPatchNames.push("21-remove-controller-clickhouse-schema");
    }
    expectedPatchNames.push(
      "22-autodev-memory-injection-use",
      "23-autodev-memory-visible-connector",
      "24-autodev-pricing-empty-history",
      "25-autodev-usage-filter-options"
    );
    assert.ok(
      patches.length >= expectedPatchNames.length,
      `expected at least ${expectedPatchNames.length} maintained OpenLIT patches`
    );
    for (const [index, expectedName] of expectedPatchNames.entries()) {
      assert.ok(
        patches[index]?.startsWith(expectedName),
        `expected patch ${index + 1} (${expectedName}) in order, got ${patches[index]}`
      );
    }

    for (const patch of patches) {
      assertPatchHunkCounts(join(PATCHES_DIR, patch));
      const check = run(
        "git",
        ["apply", "--check", join(PATCHES_DIR, patch)],
        dir
      );
      assert.equal(
        check.status,
        0,
        `git apply --check failed for ${patch}: ${check.stderr}`
      );
      const apply = run("git", ["apply", join(PATCHES_DIR, patch)], dir);
      assert.equal(
        apply.status,
        0,
        `git apply failed for ${patch}: ${apply.stderr}`
      );
    }

    // Verify the expected files exist after patching and public types are
    // exported from the dashboard-variable module's supported entrypoint.
    const variableTypes = readFileSync(
      join(dir, "src/client/src/lib/platform/dashboard-variables/types.ts"),
      "utf8"
    );
    assert.match(
      variableTypes,
      /export type \{[\s\S]*?AttributeScope,[\s\S]*?Signal[\s\S]*?\} from "@\/lib\/platform\/connectors\/datasource\/types"/
    );
    const expected = [
      // 01-generic-dashboard-variables
      "src/client/src/lib/platform/dashboard-variables/translate.ts",
      "src/client/src/lib/platform/dashboard-variables/types.ts",
      "src/client/src/lib/platform/dashboard-variables/index.ts",
      "src/client/src/lib/platform/dashboard-variables/distinct-values.ts",
      "src/client/src/lib/platform/connectors/datasource/clickhouse/parameterized-query.ts",
      "src/client/src/app/api/manage-dashboard/variables/distinct-values/route.ts",
      "src/client/src/components/(playground)/manage-dashboard/board-creator/components/variables/selector.tsx",
      "src/client/src/components/(playground)/manage-dashboard/board-creator/components/variables/editor.tsx",
      "src/client/src/components/(playground)/manage-dashboard/board-creator/components/variables/widget-opt-in-editor.tsx",
      "src/client/src/components/(playground)/manage-dashboard/board-creator/components/variables/use-dashboard-variables.ts",
      "src/client/src/components/(playground)/manage-dashboard/board-creator/components/variables/index.ts",
      "src/client/src/clickhouse/migrations/add-board-variables-column-migration.ts",
      "src/client/src/__tests__/lib/platform/dashboard-variables/translate.test.ts",
      "src/client/src/__tests__/lib/platform/dashboard-variables/distinct-values.test.ts",
      "src/client/src/__tests__/lib/platform/datasource/parameterized-trace-query.test.ts",
      // 02-autodev-pages
      "src/client/src/lib/autodev/control-api.ts",
      "src/client/src/lib/autodev/index.ts",
      "src/client/src/__tests__/lib/autodev/control-api.test.ts",
      "src/client/src/app/(playground)/autodev/layout.tsx",
      "src/client/src/app/(playground)/autodev/page.tsx",
      "src/client/src/app/(playground)/autodev/providers/page.tsx",
      "src/client/src/app/(playground)/autodev/mcps/page.tsx",
      "src/client/src/app/(playground)/autodev/skills/page.tsx",
      "src/client/src/app/(playground)/autodev/runtime/page.tsx",
      "src/client/src/app/(playground)/autodev/api/providers/route.ts",
      "src/client/src/app/(playground)/autodev/api/mcps/route.ts",
      "src/client/src/app/(playground)/autodev/api/skills/route.ts",
      "src/client/src/app/(playground)/autodev/api/runtime/route.ts",
      // canonical contract: PATCH route
      "src/client/src/app/(playground)/autodev/api/providers/[provider]/roles/[role]/route.ts",
      // 04-autodev-usage-dashboard
      "src/client/src/clickhouse/seed-data/openlit-dashboard-AutoDev-Usage-layout.json",
      "src/client/src/lib/platform/manage-dashboard/derived-value.ts",
      "src/client/src/__tests__/clickhouse/seed/autodev-usage-dashboard.test.ts",
      "src/client/src/__tests__/lib/platform/manage-dashboard/derived-value.test.ts",
      // 07-autodev-usage-api
      "src/client/src/lib/autodev/usage-api.ts",
      "src/client/src/app/api/autodev/usage/route.ts",
      "src/client/src/__tests__/lib/autodev/usage-api.test.ts",
      // 08-autodev-memory-connector
      "src/client/src/lib/platform/connectors/memory/autodev/adapter.ts",
      "src/client/src/__tests__/lib/platform/connectors/memory-autodev-adapter.test.ts",
      // 09-autodev-memory-lifecycle-actions
      "src/client/src/components/(playground)/memory/memory-action-dialog.tsx",
      "src/client/src/app/api/memory/[id]/actions/route.ts",
      "src/client/src/__tests__/app/api/memory/[id]/actions/route.test.ts",
      "src/client/src/__tests__/components/memory-action-dialog.test.tsx",
      // 13-autodev-memory-outcome-cohorts
      "src/client/src/app/api/memory/cohorts/route.ts",
      "src/client/src/components/(playground)/memory/memory-cohort-view.tsx",
      "src/client/src/__tests__/app/api/memory/cohorts/route.test.ts",
      "src/client/src/__tests__/components/memory-cohort-view.test.tsx",
      // 14-autodev-memory-outcome-reporting
      "src/client/src/app/api/memory/experiences/[id]/outcomes/route.ts",
      "src/client/src/__tests__/app/api/memory/experiences/[id]/outcomes/route.test.ts",
      "src/client/src/components/(playground)/memory/memory-outcome-report-form.tsx",
      "src/client/src/__tests__/components/memory-outcome-report-form.test.tsx",
      // 16-autodev-memory-session-outcome-cohorts
      "src/client/src/app/api/memory/session-cohorts/route.ts",
      "src/client/src/__tests__/app/api/memory/session-cohorts/route.test.ts",
      // 22-autodev-memory-injection-use
      "src/client/src/app/api/memory/experiences/[id]/use-assessments/route.ts",
      "src/client/src/__tests__/app/api/memory/experiences/[id]/use-assessments/route.test.ts",
      "src/client/src/app/api/memory/use-cohorts/route.ts",
      "src/client/src/__tests__/app/api/memory/use-cohorts/route.test.ts",
      "src/client/src/components/(playground)/memory/memory-injection-use-report-form.tsx",
      "src/client/src/__tests__/components/memory-injection-use-report-form.test.tsx"
    ];
    for (const rel of expected) {
      const full = join(dir, rel);
      assert.ok(statSync(full).isFile(), `expected file after patch: ${rel}`);
    }
    const autoDevMemoryAdapter = readFileSync(
      join(
        dir,
        "src/client/src/lib/platform/connectors/memory/autodev/adapter.ts"
      ),
      "utf8"
    );
    assert.match(autoDevMemoryAdapter, /forwardToControlApi/u);
    assert.match(
      autoDevMemoryAdapter,
      /add: false[\s\S]*update: false[\s\S]*delete: false/u
    );
    assert.match(autoDevMemoryAdapter, /workspaceId/u);
    assert.match(autoDevMemoryAdapter, /actionsFor\(memory/u);
    assert.match(autoDevMemoryAdapter, /id: "invalidate"/u);
    assert.match(autoDevMemoryAdapter, /id: "verify"/u);
    assert.match(autoDevMemoryAdapter, /id: "revise"/u);
    assert.match(autoDevMemoryAdapter, /id: "supersede"/u);
    assert.match(autoDevMemoryAdapter, /id: "promote-skill"/u);
    assert.match(autoDevMemoryAdapter, /\/why\?/u);
    assert.match(autoDevMemoryAdapter, /presentExperience\(experience\)/u);
    assert.doesNotMatch(
      autoDevMemoryAdapter,
      /from ["']pg["']|postgres-memory-repository/u
    );
    // 23-autodev-memory-visible-connector adds the read-only AutoDev
    // Memory connector to the CE UI's visible-connector allowlist so it can
    // be created through the canonical Add Connector UI.
    const visibleConnectorTypes = readFileSync(
      join(dir, "src/client/src/lib/platform/connectors/visible-types.ts"),
      "utf8"
    );
    assert.match(
      visibleConnectorTypes,
      /"autodev"/u,
      "23-autodev-memory-visible-connector must add autodev to VISIBLE_CONNECTOR_TYPES"
    );

    const cronLogAdapter = readFileSync(
      join(dir, "src/client/src/lib/platform/cron-log/index.ts"),
      "utf8"
    );
    const cronLogTests = readFileSync(
      join(
        dir,
        "src/client/src/__tests__/lib/platform/cron-log/cron-log.test.ts"
      ),
      "utf8"
    );
    assert.match(cronLogAdapter, /if \(err \|\| !Array\.isArray\(data\)\)/u);
    assert.match(cronLogAdapter, /lastRun\?\.startedAt \?\? null/u);
    assert.match(
      cronLogTests,
      /returns null when there is no successful run yet/u
    );

    const dashboardVariableLookup = readFileSync(
      join(
        dir,
        "src/client/src/lib/platform/dashboard-variables/distinct-values.ts"
      ),
      "utf8"
    );
    const usageRoute = readFileSync(
      join(dir, "src/client/src/app/api/autodev/usage/route.ts"),
      "utf8"
    );
    const usageRouteTest = readFileSync(
      join(dir, "src/client/src/__tests__/app/api/autodev/usage/route.test.ts"),
      "utf8"
    );
    assert.match(dashboardVariableLookup, /aiSelector\?: boolean/u);
    assert.match(usageRoute, /limit: 256,\s*aiSelector: false/u);
    assert.match(
      usageRouteTest,
      /fetches filter values across AutoDev logical and MCP spans/u
    );

    const memoryDetailSheet = readFileSync(
      join(
        dir,
        "src/client/src/components/(playground)/memory/memory-detail-sheet.tsx"
      ),
      "utf8"
    );
    assert.match(memoryDetailSheet, /title=\{messages\.MEMORY_EDIT\}/u);
    assert.match(memoryDetailSheet, /title=\{messages\.MEMORY_DELETE\}/u);
    assert.match(memoryDetailSheet, /aria-label="Memory lifecycle actions"/u);
    const memoryConnectorReadme = readFileSync(
      join(dir, "src/client/src/lib/platform/connectors/memory/README.md"),
      "utf8"
    );
    assert.match(
      memoryConnectorReadme,
      /status-gated verify, revise, invalidate, supersede/u
    );
    assert.match(memoryConnectorReadme, /governed `why` route/u);
    const memoryBootstrap = readFileSync(
      join(dir, "src/client/src/lib/platform/connectors/memory/bootstrap.ts"),
      "utf8"
    );
    assert.match(memoryBootstrap, /autoDevMemoryAdapterFactory/u);
    const memoryActionRoute = readFileSync(
      join(dir, "src/client/src/app/api/memory/[id]/actions/route.ts"),
      "utf8"
    );
    assert.match(memoryActionRoute, /executeProjectMemoryAction/u);
    assert.match(
      memoryActionRoute,
      /withMemoryAudit\(withMemoryAccess\("update"/u
    );
    assert.match(memoryActionRoute, /PAYLOAD_MAX/u);

    const usageDashboard = JSON.parse(
      readFileSync(
        join(
          dir,
          "src/client/src/clickhouse/seed-data/openlit-dashboard-AutoDev-Usage-layout.json"
        ),
        "utf8"
      )
    ) as {
      title: string;
      variables: Array<{ id: string }>;
      widgets: Record<
        string,
        {
          title: string;
          properties: Record<string, unknown>;
          config: {
            query?: string;
            structuredQuery?: { query?: { filters?: unknown[] } };
          };
        }
      >;
    };
    assert.equal(usageDashboard.title, "Usage");
    assert.deepEqual(
      usageDashboard.variables.map(({ id }) => id),
      ["workspace", "provider", "model", "agent"]
    );
    const requestedModelVariable = usageDashboard.variables.find(
      ({ id }) => id === "model"
    ) as { label?: string; key?: string } | undefined;
    assert.deepEqual(requestedModelVariable, {
      id: "model",
      label: "Requested model",
      signal: "traces",
      scope: "span",
      key: "autodev.requested_model",
      multi: true,
      supportsAll: true,
      defaultValues: []
    });
    // Every widget must use a structured query scoped to a single
    // AutoDev-owned service.name. The router widgets scope to
    // autodev-router; the G10 source-owned MCP server widget scopes to
    // autodev-codex-tools-mcp. No widget may use a different owner
    // and no widget may use raw SQL.
    const ALLOWED_USAGE_SERVICE_NAMES = new Set([
      "autodev-router",
      "autodev-codex-tools-mcp"
    ]);
    assert.ok(
      Object.values(usageDashboard.widgets).every(
        ({ config }) =>
          config.structuredQuery &&
          !config.query &&
          config.structuredQuery.query?.filters?.some(
            (filter) =>
              filter !== null &&
              typeof filter === "object" &&
              "key" in filter &&
              filter.key === "service.name" &&
              "value" in filter &&
              ALLOWED_USAGE_SERVICE_NAMES.has(String(filter.value))
          )
      ),
      "the Usage seed must use typed queries scoped to a single AutoDev-owned service.name (router or codex-tools-mcp), never raw SQL"
    );
    // The G10 widgets must opt into the existing workspace and
    // agent/role variables at Resource scope via a widget-level
    // override, and must NOT duplicate Resource values onto spans.
    const g10Titles = [
      "MCP tool calls",
      "P95 tool-call duration",
      "MCP tool-call errors",
      "MCP tool calls by tool name"
    ];
    const g10Widgets = g10Titles
      .map((title) =>
        Object.values(usageDashboard.widgets).find(
          (candidate) => candidate.title === title
        )
      )
      .filter(
        (widget): widget is NonNullable<typeof widget> => widget !== undefined
      );
    assert.equal(
      g10Widgets.length,
      g10Titles.length,
      "Usage seed must include the four G10 source-owned MCP tool-call widgets"
    );
    for (const widget of g10Widgets) {
      assert.deepEqual(widget.properties.optInVariables, [
        "workspace",
        "agent"
      ]);
      assert.deepEqual(widget.properties.variableScopeOverrides, {
        workspace: "resource",
        agent: "resource"
      });
      // Every G10 widget must filter on the shim's resource
      // service.name AND on the MCP method name span attribute so the
      // source-owned observation is uniquely identified by the
      // combination.
      const filters = widget.config.structuredQuery?.query?.filters ?? [];
      const serviceNameFilter = filters.find(
        (filter) =>
          filter !== null &&
          typeof filter === "object" &&
          "key" in filter &&
          (filter as { key: unknown }).key === "service.name" &&
          "scope" in filter &&
          (filter as { scope: unknown }).scope === "resource"
      );
      assert.deepEqual(serviceNameFilter, {
        target: "attribute",
        scope: "resource",
        key: "service.name",
        op: "eq",
        value: "autodev-codex-tools-mcp"
      });
      const mcpMethodFilter = filters.find(
        (filter) =>
          filter !== null &&
          typeof filter === "object" &&
          "key" in filter &&
          (filter as { key: unknown }).key === "mcp.method.name"
      );
      assert.deepEqual(mcpMethodFilter, {
        target: "attribute",
        scope: "span",
        key: "mcp.method.name",
        op: "eq",
        value: "tools/call"
      });
    }
    // The G10 scope overrides must not silently widen the generic
    // variable engine: only the workspace and agent variables are
    // remapped to resource scope, and only on the G10 widgets.
    const routerWidgets = Object.values(usageDashboard.widgets).filter(
      (widget) => !g10Titles.includes(widget.title)
    );
    for (const widget of routerWidgets) {
      assert.equal(
        (widget.properties as { variableScopeOverrides?: unknown })
          .variableScopeOverrides,
        undefined,
        `router-scoped Usage widget ${widget.title} must not declare variableScopeOverrides`
      );
    }
    const cacheRate = Object.values(usageDashboard.widgets).find(
      ({ title }) => title === "Cache-read rate"
    );
    assert.deepEqual(cacheRate?.properties.ratio, {
      numerator: "0.cache_read_tokens",
      denominator: "0.input_tokens",
      multiplier: 100
    });

    // Verify the structured filter path is touched and the raw-SQL /
    // mustache placeholder path is NOT.
    const widget = readFileSync(
      join(dir, "src/client/src/lib/platform/manage-dashboard/widget.ts"),
      "utf8"
    );
    assert.match(
      widget,
      /applyDashboardVariables/,
      "patch must thread dashboard variables through the structured query path"
    );
    assert.match(
      widget,
      /renderFilterSections|renderFilterPlaceholders/,
      "raw SQL / mustache placeholder semantics must remain available"
    );
    assert.doesNotMatch(
      widget,
      /dashboardVariables\.specs\[\d+\]\.key\s*\+/u,
      "patch must not concatenate attribute keys into SQL strings"
    );
    const clickHouseAdapter = readFileSync(
      join(
        dir,
        "src/client/src/lib/platform/connectors/datasource/clickhouse/adapter.ts"
      ),
      "utf8"
    );
    assert.match(
      clickHouseAdapter,
      /dashboardVariableSignals:\s*\["traces"\]/u,
      "the ClickHouse adapter must advertise only safely parameterized variable signals"
    );
    const parameterizedTraceQuery = readFileSync(
      join(
        dir,
        "src/client/src/lib/platform/connectors/datasource/clickhouse/parameterized-query.ts"
      ),
      "utf8"
    );
    assert.match(
      parameterizedTraceQuery,
      /this\.queryParams\[name\]\s*=\s*value/u,
      "ClickHouse trace query values must be sent through query_params"
    );
    assert.match(
      parameterizedTraceQuery,
      /`\$\{column\}\[\$\{this\.bind\(key,\s*"String"\)\}\]`/u,
      "dynamic OTel attribute keys must also be parameterized"
    );
    const clickHouseCommon = readFileSync(
      join(dir, "src/client/src/lib/platform/common.ts"),
      "utf8"
    );
    assert.match(
      clickHouseCommon,
      /\.\.\.\(query_params\s*\?\s*\{\s*query_params\s*\}\s*:\s*\{\}\)/u,
      "the native ClickHouse client must receive typed query_params separately"
    );

    const usageEndpoint = readFileSync(
      join(dir, "src/client/src/app/api/autodev/usage/route.ts"),
      "utf8"
    );
    assert.match(usageEndpoint, /runWidgetQuery/u);
    assert.match(usageEndpoint, /fetchVariableAllowedValues/u);
    assert.match(usageEndpoint, /AUTODEV_OPENLIT_USAGE_TOKEN/u);
    assert.doesNotMatch(usageEndpoint, /userQuery\s*:/u);
    const usageMiddleware = readFileSync(
      join(dir, "src/client/src/middleware/check-auth.ts"),
      "utf8"
    );
    assert.match(usageMiddleware, /pathname === "\/api\/autodev\/usage"/u);

    const collectorConfig = readFileSync(
      join(dir, "assets/otel-collector-config.yaml"),
      "utf8"
    );
    assert.match(collectorConfig, /bearertokenauth:/u);
    assert.match(collectorConfig, /authenticator: bearertokenauth/gu);
    assert.match(collectorConfig, /token: \$\{env:OPENLIT_OTLP_API_KEY\}/u);
    assert.match(collectorConfig, /extensions: \[bearertokenauth\]/u);
    assert.equal(
      readFileSync(
        join(
          repositoryRoot,
          "config/openlit/assets/otel-collector-config.yaml"
        ),
        "utf8"
      ),
      collectorConfig,
      "the mounted Collector config must exactly match the auth-patched pinned source"
    );

    for (const asset of ["clickhouse-init.sh", "clickhouse-config.xml"]) {
      assert.equal(
        readFileSync(
          join(repositoryRoot, "config/openlit/assets", asset),
          "utf8"
        ),
        readFileSync(join(dir, "assets", asset), "utf8"),
        `${asset} must remain byte-for-byte aligned with the pinned OpenLIT source`
      );
    }
    const clickhouseInit = readFileSync(
      join(repositoryRoot, "config/openlit/assets/clickhouse-init.sh"),
      "utf8"
    );
    assert.match(
      clickhouseInit,
      /CREATE DATABASE IF NOT EXISTS \$\{CLICKHOUSE_DATABASE\}/u
    );
    assert.match(clickhouseInit, /CREATE TABLE IF NOT EXISTS otel_traces/u);
    assert.match(clickhouseInit, /toIntervalHour\(730\)/u);
    assert.doesNotMatch(
      clickhouseInit,
      /openlit_controller_|Creating OpenLIT Controller tables/u,
      "the bootstrap must not persist removed Controller resources"
    );

    assertRemovedOpenlitAdminSurfaces(dir);
    // Verify the autodev sidebar entry is discoverable. A nested
    // /autodev layout without a top-level entry would not be reachable
    // from the OpenLIT left nav.
    const sidebar = readFileSync(
      join(dir, "src/client/src/constants/sidebar.tsx"),
      "utf8"
    );
    assert.match(
      sidebar,
      /link: "\/autodev"/u,
      "sidebar.tsx must add an /autodev entry to make the surface discoverable"
    );

    // Verify the proxy honours the canonical contract:
    // - Authorization: Bearer <token>
    // - X-AutoDev-Actor: <verified session user id>
    // - NO X-AutoDev-Role, NO X-AutoDev-Actor-Email
    const proxy = readFileSync(
      join(dir, "src/client/src/lib/autodev/control-api.ts"),
      "utf8"
    );
    assert.match(proxy, /Authorization:\s*`Bearer/u);
    assert.match(proxy, /X-AutoDev-Actor/u);
    assert.match(
      proxy,
      /AUTODEV_CONTROL_API_DISABLED/u,
      "proxy must document the kill-switch env var"
    );
    // Strip comments so the assertion only sees executable code.
    const codeOnly = proxy
      .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
      .replaceAll(/^\s*\/\/.*$/gmu, "");
    assert.doesNotMatch(
      codeOnly,
      /X-AutoDev-Role/u,
      "proxy code must not forward a role header (only docs are allowed to mention it)"
    );
    assert.doesNotMatch(
      codeOnly,
      /X-AutoDev-Actor-Email/u,
      "proxy code must not forward the unverified email claim"
    );
    assert.doesNotMatch(
      codeOnly,
      /"X-AutoDev-(?:Role|Actor-Email)"/u,
      "proxy code must not set any role/email header"
    );
    // Exact-Origin enforcement for state-changing methods: the stock
    // middleware CSRF helper keys on `pathname.startsWith("/api/")` and
    // never fires for `/autodev/api/*`, so the proxy performs its
    // own check.
    assert.match(
      proxy,
      /verifyOriginForMutation|Origin/u,
      "proxy must enforce Origin for state-changing methods"
    );

    // Verify the page schema matches the upstream AutoDev Control API:
    // providers: { providers: [{ id, roles: { orchestrator: { enabled,
    // mutable }, subagent: { enabled, mutable } } }] }, MCPs:
    // { readOnly, servers: [{ name, roles }] }, Skills:
    // { readOnly, skills: [{ name, roles }] }, Runtime:
    // { routerInstanceId, lifecycle, concurrency, inFlightRequestCount }.
    const providersPage = readFileSync(
      join(dir, "src/client/src/app/(playground)/autodev/providers/page.tsx"),
      "utf8"
    );
    assert.match(
      providersPage,
      /ProviderRoles/,
      "providers page must read the typed roles map"
    );
    assert.match(
      providersPage,
      /disabledOrchestratorProviders|disabledSubagentProviders/u,
      "providers page must read the runtime disabled lists"
    );
    assert.doesNotMatch(
      providersPage,
      /tools:|transport:|exposed:|available:|displayName:/u,
      "providers page must not invent fields the upstream API does not return"
    );
    const mcpsPage = readFileSync(
      join(dir, "src/client/src/app/(playground)/autodev/mcps/page.tsx"),
      "utf8"
    );
    assert.match(
      mcpsPage,
      /readOnly|roles/,
      "mcps page must read the upstream schema"
    );
    assert.doesNotMatch(
      mcpsPage,
      /tools:|transport:|exposed:|available:/u,
      "mcps page must not invent fields the upstream API does not return"
    );
    const skillsPage = readFileSync(
      join(dir, "src/client/src/app/(playground)/autodev/skills/page.tsx"),
      "utf8"
    );
    assert.match(
      skillsPage,
      /readOnly|roles/,
      "skills page must read the upstream schema"
    );
    assert.doesNotMatch(
      skillsPage,
      /enabled:|available:/u,
      "skills page must not invent enabled/available fields the upstream API does not return"
    );
    const runtimePage = readFileSync(
      join(dir, "src/client/src/app/(playground)/autodev/runtime/page.tsx"),
      "utf8"
    );
    assert.match(
      runtimePage,
      /routerInstanceId|inFlightRequestCount|lifecycle/,
      "runtime page must read the upstream schema"
    );
    assert.doesNotMatch(
      runtimePage,
      /version:|startedAt:|collectors:|queues:/u,
      "runtime page must not invent version/startedAt/collectors/queues fields the upstream API does not return"
    );

    // Verify the PATCH route enforces the typed body shape and forwards
    // to the canonical PATCH /control/providers/{provider}/roles/{role}.
    const patchRoute = readFileSync(
      join(
        dir,
        "src/client/src/app/(playground)/autodev/api/providers/[provider]/roles/[role]/route.ts"
      ),
      "utf8"
    );
    assert.match(patchRoute, /enabled:\s*boolean/u);
    assert.match(
      patchRoute,
      /PATCH/u,
      "PATCH route handler must declare the PATCH verb"
    );
    assert.match(
      patchRoute,
      /providers\/\$\{[^}]*safeProvider[^}]*\}\/roles/u,
      "PATCH route must forward to /control/providers/{provider}/roles/{role}"
    );

    // Verify the /autodev matcher is registered so the CSRF + auth
    // stack runs in front of the proxy.
    const middleware = readFileSync(
      join(dir, "src/client/src/middleware.ts"),
      "utf8"
    );
    assert.match(middleware, /"\/autodev/u);
    assert.match(middleware, /"\/autodev\/:path\*"/u);

    // Verify patch 05 completely removes login/signup and redirects to /home:
    const loginPage = readFileSync(
      join(dir, "src/client/src/app/(auth)/login/page.tsx"),
      "utf8"
    );
    assert.match(loginPage, /redirect\(["']\/home["']\)/u);
    assert.doesNotMatch(loginPage, /AuthForm/u);

    const registerPage = readFileSync(
      join(dir, "src/client/src/app/(auth)/register/page.tsx"),
      "utf8"
    );
    assert.match(registerPage, /redirect\(["']\/home["']\)/u);
    assert.doesNotMatch(registerPage, /AuthForm/u);

    const userActions = readFileSync(
      join(
        dir,
        "src/client/src/components/(playground)/sidebar/user-actions.tsx"
      ),
      "utf8"
    );
    assert.match(userActions, /return null/u);
    assert.doesNotMatch(userActions, /signOut/u);

    const checkAuth = readFileSync(
      join(dir, "src/client/src/middleware/check-auth.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      checkAuth,
      /redirect\([^)]*\/login/u,
      "check-auth middleware must not redirect to /login"
    );

    const sessionTs = readFileSync(
      join(dir, "src/client/src/lib/session.ts"),
      "utf8"
    );
    assert.match(
      sessionTs,
      /prisma\.user\.findFirst/,
      "session.ts must fall back to local user when unauthenticated"
    );

    // Verify patch 06 rebrands all user-facing "OpenLIT" strings to "AutoDev":
    const layout = readFileSync(
      join(dir, "src/client/src/app/layout.tsx"),
      "utf8"
    );
    assert.match(
      layout,
      /AutoDev/u,
      "layout.tsx metadata must use 'AutoDev' branding"
    );
    assert.doesNotMatch(
      layout,
      /OpenLIT/u,
      "layout.tsx must not contain user-facing 'OpenLIT'"
    );

    const sidebarBrand = readFileSync(
      join(dir, "src/client/src/components/(playground)/sidebar-brand.tsx"),
      "utf8"
    );
    assert.match(
      sidebarBrand,
      /AutoDev/u,
      "sidebar-brand.tsx must use 'AutoDev' branding"
    );

    const sidebarIndex = readFileSync(
      join(dir, "src/client/src/components/(playground)/sidebar/index.tsx"),
      "utf8"
    );
    assert.match(
      sidebarIndex,
      /Search AutoDev/u,
      "sidebar search placeholder must use 'AutoDev'"
    );

    const versionInfo = readFileSync(
      join(dir, "src/client/src/components/(playground)/version-Info.tsx"),
      "utf8"
    );
    assert.match(
      versionInfo,
      /AutoDev:/u,
      "version-Info.tsx must display 'AutoDev:' label"
    );

    const messagesEn = readFileSync(
      join(dir, "src/client/src/constants/messages/en.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      messagesEn,
      /(?<!\w)OpenLIT(?!\w)/u,
      "en.ts message constants must not contain user-facing 'OpenLIT'"
    );

    // Verify patch 15 completely removes the GPU product and dashboard:
    const removedGpuPaths = [
      "src/client/src/app/(playground)/dashboard/gpu/gpu-metric.tsx",
      "src/client/src/app/(playground)/dashboard/gpu/index.tsx",
      "src/client/src/app/(playground)/dashboard/gpu/number-stats.tsx",
      "src/client/src/clickhouse/seed-data/openlit-dashboard-GPU-dashboard-layout.json",
      "src/client/src/__tests__/lib/platform/gpu/external.test.ts",
      "src/client/src/__tests__/lib/platform/gpu/gpu.test.ts",
      "src/client/src/__tests__/lib/platform/gpu/temperature-fanspeed.test.ts",
      "src/client/src/lib/platform/gpu/external.ts",
      "src/client/src/lib/platform/gpu/fanspeed.ts",
      "src/client/src/lib/platform/gpu/memory.ts",
      "src/client/src/lib/platform/gpu/power.ts",
      "src/client/src/lib/platform/gpu/temperature.ts",
      "src/client/src/lib/platform/gpu/utilization.ts"
    ];
    for (const rel of removedGpuPaths) {
      const full = join(dir, rel);
      assert.equal(
        existsSync(full),
        false,
        `15-remove-gpu-product must remove: ${rel}`
      );
    }
    const dashboardType = readFileSync(
      join(dir, "src/client/src/app/(playground)/dashboard/dashboard-type.tsx"),
      "utf8"
    );
    assert.doesNotMatch(
      dashboardType,
      /GPUDashboard/u,
      "dashboard-type.tsx must not import or render GPUDashboard"
    );
    assert.doesNotMatch(
      dashboardType,
      /gpu:\s*["']GPU["']/u,
      "dashboard-type.tsx must not contain GPU tab label"
    );
    const pageTypes = readFileSync(
      join(dir, "src/client/src/types/store/page.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      pageTypes,
      /gpu:\s*["']gpu["']/u,
      "types/store/page.ts must not define GPU dashboard type"
    );
    const commonPlatform = readFileSync(
      join(dir, "src/client/src/lib/platform/common.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      commonPlatform,
      /OTEL_GPUS_TABLE_NAME/u,
      "common.ts must not define OTEL_GPUS_TABLE_NAME"
    );

    // Verify patch 16 adds session outcome cohorts:
    const sessionCohortsRoute = readFileSync(
      join(dir, "src/client/src/app/api/memory/session-cohorts/route.ts"),
      "utf8"
    );
    assert.match(sessionCohortsRoute, /readSessionOutcomeCohorts/u);
    assert.match(sessionCohortsRoute, /resolveAutoDevConnectorId/u);
    assert.match(sessionCohortsRoute, /withMemoryAccess\("read"/u);
    assert.match(
      sessionCohortsRoute,
      /MEMORY_SESSION_COHORTS_UNSUPPORTED_CONNECTOR/u
    );
    assert.match(sessionCohortsRoute, /MAX_COHORT_WINDOW_MS/u);
    const memoryCohortView = readFileSync(
      join(
        dir,
        "src/client/src/components/(playground)/memory/memory-cohort-view.tsx"
      ),
      "utf8"
    );
    assert.match(memoryCohortView, /\/api\/memory\/session-cohorts/u);
    assert.match(memoryCohortView, /MEMORY_SESSION_COHORTS_TITLE/u);
    assert.match(memoryCohortView, /MemorySessionCohortResult/u);
    assert.match(messagesEn, /MEMORY_SESSION_COHORTS_TITLE/u);
    assert.match(messagesEn, /MEMORY_SESSION_COHORTS_NOTE/u);
    assert.match(autoDevMemoryAdapter, /readSessionOutcomeCohorts/u);
    assert.match(
      autoDevMemoryAdapter,
      /autodev-memory-session-outcome-cohorts-v1/u
    );
    assert.match(autoDevMemoryAdapter, /conflictingOutcomeSessionCount/u);

    // Patch 22 extends the same CE AutoDev Control API adapter with
    // curator-authored injection-use assessment reads/writes and a bounded,
    // count-only use cohort query. It does not add percentages or any rate
    // or causal metric.
    assert.match(autoDevMemoryAdapter, /readInjectionUseAssessments\(/u);
    assert.match(autoDevMemoryAdapter, /reportInjectionUse\(/u);
    assert.match(autoDevMemoryAdapter, /readInjectionUseCohorts\(/u);
    assert.match(
      autoDevMemoryAdapter,
      /USE_COHORT_ASSIGNED_MODES[\s\S]*?"disabled"/u
    );
    assert.match(autoDevMemoryAdapter, /USE_COHORT_ELIGIBLE_MODES/u);
    assert.match(autoDevMemoryAdapter, /injection\.id/u);
    assert.match(
      autoDevMemoryAdapter,
      /injectionResult !== "injected"[\s\S]*?memoryIds/u
    );
    assert.doesNotMatch(
      autoDevMemoryAdapter,
      /correlationToken\s*:\s*(?:injection|joined|value)|reporterId\s*:/u,
      "patch 22 must not project opaque correlation tokens or reporter identity to the UI"
    );
    const useAssessmentsRoute = readFileSync(
      join(
        dir,
        "src/client/src/app/api/memory/experiences/[id]/use-assessments/route.ts"
      ),
      "utf8"
    );
    assert.doesNotMatch(
      useAssessmentsRoute,
      /export const GET/u,
      "experience reads must stay with the canonical AutoDev MemoryAdapter detail path"
    );
    assert.match(
      useAssessmentsRoute,
      /export const POST\s*=\s*withMemoryAudit\(withMemoryAccess\("update"/u
    );
    assert.match(useAssessmentsRoute, /reportInjectionUse\(/u);
    assert.match(useAssessmentsRoute, /requiredId\(params\.id\)/u);
    assert.match(useAssessmentsRoute, /request\.json\(\)/u);
    assert.match(useAssessmentsRoute, /MEMORY_INJECTION_USE_REPORT_INVALID/u);
    const useCohortsRoute = readFileSync(
      join(dir, "src/client/src/app/api/memory/use-cohorts/route.ts"),
      "utf8"
    );
    assert.match(
      useCohortsRoute,
      /export const GET\s*=\s*withMemoryAccess\("read"/u
    );
    assert.match(useCohortsRoute, /readInjectionUseCohorts\(/u);
    const useForm = readFileSync(
      join(
        dir,
        "src/client/src/components/(playground)/memory/memory-injection-use-report-form.tsx"
      ),
      "utf8"
    );
    assert.match(useForm, /MEMORY_USE_KIND_PLACEHOLDER/u);
    assert.match(
      useForm,
      /value=\{EMPTY_KIND\}[\s\S]*?MEMORY_USE_KIND_PLACEHOLDER/u
    );
    assert.match(useForm, /formatUseKindLabel/u);
    const useDetail = readFileSync(
      join(
        dir,
        "src/client/src/components/(playground)/memory/memory-detail-sheet.tsx"
      ),
      "utf8"
    );
    assert.match(
      useDetail,
      /injection\.injectionResult === "injected" && packetIds\.length > 0/u
    );
    assert.match(useDetail, /MEMORY_DETAIL_INJECTION_USE_INELIGIBLE/u);
    const useCohortView = readFileSync(
      join(
        dir,
        "src/client/src/components/(playground)/memory/memory-cohort-view.tsx"
      ),
      "utf8"
    );
    assert.match(useCohortView, /\/api\/memory\/use-cohorts/u);
    assert.match(useCohortView, /MEMORY_USE_COHORTS_SCOPE_NOTE/u);
    assert.match(useCohortView, /MEMORY_USE_COHORTS_UNASSESSED/u);
    assert.doesNotMatch(
      useCohortView,
      /percentage|success\s*rate|(?:Math\.)?round\([^\n]*\*\s*100|toFixed\(/iu,
      "patch 22 must render counts, not percentages or outcome/use rates"
    );

    // Verify patch 17 removes OpenLIT session gating in favor of Control API:
    assert.match(
      proxy,
      /CONTROL_API_ACTOR_ENV\s*=\s*"AUTODEV_CONTROL_API_ACTOR"/u,
      "proxy must define AUTODEV_CONTROL_API_ACTOR env key"
    );
    assert.match(
      proxy,
      /LOCAL_CONTROL_API_ACTOR\s*=\s*"autodev-local"/u,
      "proxy must default to autodev-local actor"
    );
    assert.doesNotMatch(
      proxy,
      /fetchActorFromSession/u,
      "proxy must not derive actor from OpenLIT session"
    );
    assert.doesNotMatch(
      proxy,
      /_setActorResolverForTesting/u,
      "proxy must remove testing session resolver hook"
    );
    assert.doesNotMatch(
      memoryActionRoute,
      /getCurrentUser/u,
      "memory action route must delegate actor auth to Control API without an OpenLIT session gate"
    );
    const memoryCohortsRoute = readFileSync(
      join(dir, "src/client/src/app/api/memory/cohorts/route.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      memoryCohortsRoute,
      /getCurrentUser/u,
      "memory cohorts route must delegate auth to Control API without an OpenLIT session gate"
    );
    const memoryOutcomesRoute = readFileSync(
      join(
        dir,
        "src/client/src/app/api/memory/experiences/[id]/outcomes/route.ts"
      ),
      "utf8"
    );
    assert.doesNotMatch(
      memoryOutcomesRoute,
      /getCurrentUser/u,
      "memory outcome reporting route must delegate auth to Control API without an OpenLIT session gate"
    );

    // Verify patch 18 removes OpenLIT controller discovery if present:
    if (patches.some((p) => p.startsWith("18-"))) {
      const removedControllerDiscoveryPaths = [
        "src/client/src/app/(playground)/agents/controller-table.tsx",
        "src/client/src/app/(playground)/agents/no-controller.tsx",
        "src/client/src/app/(playground)/fleet-hub/page.tsx",
        "src/client/src/app/api/controller",
        "src/client/src/app/api/fleet-hub",
        "src/client/src/lib/platform/controller",
        "src/client/src/lib/platform/fleet-hub",
        "src/client/src/store/agents-instrumentation.ts",
        "src/client/src/selectors/agents-instrumentation.ts",
        "src/client/src/types/controller.ts",
        "src/client/src/types/store/agents-instrumentation.ts",
        "src/client/src/clickhouse/migrations/create-controller-migration.ts",
        "src/client/src/clickhouse/migrations/generalize-controller-desired-states-migration.ts",
        "src/opamp-server/main.go",
        "src/opamp-server/setup-supervisor.sh"
      ];
      for (const rel of removedControllerDiscoveryPaths) {
        assert.equal(
          existsSync(join(dir, rel)),
          false,
          `18-remove-openlit-controller-discovery must remove: ${rel}`
        );
      }

      const receiverConfig = readFileSync(
        join(dir, "assets/otel-collector-config.yaml"),
        "utf8"
      );
      assert.match(receiverConfig, /bearertokenauth/u);
      assert.match(receiverConfig, /endpoint: 0\.0\.0\.0:4317/u);
      assert.match(receiverConfig, /endpoint: 0\.0\.0\.0:4318/u);
    }

    if (patches.some((p) => p.startsWith("19-"))) {
      const dockerfile = readFileSync(join(dir, "src/Dockerfile"), "utf8");
      assert.doesNotMatch(
        dockerfile,
        /go-builder|opamp-server|opampsupervisor|OPAMP_SUPERVISOR_VERSION|\/app\/opamp/u,
        "patch 19 must remove the OpAMP build/runtime image contents"
      );
      assert.match(
        dockerfile,
        /COPY --from=otel-downloader \/tmp\/otelcol-contrib \/app\/otel\/otelcol-contrib/u,
        "patch 19 must keep only OpenLIT's bundled OTLP receiver"
      );
      const entrypoint = readFileSync(
        join(dir, "src/client/scripts/entrypoint.sh"),
        "utf8"
      );
      assert.match(entrypoint, /wait -n "\$NODE_PID" "\$OTEL_COLLECTOR_PID"/u);
      assert.match(entrypoint, /trap .*SIGTERM/u);
      assert.doesNotMatch(entrypoint, /exec node/u);
      assert.doesNotMatch(
        entrypoint,
        /telemetry\\.useOtelForInternalMetrics/u,
        "patch 19 must not pass a feature gate unsupported by the pinned receiver"
      );
      const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
      assert.doesNotMatch(
        compose,
        /^\u0020{2}(?:otel-collector|otelcol|autodev-collector):/mu,
        "patch 19 must not introduce a separate Collector service"
      );
    }

    if (patches.some((p) => p.startsWith("20-"))) {
      for (const locale of ["en", "hi"]) {
        const messages = readFileSync(
          join(dir, "src/client/src/constants/messages/" + locale + ".ts"),
          "utf8"
        );
        assert.doesNotMatch(
          messages,
          /^export const AGENTS_(?:SOURCE_CONTROLLER|SOURCE_BOTH|COLUMN_CONTROLLER|STATUS_INSTRUMENTED|LLM_OBSERVABILITY_DESCRIPTION|AGENT_USE_NOTE|AGENT_TOGGLE_CONTROLLER_UPGRADE|CONTROLLER_DEFAULT_TITLE|STAT_INSTRUMENTED|CONFIG_SAVED)\\b/mu,
          "patch 20 must remove stale Controller constants from " + locale
        );
      }
    }
  }
);

test("apply-patches refuses a non-empty work directory without deleting it", () => {
  const workDirectory = mkdtempSync(
    join(tmpdir(), "autodev-openlit-preserve-workdir-")
  );
  const sentinel = join(workDirectory, "user-data.txt");
  try {
    writeFileSync(sentinel, "preserve this data\n");
    const result = run(
      "bash",
      [join(repositoryRoot, "scripts/openlit/apply-patches.sh")],
      repositoryRoot,
      {
        ...process.env,
        REPO_ROOT: repositoryRoot,
        AUTODEV_OPENLIT_WORK_DIR: workDirectory
      }
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /refusing to reset or clean non-empty work directory/u
    );
    assert.equal(readFileSync(sentinel, "utf8"), "preserve this data\n");
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
});

test(
  "apply-patches.sh applies the full patch series to a fresh empty work directory",
  { timeout: 180_000 },
  () => {
    const workDirectory = mkdtempSync(
      join(tmpdir(), "autodev-openlit-apply-script-")
    );
    try {
      const result = run(
        "bash",
        [join(repositoryRoot, "scripts/openlit/apply-patches.sh")],
        repositoryRoot,
        {
          ...process.env,
          REPO_ROOT: repositoryRoot,
          AUTODEV_OPENLIT_WORK_DIR: workDirectory
        }
      );
      assert.equal(
        result.status,
        0,
        `apply-patches.sh failed: stdout=${result.stdout} stderr=${result.stderr}`
      );
      const rev = run("git", ["rev-parse", "HEAD"], workDirectory);
      assert.equal(rev.stdout.trim(), PINNED_COMMIT);

      // Every patch in the series must have actually landed: each
      // patch's new files must be present in the real worktree the
      // script produced, proving the ordered check+apply loop (not a
      // check-all-then-apply-all loop) ran against the accumulating
      // tree.
      const ls = run("ls", ["-1", PATCHES_DIR], repositoryRoot);
      assert.equal(ls.status, 0, `patches dir not readable: ${ls.stderr}`);
      const patches = ls.stdout
        .trim()
        .split("\n")
        .filter((f) => f.endsWith(".patch"));
      // Data-driven rather than one `if` per patch: the ladder this
      // replaced grew the callback past the cognitive-complexity ceiling,
      // and asserting the series equals the known names in order is a
      // stronger check than a prefix walk — an unexpected patch now fails.
      const appliedPatchNames = patches.map((file) =>
        file.replace(/\.patch$/u, "")
      );
      const expectedPatchNames = EXPECTED_OPENLIT_PATCH_NAMES.filter((name) =>
        appliedPatchNames.includes(name)
      );
      assert.deepEqual(
        appliedPatchNames,
        expectedPatchNames,
        "the OpenLIT patch series must be exactly the known patches, in order"
      );

      for (const [index, expectedName] of expectedPatchNames.entries()) {
        assert.ok(
          patches[index]?.startsWith(expectedName),
          `expected patch ${index + 1} (${expectedName}) in order in the series, got ${patches[index]}`
        );
      }

      // 06-autodev-branding depends on files created by 01-05; its
      // presence after a clean script run proves later patches applied
      // against the accumulated tree rather than the untouched base.
      const layout = readFileSync(
        join(workDirectory, "src/client/src/app/layout.tsx"),
        "utf8"
      );
      assert.match(layout, /AutoDev/u);
      assert.doesNotMatch(layout, /OpenLIT/u);

      // 13-autodev-memory-outcome-cohorts depends on files created by
      // 08-12; its presence proves the cohort view applied.
      assert.ok(
        statSync(
          join(workDirectory, "src/client/src/app/api/memory/cohorts/route.ts")
        ).isFile()
      );
      // 14-autodev-memory-outcome-reporting extends the existing experience
      // detail surface with an evidence-backed, token-private report form.
      assert.ok(
        statSync(
          join(
            workDirectory,
            "src/client/src/app/api/memory/experiences/[id]/outcomes/route.ts"
          )
        ).isFile()
      );

      // 15-remove-gpu-product removes the GPU dashboard and metrics
      assert.equal(
        existsSync(
          join(
            workDirectory,
            "src/client/src/app/(playground)/dashboard/gpu/index.tsx"
          )
        ),
        false,
        "15-remove-gpu-product must remove GPU dashboard files"
      );

      // 16-autodev-memory-session-outcome-cohorts adds the session cohorts route
      assert.ok(
        statSync(
          join(
            workDirectory,
            "src/client/src/app/api/memory/session-cohorts/route.ts"
          )
        ).isFile(),
        "16-autodev-memory-session-outcome-cohorts must add the session cohorts route"
      );

      // 17-remove-openlit-memory-session-authorization removes OpenLIT session gating
      const appliedControlApi = readFileSync(
        join(workDirectory, "src/client/src/lib/autodev/control-api.ts"),
        "utf8"
      );
      assert.match(
        appliedControlApi,
        /AUTODEV_CONTROL_API_ACTOR/u,
        "17-remove-openlit-memory-session-authorization must configure server-only actor"
      );
      assert.doesNotMatch(
        appliedControlApi,
        /fetchActorFromSession/u,
        "17-remove-openlit-memory-session-authorization must remove fetchActorFromSession"
      );
      const appliedActionRoute = readFileSync(
        join(
          workDirectory,
          "src/client/src/app/api/memory/[id]/actions/route.ts"
        ),
        "utf8"
      );
      assert.doesNotMatch(
        appliedActionRoute,
        /getCurrentUser/u,
        "17-remove-openlit-memory-session-authorization must remove session check in memory actions"
      );

      // 18-remove-openlit-controller-discovery removes controller discovery when present
      if (patches.some((p) => p.startsWith("18-"))) {
        assert.equal(
          existsSync(
            join(
              workDirectory,
              "src/client/src/app/(playground)/agents/controller-table.tsx"
            )
          ),
          false,
          "18-remove-openlit-controller-discovery must remove controller-table"
        );
      }
      if (patches.some((p) => p.startsWith("19-"))) {
        const dockerfile = readFileSync(
          join(workDirectory, "src/Dockerfile"),
          "utf8"
        );
        assert.doesNotMatch(
          dockerfile,
          /go-builder|opamp-server|opampsupervisor|OPAMP_SUPERVISOR_VERSION|\/app\/opamp/u
        );
        assert.match(
          dockerfile,
          /COPY --from=otel-downloader \/tmp\/otelcol-contrib \/app\/otel\/otelcol-contrib/u
        );
        const entrypoint = readFileSync(
          join(workDirectory, "src/client/scripts/entrypoint.sh"),
          "utf8"
        );
        assert.match(
          entrypoint,
          /wait -n "\$NODE_PID" "\$OTEL_COLLECTOR_PID"/u
        );
        assert.doesNotMatch(entrypoint, /exec node/u);
        assert.doesNotMatch(
          entrypoint,
          /telemetry\\.useOtelForInternalMetrics/u
        );
      }
      if (patches.some((p) => p.startsWith("20-"))) {
        for (const locale of ["en", "hi"]) {
          const messages = readFileSync(
            join(
              workDirectory,
              "src/client/src/constants/messages/" + locale + ".ts"
            ),
            "utf8"
          );
          assert.doesNotMatch(
            messages,
            /^export const AGENTS_(?:SOURCE_CONTROLLER|SOURCE_BOTH|COLUMN_CONTROLLER|STATUS_INSTRUMENTED|LLM_OBSERVABILITY_DESCRIPTION|AGENT_USE_NOTE|AGENT_TOGGLE_CONTROLLER_UPGRADE|CONTROLLER_DEFAULT_TITLE|STAT_INSTRUMENTED|CONFIG_SAVED)\\b/mu
          );
        }
      }

      if (patches.some((p) => p.startsWith("21-"))) {
        const clickhouseInit = readFileSync(
          join(workDirectory, "assets/clickhouse-init.sh"),
          "utf8"
        );
        assert.doesNotMatch(
          clickhouseInit,
          /openlit_controller_|Creating OpenLIT Controller tables/u,
          "patch 21 must remove Controller table creation from fresh ClickHouse initialization"
        );
      }

      // 22-autodev-memory-injection-use adds curator assessment and count-only
      // cohort UI to the existing AutoDev Memory connector. Verify the new
      // routes and form were applied by the script after patch 21.
      for (const rel of [
        "src/client/src/app/api/memory/experiences/[id]/use-assessments/route.ts",
        "src/client/src/app/api/memory/use-cohorts/route.ts",
        "src/client/src/components/(playground)/memory/memory-injection-use-report-form.tsx"
      ]) {
        assert.ok(
          statSync(join(workDirectory, rel)).isFile(),
          `22-autodev-memory-injection-use must add ${rel}`
        );
      }
      const appliedUseAssessmentsRoute = readFileSync(
        join(
          workDirectory,
          "src/client/src/app/api/memory/experiences/[id]/use-assessments/route.ts"
        ),
        "utf8"
      );
      assert.doesNotMatch(appliedUseAssessmentsRoute, /export const GET/u);
      assert.match(appliedUseAssessmentsRoute, /withMemoryAccess\("update"/u);
      assert.match(appliedUseAssessmentsRoute, /reportInjectionUse\(/u);
      const appliedUseCohortsRoute = readFileSync(
        join(
          workDirectory,
          "src/client/src/app/api/memory/use-cohorts/route.ts"
        ),
        "utf8"
      );
      assert.match(appliedUseCohortsRoute, /withMemoryAccess\("read"/u);
      assert.match(appliedUseCohortsRoute, /readInjectionUseCohorts\(/u);
      const appliedUseAdapter = readFileSync(
        join(
          workDirectory,
          "src/client/src/lib/platform/connectors/memory/autodev/adapter.ts"
        ),
        "utf8"
      );
      assert.match(appliedUseAdapter, /readInjectionUseAssessments\(/u);
      assert.match(appliedUseAdapter, /reportInjectionUse\(/u);
      assert.match(appliedUseAdapter, /readInjectionUseCohorts\(/u);
      assert.doesNotMatch(
        appliedUseAdapter,
        /correlationToken\s*:\s*(?:injection|joined|value)|reporterId\s*:/u
      );
      const appliedUseDetail = readFileSync(
        join(
          workDirectory,
          "src/client/src/components/(playground)/memory/memory-detail-sheet.tsx"
        ),
        "utf8"
      );
      assert.match(
        appliedUseDetail,
        /injection\.injectionResult === "injected" && packetIds\.length > 0/u
      );
      assert.match(appliedUseDetail, /MEMORY_DETAIL_INJECTION_USE_INELIGIBLE/u);
      const appliedUseCohortView = readFileSync(
        join(
          workDirectory,
          "src/client/src/components/(playground)/memory/memory-cohort-view.tsx"
        ),
        "utf8"
      );
      assert.match(appliedUseCohortView, /\/api\/memory\/use-cohorts/u);
      assert.match(appliedUseCohortView, /MEMORY_USE_COHORTS_SCOPE_NOTE/u);
      assert.doesNotMatch(
        appliedUseCohortView,
        /percentage|success\s*rate|(?:Math\.)?round\([^\n]*\*\s*100|toFixed\(/iu
      );

      // 23-autodev-memory-visible-connector adds the read-only AutoDev
      // Memory connector to the CE UI's visible-connector allowlist so it
      // can be created through the canonical Add Connector UI.
      const appliedVisibleConnectorTypes = readFileSync(
        join(
          workDirectory,
          "src/client/src/lib/platform/connectors/visible-types.ts"
        ),
        "utf8"
      );
      assert.match(
        appliedVisibleConnectorTypes,
        /"autodev"/u,
        "23-autodev-memory-visible-connector must add autodev to VISIBLE_CONNECTOR_TYPES"
      );

      const status = run("git", ["status", "--short"], workDirectory);
      assert.doesNotMatch(
        status.stdout,
        /^(?:UU|AA|DD|U[ADU]|[ADU]U) /mu,
        "worktree must contain no unmerged/conflicted paths after a successful run"
      );
      const rejFiles = run("find", [".", "-name", "*.rej"], workDirectory);
      assert.equal(
        rejFiles.stdout.trim(),
        "",
        "a successful apply-patches.sh run must leave no .rej reject files"
      );
    } finally {
      rmSync(workDirectory, { recursive: true, force: true });
    }
  }
);

test("OpenLIT patches do not add a producer-facing Collector sidecar", () => {
  // OpenLIT retains its own authenticated OTLP receiver inside the UI
  // container. Producers must not be redirected through a new compose
  // service or a Collector hostname; bundling the receiver is expected.
  const ls = run("ls", ["-1"], PATCHES_DIR);
  assert.equal(ls.status, 0, ls.stderr);
  const patches = ls.stdout
    .trim()
    .split("\n")
    .filter((file) => file.endsWith(".patch"));

  for (const patch of patches) {
    const content = readFileSync(join(PATCHES_DIR, patch), "utf8");
    assert.doesNotMatch(
      content,
      /^\+[ \t]*(?:otel-collector|otelcol|autodev-collector):/mu,
      `patch ${patch} must not add a producer-facing Collector service`
    );
    assert.doesNotMatch(
      content,
      /^\+.*(?:OTEL_EXPORTER_OTLP_ENDPOINT\s*=.*(?:otelcol|otel-collector)|endpoint:\s*https?:\/\/(?:otelcol|otel-collector)(?:[:/]|$))/mu,
      `patch ${patch} must not point producers at a Collector pass-through`
    );
  }
});

test("27-remove-otter-chat-docs-onboarding-chrome removes Otter/chat/docs/onboarding surfaces", () => {
  // Resolve the patch out of the directory rather than hand-typing its path.
  // The name used to be written without the `.patch` suffix, so `existsSync`
  // probed a path that never existed and this test failed on its first
  // assertion every run. That failure is what hid the rest: the hunk-count
  // check, the scan for reintroduced chat imports, `git apply --check`, and the
  // banned-surface assertions below all sat unreachable after it, leaving this
  // large product-removal patch effectively unverified. Deriving the name the
  // way the sibling tests do means a rename now fails loudly with a message
  // that names what is actually on disk.
  const ls = run("ls", ["-1"], PATCHES_DIR);
  assert.equal(ls.status, 0, ls.stderr);
  const patch = ls.stdout
    .trim()
    .split("\n")
    .filter((file) => file.endsWith(".patch"))
    .find((file) => file.startsWith("27-"));
  assert.ok(
    patch,
    "patches/openlit must contain the 27-remove-otter-chat-docs-onboarding-chrome patch"
  );
  const patchPath = join(PATCHES_DIR, patch);
  const content = readFileSync(patchPath, "utf8");
  assertPatchHunkCounts(patchPath);
  for (const banned of [
    /components\/(playground)\/chat/,
    /lib\/platform\/chat/,
    /lib\/chat/,
    /store\/chat/,
    /selectors\/chat/,
    /types\/store\/chat/
  ]) {
    assert.doesNotMatch(
      content,
      new RegExp(String.raw`^\+\s*.*from\s*["']@` + banned.source),
      "patch 27 must not reintroduce a chat import: " + banned.source
    );
  }
  const dir = freshClone();
  try {
    const check = run("git", ["apply", "--check", patchPath], dir);
    assert.equal(check.status, 0, "git apply --check failed: " + check.stderr);
    const apply = run("git", ["apply", patchPath], dir);
    assert.equal(apply.status, 0, "git apply failed: " + apply.stderr);
    const client = join(dir, "src/client");
    const bannedFiles = [
      "src/app/(playground)/chat/page.tsx",
      "src/app/(playground)/chat/settings/page.tsx",
      "src/app/(playground)/chat/usage/page.tsx",
      "src/app/(playground)/getting-started/page.tsx",
      "src/app/(playground)/onboarding/page.tsx",
      "src/app/api/chat",
      "src/components/(playground)/chat",
      "src/components/(playground)/memory/ask-otter.tsx",
      "src/components/(playground)/sidebar/otter-sidebar.tsx",
      "src/components/svg/otter.tsx",
      "src/components/rbac/otter-page-access.tsx",
      "src/components/(playground)/getting-started",
      "src/components/(playground)/prompt-hub/prompt-otter-inline-assistant.tsx",
      "src/components/(playground)/request/components/trace-improvement-view.tsx",
      "src/components/(playground)/request/components/trace-ai-analysis-panel.tsx",
      "src/lib/platform/chat",
      "src/lib/platform/connectors/memory/ask.ts",
      "src/lib/platform/governance/otter-findings.ts",
      "src/lib/platform/kubernetes/index.ts",
      "src/lib/chat"
    ];
    for (const rel of bannedFiles) {
      assert.equal(
        existsSync(join(client, rel)),
        false,
        "27-remove-otter-chat-docs-onboarding-chrome must remove " + rel
      );
    }
    const docsGrep = run(
      "grep",
      ["-rln", "docs.openlit.io", join(client, "src")],
      dir
    );
    const docsOffenders = [];
    for (const line of docsGrep.stdout.split("")) {
      if (!line) continue;
      const rel = line.slice(dir.length + 1);
      if (rel.includes("__tests__")) continue;
      if (rel.endsWith("openground/sdk-usage-dialog.tsx")) continue;
      if (rel.endsWith("agents/no-coding-agents.tsx")) continue;
      docsOffenders.push(rel);
    }
    assert.deepEqual(
      docsOffenders,
      [],
      "27-remove-otter-chat-docs-onboarding-chrome must leave no docs.openlit.io references in the patched client (excluded: openground SDK usage and OpenLIT CLI install snippet)"
    );
    const otterGrep = run(
      "grep",
      [
        "-rln",
        "--include=*.ts",
        "--include=*.tsx",
        "-e",
        "ask-otter-panel",
        "-e",
        "OtterSidebar",
        join(client, "src")
      ],
      dir
    );
    const otterOffenders = [];
    for (const line of otterGrep.stdout.split("")) {
      if (!line) continue;
      const rel = line.slice(dir.length + 1);
      if (rel.includes("__tests__")) continue;
      otterOffenders.push(rel);
    }
    assert.deepEqual(
      otterOffenders,
      [],
      "27-remove-otter-chat-docs-onboarding-chrome must leave no Otter/chat surface references in the patched client"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("openlit pin metadata matches the published digest and image tag", () => {
  const env = readFileSync(
    join(repositoryRoot, "config/openlit/openlit.env"),
    "utf8"
  );
  assert.ok(
    env.includes(PINNED_IMAGE_DIGEST),
    `openlit.env must pin image digest ${PINNED_IMAGE_DIGEST}`
  );
  assert.ok(
    env.includes(PINNED_IMAGE_TAG),
    `openlit.env must include image tag ${PINNED_IMAGE_TAG} (NOT the source release tag ${PINNED_TAG})`
  );
  assert.doesNotMatch(
    env,
    /^OTLP_REQUIRE_API_KEY=/mu,
    "OpenLIT 2.1.0 does not consume an OTLP_REQUIRE_API_KEY setting"
  );
  assert.doesNotMatch(
    env,
    /^(?:OPENLIT_DB_PASSWORD|AUTODEV_CONTROL_API_TOKEN|OPENLIT_OTLP_API_KEY)=/mu,
    "tracked openlit.env must never contain generated secrets"
  );
  assert.doesNotMatch(
    env,
    /^OPENLIT_DB_PASSWORD=(?:openlit|replace-me)/mu,
    "openlit.env must not commit a runnable weak default for OPENLIT_DB_PASSWORD"
  );
  assert.doesNotMatch(
    env,
    /^AUTODEV_CONTROL_API_TOKEN=(?:openlit|replace-me)/mu,
    "openlit.env must not commit a runnable weak default for AUTODEV_CONTROL_API_TOKEN"
  );
  assert.match(
    env,
    /OPENLIT_IMAGE=autodev-openlit:[^\s]+-patched/u,
    "openlit.env must default OPENLIT_IMAGE to the local patched image"
  );

  const compose = readFileSync(
    join(repositoryRoot, "config/openlit/docker-compose.yml"),
    "utf8"
  );
  assert.ok(
    !compose.includes("otelcol"),
    "docker-compose must not add a sidecar otelcol collector"
  );
  assert.match(
    compose,
    /autodev-openlit:[^\s]+-patched/u,
    "docker-compose must default to the patched image"
  );
  assert.match(
    compose,
    /\$\{OPENLIT_DB_PASSWORD:\?[^}]+\}/u,
    "docker-compose must require OPENLIT_DB_PASSWORD (no weak fallback)"
  );
  assert.match(
    compose,
    /\$\{AUTODEV_CONTROL_API_TOKEN:\?[^}]+\}/u,
    "docker-compose must require AUTODEV_CONTROL_API_TOKEN (no weak fallback)"
  );
  assert.match(
    compose,
    /\$\{OPENLIT_OTLP_API_KEY:\?[^}]+\}/u,
    "docker-compose must require the receiver token from the secret file"
  );
  assert.match(
    compose,
    /\$\{AUTODEV_OPENLIT_USAGE_TOKEN:\?[^}]+\}/u,
    "docker-compose must require the dedicated Usage service token"
  );
  assert.match(compose, /127\.0\.0\.1:4318:4318/u);
  assert.match(compose, /127\.0\.0\.1:4317:4317/u);
  assert.match(compose, /\.\/assets\/clickhouse-init\.sh/u);
  assert.match(compose, /\.\/assets\/clickhouse-config\.xml/u);
  assert.match(
    compose,
    /\.\/assets\/otel-collector-config\.yaml:\/etc\/otel\/otel-collector-config\.yaml:ro/u,
    "the embedded Collector must load the auth-patched pinned config"
  );
  for (const mount of [
    "./assets/clickhouse-init.sh:/docker-entrypoint-initdb.d/init.sh:ro",
    "./assets/clickhouse-config.xml:/etc/clickhouse-server/config.d/custom-config.xml:ro",
    "./assets/otel-collector-config.yaml:/etc/otel/otel-collector-config.yaml:ro"
  ]) {
    assert.equal(
      compose.split(mount).length - 1,
      1,
      `Compose must mount ${mount} exactly once`
    );
  }
  assert.match(
    compose,
    /SQLITE_DATABASE_URL:\s*file:\/app\/client\/data\/data\.db/u,
    "the client Prisma database must be configured on its persistent volume"
  );

  const pinScript = readFileSync(
    join(repositoryRoot, "scripts/openlit/pin-image.sh"),
    "utf8"
  );
  assert.ok(pinScript.includes(`ghcr.io/openlit/openlit:${PINNED_IMAGE_TAG}`));
  assert.ok(pinScript.includes(PINNED_IMAGE_DIGEST));
  // The default fallback MUST NOT use the source release tag.
  assert.ok(
    !pinScript.includes(`ghcr.io/openlit/openlit:${PINNED_TAG}`),
    "pin-image.sh default tag must be the image tag (2.1.0), not the source release tag (openlit-2.1.0)"
  );

  const buildScript = readFileSync(
    join(repositoryRoot, "scripts/openlit/build-local.sh"),
    "utf8"
  );
  assert.match(
    buildScript,
    /PATCH_SET_HASH|patch_set_hash/u,
    "build-local.sh must tag the image by upstream_commit + patch_set_hash"
  );
  assert.match(
    buildScript,
    /LOCK_FILE|AUTODEV_OPENLIT_LOCK_FILE/u,
    "build-local.sh must record the built image id/digest in a lock file"
  );

  assert.match(
    buildScript,
    /docker build/u,
    "build-local.sh must run `docker build` and exit non-zero on failure"
  );
  assert.match(
    buildScript,
    /docker info --format '\{\{\.OSType\}\}\/\{\{\.Architecture\}\}'/u,
    "build-local.sh must derive the native platform from the active Docker daemon"
  );
  assert.match(
    buildScript,
    /--platform "linux\/\$TARGET_ARCH"[\s\\]+--build-arg "TARGETARCH=\$TARGET_ARCH"/u,
    "the target architecture must be explicit for both the image and embedded OTLP binaries"
  );
  assert.equal(
    (
      buildScript.match(
        /^\s*"\$REPO_ROOT\/scripts\/openlit\/apply-patches\.sh"\s*$/gmu
      ) ?? []
    ).length,
    1,
    "build-local.sh is the single owner of patch application"
  );

  const upScript = readFileSync(
    join(repositoryRoot, "scripts/openlit/up.sh"),
    "utf8"
  );
  assert.match(
    upScript,
    /mktemp -d|AUTODEV_OPENLIT_WORK_DIR/u,
    "up.sh must use a fresh temporary clone/work directory"
  );
  assert.doesNotMatch(
    upScript,
    /^\s*"\$REPO_ROOT\/scripts\/openlit\/apply-patches\.sh"/mu,
    "up.sh must not apply the patches a second time into the build worktree"
  );
  assert.match(upScript, /docker image inspect/u);
  assert.match(upScript, /LOCKED_IMAGE_ID/u);
  assert.match(
    upScript,
    /bootstrap-secrets|replace-me|\bopenlit\b/u,
    "up.sh must reject weak DB / control secrets before compose ever starts"
  );
  assert.match(
    upScript,
    /CODEX_HOME.*openlit-secrets\.env/su,
    "up.sh must store generated secrets outside the repository"
  );
  assert.match(
    upScript,
    /bootstrap-otlp-key/u,
    "up.sh must materialize the OTLP producer key"
  );
  assert.ok(
    upScript.indexOf("bootstrap-secrets.sh") < upScript.indexOf("up -d"),
    "secrets and receiver auth must be configured before containers start"
  );
  assert.match(
    upScript,
    /CREATED_DIRS|trap cleanup/u,
    "up.sh must only clean up directories it created (no existing .tmp data)"
  );

  const otlpKeyScript = readFileSync(
    join(repositoryRoot, "scripts/openlit/bootstrap-otlp-key.sh"),
    "utf8"
  );
  assert.match(
    otlpKeyScript,
    /0600/,
    "bootstrap-otlp-key.sh must write the OTLP key with mode 0600"
  );
  assert.match(
    otlpKeyScript,
    /CODEX_HOME/,
    "bootstrap-otlp-key.sh must write the OTLP key outside the repo (CODEX_HOME or equivalent)"
  );
  assert.match(otlpKeyScript, /Authorization=Bearer%%20/u);
  assert.doesNotMatch(
    otlpKeyScript,
    /curl .*api\/v1\/auth/u,
    "the receiver token must not depend on a nonexistent OpenLIT key-mint API"
  );

  const bootstrapSecrets = readFileSync(
    join(repositoryRoot, "scripts/openlit/bootstrap-secrets.sh"),
    "utf8"
  );
  assert.match(
    bootstrapSecrets,
    /OPENLIT_DB_PASSWORD|AUTODEV_CONTROL_API_TOKEN|OPENLIT_OTLP_API_KEY|AUTODEV_OPENLIT_USAGE_TOKEN/u,
    "bootstrap-secrets.sh must generate all required secrets"
  );
  assert.match(bootstrapSecrets, /--secret-file/u);
  assert.match(bootstrapSecrets, /chmod 0600/u);

  assert.match(
    bootstrapSecrets,
    /openssl|python3/,
    "bootstrap-secrets.sh must use openssl or python3 to generate strong secrets"
  );
});

test("secret bootstrap writes mode-0600 files outside the repository without printing token values", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-openlit-secret-test-"));
  try {
    const secretFile = join(directory, "openlit-secrets.env");
    const keyFile = join(directory, "openlit-otlp-api-key");
    writeFileSync(
      secretFile,
      "OPENLIT_DB_PASSWORD=replace-me-stale-secret\nAUTODEV_CONTROL_API_TOKEN=change-me-stale-service-secret\n",
      { mode: 0o600 }
    );
    const bootstrap = run(
      "bash",
      [
        join(repositoryRoot, "scripts/openlit/bootstrap-secrets.sh"),
        "--secret-file",
        secretFile
      ],
      repositoryRoot
    );
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const keyBootstrap = run(
      "bash",
      [
        join(repositoryRoot, "scripts/openlit/bootstrap-otlp-key.sh"),
        "--secret-file",
        secretFile,
        "--key-file",
        keyFile
      ],
      repositoryRoot
    );
    assert.equal(keyBootstrap.status, 0, keyBootstrap.stderr);
    const values = new Map(
      readFileSync(secretFile, "utf8")
        .split("\n")
        .filter((line) => /^[A-Z0-9_]+=/.test(line))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
    const receiverToken = values.get("OPENLIT_OTLP_API_KEY");
    assert.match(values.get("OPENLIT_DB_PASSWORD") ?? "", /^[0-9a-f]{64}$/u);
    assert.match(
      values.get("AUTODEV_CONTROL_API_TOKEN") ?? "",
      /^[0-9a-f]{64}$/u
    );
    assert.match(receiverToken ?? "", /^[0-9a-f]{64}$/u);
    const stableSecrets = readFileSync(secretFile, "utf8");
    const rerun = run(
      "bash",
      [
        join(repositoryRoot, "scripts/openlit/bootstrap-secrets.sh"),
        "--secret-file",
        secretFile
      ],
      repositoryRoot
    );
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(readFileSync(secretFile, "utf8"), stableSecrets);
    assert.ok(receiverToken);
    assert.equal(readFileSync(keyFile, "utf8").trim(), receiverToken);
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(
      (bootstrap.stdout + keyBootstrap.stdout).includes(receiverToken),
      false,
      "bootstrap output must never include the raw receiver token"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
