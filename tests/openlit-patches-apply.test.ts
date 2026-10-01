/**
 * Patch-set integrity test.
 *
 * Verifies the eleven AutoDev patches apply cleanly to a fresh clone of the
 * pinned upstream OpenLIT revision (openlit-2.1.0, commit
 * 9938c66638666ca5d3bcb850350faa82e510924b).
 *
 * The test clones upstream into a tmp worktree, runs `git apply --check`
 * on every patch in patches/openlit/, then asserts the resulting tree
 * matches the expected added files. It is deliberately conservative: if
 * upstream drifts, this test fails and the patch set must be regenerated.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
    assert.ok(
      patches.length >= 11,
      "expected the maintained OpenLIT patch series"
    );

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
      "src/client/src/__tests__/components/memory-action-dialog.test.tsx"
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

    // Verify the dashboard persistence round-trips variables. The
    // board table now has a `variables` column, the layout reader
    // decodes the JSON-encoded string into typed specs, and the
    // editor surfaces the list on the DashboardConfig.
    const boardTs = readFileSync(
      join(dir, "src/client/src/lib/platform/manage-dashboard/board.ts"),
      "utf8"
    );
    assert.match(
      boardTs,
      /variables AS variables/u,
      "getBoardLayout must read the new variables column"
    );
    assert.match(
      boardTs,
      /normalizeDashboardVariables\(\s*jsonParse\(boardResult\.variables/u,
      "getBoardLayout must decode the variables JSON string"
    );
    const boardFormatTs = readFileSync(
      join(dir, "src/client/src/lib/platform/manage-dashboard/board-format.ts"),
      "utf8"
    );
    assert.match(
      boardFormatTs,
      /normalizeDashboardVariables/,
      "board-format.ts must normalize variables on import/export"
    );
    const boardMigrations = readFileSync(
      join(dir, "src/client/src/clickhouse/migrations/index.ts"),
      "utf8"
    );
    assert.match(
      boardMigrations,
      /await AddBoardVariablesColumnMigration\(databaseConfigId\);\s*\/\/ Seed after the board-variable migration:[\s\S]*?await CreateCustomDashboardsSeed\(databaseConfigId\);/u,
      "built-in dashboards must seed only after their variable column exists"
    );
    const dashboardMigration = readFileSync(
      join(
        dir,
        "src/client/src/clickhouse/migrations/create-custom-dashboards-migration.ts"
      ),
      "utf8"
    );
    assert.doesNotMatch(
      dashboardMigration,
      /CreateCustomDashboardsSeed/u,
      "board-table creation must not seed before the variable migration"
    );
    assert.match(
      boardTs,
      /tags AS tags,\s*variables AS variables\s*FROM \$\{OPENLIT_BOARD_TABLE_NAME\}/u,
      "board layout reads must select both tags and variables with valid SQL"
    );
    const clickHouseQueryMap = readFileSync(
      join(
        dir,
        "src/client/src/lib/platform/connectors/datasource/clickhouse/query-map.ts"
      ),
      "utf8"
    );
    assert.match(
      clickHouseQueryMap,
      /add\(query\.signal === "traces" \? "serviceNames" : "services", filter\.value\)/u,
      "standard service.name filters must use the ClickHouse ServiceName projection"
    );

    // Verify the variable UI components exist and the typed source
    // binding is wired up.
    const selector = readFileSync(
      join(
        dir,
        "src/client/src/components/(playground)/manage-dashboard/board-creator/components/variables/selector.tsx"
      ),
      "utf8"
    );
    assert.match(
      selector,
      /data-dashboard-variables/u,
      "top-bar selector must expose a discoverable hook"
    );
    assert.match(
      selector,
      /multiselect|multi-select|spec\.multi/u,
      "top-bar selector must support multi-select variables"
    );
    const editor = readFileSync(
      join(
        dir,
        "src/client/src/components/(playground)/manage-dashboard/board-creator/components/variables/editor.tsx"
      ),
      "utf8"
    );
    assert.match(
      editor,
      /data-dashboard-variable-editor/u,
      "variable editor must expose a discoverable hook"
    );
    assert.doesNotMatch(
      editor,
      /spec\.allowedValues\s*\+\s*[`'"]/u,
      "variable editor must not concatenate allowedValues into SQL"
    );
    const optIn = readFileSync(
      join(
        dir,
        "src/client/src/components/(playground)/manage-dashboard/board-creator/components/variables/widget-opt-in-editor.tsx"
      ),
      "utf8"
    );
    assert.match(
      optIn,
      /data-dashboard-widget-opt-in/u,
      "widget opt-in editor must expose a discoverable hook"
    );
    assert.match(
      optIn,
      /optIn\.includes|spec\.id/u,
      "widget opt-in editor must honor the declared variable list"
    );
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

test("openlit patch set excludes any reference to a producer-facing otelcol pass-through", () => {
  // OpenLIT 2.1.0 ships its own OTLP receivers; producers do NOT need a
  // sidecar Collector. The patches must not regress this by adding one.
  const ls = run("ls", ["-1", PATCHES_DIR], repositoryRoot);
  const patches = ls.stdout
    .trim()
    .split("\n")
    .filter((f) => f.endsWith(".patch"));

  for (const patch of patches) {
    const content = readFileSync(join(PATCHES_DIR, patch), "utf8");
    // Anything that introduces a new OTLP Collector process is a
    // regression and must fail the test.
    assert.doesNotMatch(
      content,
      /otelcol-contrib|otelcol_/u,
      `patch ${patch} must not introduce a sidecar otelcol pass-through`
    );
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
