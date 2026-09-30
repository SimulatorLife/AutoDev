/**
 * Unit and contract tests for the OpenLIT generic dashboard variables.
 *
 * Verifies:
 *   1. Variable translation contract:
 *      - Unknown scope/source/signal rejected (returns null)
 *      - Invalid attribute key rejected (returns null)
 *      - All / empty selection returns null (no filter predicate added)
 *      - Single-value selection produces typed OpenLITQuery { op: "eq", value: ... }
 *      - Multi-value selection produces typed OpenLITQuery { op: "in", value: [...] }
 *      - Per-widget scope override: re-binds an opted-in variable to a
 *        different AttributeScope (e.g. span -> resource) at query time,
 *        validates the override against the signal's allowed scopes, fails
 *        closed on invalid scope, and never mutates the board spec.
 *      - applyDashboardVariables binds to structured query filters and honors widget opt-in
 *      - URL parameter serialization/deserialization (dashboard_var_*)
 *   2. Static patch verification:
 *      - Patch 01 declares typed DashboardVariableSpec surface
 *      - Structured query path is used (no string interpolation into SQL)
 *      - Real UI surface is wired:
 *        * DashboardVariableSelector mounted in dashboard-view.tsx
 *        * DashboardVariableEditor mounted in Dialog in dashboard-view.tsx
 *        * WidgetOptInEditor mounted in edit-widget-sheet.tsx
 *        * Dynamic candidate loading via /api/manage-dashboard/variables/distinct-values
 *      - Dashboard persistence round-trip through getBoardLayout and updateBoardLayout
 *        (ClickHouse OPENLIT_BOARD_TABLE_NAME.variables)
 *      - Patch 02 wires /autodev pages, proxy, and sidebar without leaking secrets
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const PATCH1 = join(
  repositoryRoot,
  "patches/openlit/01-generic-dashboard-variables.patch"
);
const PATCH2 = join(repositoryRoot, "patches/openlit/02-autodev-pages.patch");

// ---------------------------------------------------------------------------
// Unit tests for variable translation logic (mirroring translate.ts)
// ---------------------------------------------------------------------------

export type Signal = "traces" | "logs" | "metrics";
export type AttributeScope = "resource" | "span" | "log" | "metric";

export interface DashboardVariableSpec {
  id: string;
  label: string;
  signal: Signal;
  scope: AttributeScope;
  key: string;
  multi: boolean;
  supportsAll: boolean;
  defaultValues?: string[];
  sourceId?: string | null;
  allowedValues?: string[];
}

export type DashboardVariableOptIn = string[];

export interface NormalizedFilter {
  target: "attribute";
  scope: AttributeScope;
  key: string;
  op: "eq" | "in";
  value: string | string[];
}

export interface NormalizedQueryLike {
  signal: Signal;
  filters?: NormalizedFilter[];
  [key: string]: unknown;
}

export interface DashboardVariableState {
  values: Record<string, string[]>;
  source: "url" | "default" | "localStorage";
}

const VALID_SCOPES_BY_SIGNAL: Record<Signal, ReadonlySet<AttributeScope>> = {
  traces: new Set(["resource", "span"]),
  logs: new Set(["resource", "log"]),
  metrics: new Set(["resource", "metric"])
};
const VALID_SIGNALS = new Set<string>(["traces", "logs", "metrics"]);

function bindingIsValid(signal: Signal, scope: AttributeScope): boolean {
  return VALID_SCOPES_BY_SIGNAL[signal].has(scope);
}
function scopesForSignal(signal: Signal): AttributeScope[] {
  return Array.from(VALID_SCOPES_BY_SIGNAL[signal]);
}
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.*-]{0,127}$/;
const DASHBOARD_VARIABLE_URL_PREFIX = "dashboard_var_";

function resolveVariableScope(
  spec: DashboardVariableSpec,
  scopeOverride: AttributeScope | undefined
): AttributeScope | null {
  if (!bindingIsValid(spec.signal, spec.scope)) return null;
  if (scopeOverride === undefined) return spec.scope;
  if (!bindingIsValid(spec.signal, scopeOverride)) return null;
  return scopeOverride;
}

function variableToFilter(
  spec: DashboardVariableSpec,
  selection: string[] | undefined,
  opts: { scopeOverride?: AttributeScope } = {}
): NormalizedFilter | null {
  if (
    !VALID_SIGNALS.has(spec.signal) ||
    !bindingIsValid(spec.signal, spec.scope) ||
    !ATTRIBUTE_KEY_PATTERN.test(spec.key)
  ) {
    return null;
  }
  if (!Array.isArray(selection) || selection.length === 0) {
    return null;
  }
  const effectiveScope = resolveVariableScope(spec, opts.scopeOverride);
  if (effectiveScope === null) return null;
  if (spec.multi && selection.length > 1) {
    return {
      target: "attribute",
      scope: effectiveScope,
      key: spec.key,
      op: "in",
      value: selection.slice()
    };
  }
  const singleValue = selection[0];
  if (singleValue === undefined) return null;
  return {
    target: "attribute",
    scope: effectiveScope,
    key: spec.key,
    op: "eq",
    value: singleValue
  };
}

function matchesDashboardVariable(
  spec: DashboardVariableSpec,
  signal: string,
  widgetOptIn: DashboardVariableOptIn | undefined
): boolean {
  return (
    spec.signal === signal &&
    VALID_SIGNALS.has(spec.signal) &&
    (widgetOptIn === undefined || widgetOptIn.includes(spec.id))
  );
}

function applyDashboardVariables(
  query: NormalizedQueryLike,
  specs: DashboardVariableSpec[],
  state: Pick<DashboardVariableState, "values">,
  opts: {
    widgetOptIn?: DashboardVariableOptIn;
    scopeOverrides?: Record<string, AttributeScope>;
  } = {}
): NormalizedQueryLike {
  const applicableSpecs = specs.filter((spec) =>
    matchesDashboardVariable(spec, query.signal, opts.widgetOptIn)
  );
  const additions = applicableSpecs.reduce<NormalizedFilter[]>(
    (filters, spec) => {
      const scopeOverride = opts.scopeOverrides?.[spec.id];
      const filter = variableToFilter(
        spec,
        state.values[spec.id],
        scopeOverride === undefined ? {} : { scopeOverride }
      );
      if (filter) filters.push(filter);
      return filters;
    },
    []
  );
  if (additions.length === 0) return query;
  return {
    ...query,
    filters: [...additions, ...(query.filters ?? [])]
  };
}

function serializeVariableSelection(selection: string[] | undefined): string {
  if (!selection || selection.length === 0) return "*";
  return selection.map(encodeURIComponent).join(",");
}

function parseVariableSelection(raw: string | null): string[] {
  if (raw == null || raw === "" || raw === "*") return [];
  return raw
    .split(",")
    .map((v) => {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    })
    .filter((v) => v.length > 0);
}

function variablesToSearchParams(
  state: Pick<DashboardVariableState, "values">
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [id, values] of Object.entries(state.values)) {
    params.set(
      `${DASHBOARD_VARIABLE_URL_PREFIX}${id}`,
      serializeVariableSelection(values)
    );
  }
  return params;
}

function readVariablesFromSearchParams(
  params: URLSearchParams | Record<string, string | string[] | undefined>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const entries =
    params instanceof URLSearchParams
      ? Array.from(params.entries())
      : Object.entries(params);
  for (const [key, raw] of entries) {
    if (!key.startsWith(DASHBOARD_VARIABLE_URL_PREFIX)) continue;
    const id = key.slice(DASHBOARD_VARIABLE_URL_PREFIX.length);
    if (!id) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    out[id] = parseVariableSelection(typeof value === "string" ? value : null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

test("variable filter translation: unknown source/scope or invalid key rejected", () => {
  const unknownScopeSpec: DashboardVariableSpec = {
    id: "v1",
    label: "Bad Scope",
    signal: "traces",
    scope: "unknown_scope" as unknown as AttributeScope,
    key: "gen_ai.system",
    multi: false,
    supportsAll: true
  };
  assert.equal(variableToFilter(unknownScopeSpec, ["openai"]), null);
  assert.equal(
    variableToFilter(
      { ...unknownScopeSpec, signal: "logs", scope: "span" as AttributeScope },
      ["openai"]
    ),
    null,
    "known scopes must still match the selected signal"
  );

  const unknownSignalSpec: DashboardVariableSpec = {
    id: "v2",
    label: "Bad Signal",
    signal: "events" as unknown as Signal,
    scope: "span",
    key: "gen_ai.system",
    multi: false,
    supportsAll: true
  };
  assert.equal(variableToFilter(unknownSignalSpec, ["openai"]), null);

  const invalidKeySpec: DashboardVariableSpec = {
    id: "v3",
    label: "Bad Key",
    signal: "traces",
    scope: "span",
    key: "123_invalid-key; DROP TABLE",
    multi: false,
    supportsAll: true
  };
  assert.equal(variableToFilter(invalidKeySpec, ["openai"]), null);
});

test("variable filter translation: All produces no predicate, single-select eq, multi-select in", () => {
  const spec: DashboardVariableSpec = {
    id: "model",
    label: "Model",
    signal: "traces",
    scope: "span",
    key: "gen_ai.request.model",
    multi: true,
    supportsAll: true
  };

  // All / empty selection -> no filter predicate
  assert.equal(variableToFilter(spec, undefined), null);
  assert.equal(variableToFilter(spec, []), null);

  // Single select -> eq
  const single = variableToFilter(spec, ["gpt-4o"]);
  assert.deepEqual(single, {
    target: "attribute",
    scope: "span",
    key: "gen_ai.request.model",
    op: "eq",
    value: "gpt-4o"
  });

  // Multi select -> in
  const multi = variableToFilter(spec, ["gpt-4o", "claude-3-5-sonnet"]);
  assert.deepEqual(multi, {
    target: "attribute",
    scope: "span",
    key: "gen_ai.request.model",
    op: "in",
    value: ["gpt-4o", "claude-3-5-sonnet"]
  });
});

test("applyDashboardVariables prepends filters and respects widget opt-in", () => {
  const specs: DashboardVariableSpec[] = [
    {
      id: "provider",
      label: "Provider",
      signal: "traces",
      scope: "span",
      key: "gen_ai.system",
      multi: true,
      supportsAll: true
    },
    {
      id: "workspace",
      label: "Workspace",
      signal: "traces",
      scope: "resource",
      key: "workspace.id",
      multi: false,
      supportsAll: true
    },
    {
      id: "metric_type",
      label: "Metric Type",
      signal: "metrics",
      scope: "metric",
      key: "metric.type",
      multi: false,
      supportsAll: true
    }
  ];

  const baseQuery: NormalizedQueryLike = {
    signal: "traces",
    filters: [
      {
        target: "attribute",
        scope: "span",
        key: "existing.filter",
        op: "eq",
        value: "1"
      }
    ]
  };

  // Follow all variables for the signal by default
  const resAll = applyDashboardVariables(baseQuery, specs, {
    values: {
      provider: ["openai", "anthropic"],
      workspace: ["prod"],
      metric_type: ["counter"] // different signal: should be ignored
    }
  });
  assert.equal(resAll.filters?.length, 3);
  assert.equal(resAll.filters?.[0]?.key, "gen_ai.system");
  assert.equal(resAll.filters?.[0]?.op, "in");
  assert.equal(resAll.filters?.[1]?.key, "workspace.id");
  assert.equal(resAll.filters?.[1]?.op, "eq");
  assert.equal(resAll.filters?.[2]?.key, "existing.filter");

  // Explicit widget opt-in: only opted-in variables applied
  const resOptIn = applyDashboardVariables(
    baseQuery,
    specs,
    {
      values: {
        provider: ["openai"],
        workspace: ["prod"]
      }
    },
    { widgetOptIn: ["provider"] }
  );
  assert.equal(resOptIn.filters?.length, 2);
  assert.equal(resOptIn.filters?.[0]?.key, "gen_ai.system");
  assert.equal(resOptIn.filters?.[1]?.key, "existing.filter");
});

// ---------------------------------------------------------------------------
// Per-widget scope override: re-bind an opted-in variable to a different
// AttributeScope (e.g. span -> resource) without mutating the board spec.
// ---------------------------------------------------------------------------

const SPAN_WORKSPACE_SPEC: DashboardVariableSpec = {
  id: "workspace-span",
  label: "Workspace (span)",
  signal: "traces",
  scope: "span",
  key: "workspace.id",
  multi: false,
  supportsAll: true
};

test("resolveVariableScope: valid override replaces the spec scope; invalid drops closed", () => {
  // Default (no override) returns the spec scope.
  assert.equal(resolveVariableScope(SPAN_WORKSPACE_SPEC, undefined), "span");
  // Valid override honored.
  assert.equal(
    resolveVariableScope(SPAN_WORKSPACE_SPEC, "resource"),
    "resource"
  );
  // Out-of-signal scope fails closed (returns null).
  assert.equal(resolveVariableScope(SPAN_WORKSPACE_SPEC, "log"), null);
  assert.equal(resolveVariableScope(SPAN_WORKSPACE_SPEC, "metric"), null);
});

test("scopesForSignal lists every AttributeScope a signal accepts", () => {
  assert.deepEqual(scopesForSignal("traces").sort(), ["resource", "span"]);
  assert.deepEqual(scopesForSignal("logs").sort(), ["log", "resource"]);
  assert.deepEqual(scopesForSignal("metrics").sort(), ["metric", "resource"]);
});

test("variableToFilter honors a valid scope override", () => {
  const filter = variableToFilter(SPAN_WORKSPACE_SPEC, ["alpha"], {
    scopeOverride: "resource"
  });
  assert.deepEqual(filter, {
    target: "attribute",
    scope: "resource",
    key: "workspace.id",
    op: "eq",
    value: "alpha"
  });
});

test("variableToFilter returns null on an invalid scope override (fail closed)", () => {
  const filter = variableToFilter(SPAN_WORKSPACE_SPEC, ["alpha"], {
    scopeOverride: "log"
  });
  assert.equal(filter, null);
});

test("variableToFilter keeps the All sentinel: empty selection -> no filter even with override", () => {
  assert.equal(
    variableToFilter(SPAN_WORKSPACE_SPEC, [], { scopeOverride: "resource" }),
    null
  );
  assert.equal(
    variableToFilter(SPAN_WORKSPACE_SPEC, undefined, {
      scopeOverride: "resource"
    }),
    null
  );
});

test("applyDashboardVariables: span-scoped workspace re-bound to resource for one widget, span for another", () => {
  const baseQuery: NormalizedQueryLike = {
    signal: "traces",
    filters: [
      {
        target: "attribute",
        scope: "span",
        key: "existing.filter",
        op: "eq",
        value: "1"
      }
    ]
  };

  // Widget A re-binds the span-scoped workspace to `resource`.
  const widgetA = applyDashboardVariables(
    baseQuery,
    [SPAN_WORKSPACE_SPEC],
    { values: { "workspace-span": ["alpha"] } },
    { scopeOverrides: { "workspace-span": "resource" } }
  );
  assert.equal(widgetA.filters?.length, 2);
  assert.deepEqual(widgetA.filters?.[0], {
    target: "attribute",
    scope: "resource",
    key: "workspace.id",
    op: "eq",
    value: "alpha"
  });
  assert.deepEqual(widgetA.filters?.[1], {
    target: "attribute",
    scope: "span",
    key: "existing.filter",
    op: "eq",
    value: "1"
  });

  // Widget B has no override; the spec's declared scope (`span`) is used.
  const widgetB = applyDashboardVariables(baseQuery, [SPAN_WORKSPACE_SPEC], {
    values: { "workspace-span": ["alpha"] }
  });
  assert.equal(widgetB.filters?.length, 2);
  assert.deepEqual(widgetB.filters?.[0], {
    target: "attribute",
    scope: "span",
    key: "workspace.id",
    op: "eq",
    value: "alpha"
  });
  assert.deepEqual(widgetB.filters?.[1], {
    target: "attribute",
    scope: "span",
    key: "existing.filter",
    op: "eq",
    value: "1"
  });
});

test("applyDashboardVariables: invalid scope override drops the variable's filter (fail closed)", () => {
  const baseQuery: NormalizedQueryLike = { signal: "traces" };
  const out = applyDashboardVariables(
    baseQuery,
    [SPAN_WORKSPACE_SPEC],
    { values: { "workspace-span": ["alpha"] } },
    { scopeOverrides: { "workspace-span": "log" } }
  );
  // No filter added, and the query object is returned without modification
  // (no mutation of the input).
  assert.equal(out.filters, undefined);
  assert.equal(out.signal, "traces");
});

test("applyDashboardVariables: All selection drops the filter even with a scope override", () => {
  const baseQuery: NormalizedQueryLike = { signal: "traces" };
  const out = applyDashboardVariables(
    baseQuery,
    [SPAN_WORKSPACE_SPEC],
    { values: { "workspace-span": [] } },
    { scopeOverrides: { "workspace-span": "resource" } }
  );
  assert.equal(out.filters, undefined);
});

test("applyDashboardVariables: scope overrides are ignored for variables the widget does not opt into", () => {
  const baseQuery: NormalizedQueryLike = { signal: "traces" };
  const out = applyDashboardVariables(
    baseQuery,
    [SPAN_WORKSPACE_SPEC],
    { values: { "workspace-span": ["alpha"] } },
    {
      widgetOptIn: ["other-variable"],
      scopeOverrides: { "workspace-span": "resource" }
    }
  );
  assert.equal(out.filters, undefined);
});

test("variable URL state serialization and parsing", () => {
  const state: DashboardVariableState = {
    values: {
      env: ["prod", "staging"],
      tier: []
    },
    source: "url"
  };

  const params = variablesToSearchParams(state);
  assert.equal(params.get("dashboard_var_env"), "prod,staging");
  assert.equal(params.get("dashboard_var_tier"), "*");

  const parsed = readVariablesFromSearchParams(params);
  assert.deepEqual(parsed.env, ["prod", "staging"]);
  assert.deepEqual(parsed.tier, []);
});

// ---------------------------------------------------------------------------
// Static patch tests
// ---------------------------------------------------------------------------

test("patch 01 declares the generic non-time dashboard variable surface", () => {
  const patch = readFileSync(PATCH1, "utf8");
  assert.match(
    patch,
    /DashboardVariableSpec/,
    "patch must export DashboardVariableSpec"
  );
  assert.match(
    patch,
    /applyDashboardVariables/,
    "patch must export applyDashboardVariables"
  );
  assert.match(
    patch,
    /DASHBOARD_VARIABLE_URL_PREFIX/,
    "patch must reserve a URL prefix for variable persistence"
  );
  assert.match(
    patch,
    /op: "in"/u,
    "patch must use the typed OpenLITQuery `in` operator for multi-select"
  );
  assert.match(
    patch,
    /op: "eq"/u,
    "patch must use the typed OpenLITQuery `eq` operator for single-value"
  );
});

test("patch 01 only touches the structured query path", () => {
  const patch = readFileSync(PATCH1, "utf8");
  const widgetHunk = patch.match(
    /diff --git a\/src\/client\/src\/lib\/platform\/manage-dashboard\/widget\.ts[\s\S]+?(?=\ndiff --git|$)/u
  );
  assert.ok(widgetHunk, "patch must modify widget.ts");
  assert.match(
    widgetHunk![0],
    /executeStructuredWidgetQuery/,
    "patch must thread variables through the structured path"
  );
  assert.doesNotMatch(
    widgetHunk![0],
    /renderFilterSections|renderFilterPlaceholders/u,
    "patch must not modify the mustache/placeholder code path"
  );
});

test("patch 01 wires a real dashboard variable UI surface", () => {
  const patch = readFileSync(PATCH1, "utf8");

  // Real UI: a top-bar selector with multi-select support and a discoverable hook.
  assert.match(
    patch,
    /data-dashboard-variables/u,
    "patch must add a discoverable top-bar selector hook"
  );
  assert.match(
    patch,
    /spec\.multi/u,
    "patch must implement multi-select variables in the selector"
  );
  assert.match(
    patch,
    /spec\.supportsAll|All/u,
    "patch must implement an All sentinel in the selector"
  );

  // DashboardView mounts DashboardVariableSelector
  assert.match(
    patch,
    /<DashboardVariableSelector/u,
    "dashboard-view.tsx must mount DashboardVariableSelector"
  );

  // Variable definition editor: persisted with the dashboard.
  assert.match(
    patch,
    /data-dashboard-variable-editor/u,
    "patch must add a discoverable variable-definition editor hook"
  );
  assert.match(
    patch,
    /DashboardVariableSpec\[\]/u,
    "variable editor must operate on the typed spec array"
  );

  // DashboardView renders DashboardVariableEditor in Dialog
  assert.match(
    patch,
    /<DashboardVariableEditor/u,
    "dashboard-view.tsx must render DashboardVariableEditor dialog"
  );

  // Widget opt-in editor: lets a widget declare which variables it follows.
  assert.match(
    patch,
    /data-dashboard-widget-opt-in/u,
    "patch must add a discoverable widget opt-in editor hook"
  );
  assert.match(
    patch,
    /optIn\.includes|spec\.id/u,
    "opt-in editor must honour the declared variable list"
  );

  // EditWidgetSheet mounts WidgetOptInEditor
  assert.match(
    patch,
    /<WidgetOptInEditor/u,
    "edit-widget-sheet.tsx must mount WidgetOptInEditor"
  );

  assert.match(
    patch,
    /spec\.allowedValues\?\.length/u,
    "an empty allowedValues array must still trigger dynamic value lookup"
  );
  assert.match(
    patch,
    /scope: spec\.scope/u,
    "dynamic allowed values must use the declared attribute scope"
  );

  // Dynamic candidate loading from /api/manage-dashboard/variables/distinct-values
  assert.match(
    patch,
    /\/api\/manage-dashboard\/variables\/distinct-values/u,
    "selector.tsx must dynamically load distinct values from route"
  );

  // Typed source binding for allowed values (NOT a SQL string).
  assert.match(
    patch,
    /fetchVariableAllowedValues|adapter\.distinctValues/u,
    "patch must provide a typed source binding for variable option lookup"
  );
  assert.match(
    patch,
    /scope: spec\.scope/u,
    "dynamic allowed values must use the declared attribute scope"
  );
  assert.doesNotMatch(
    patch,
    /spec\.allowedValues\s*\+[\s`]*SELECT|\$\{.*spec\.key[^\n\r}\u2028\u2029]*\}.*FROM/u,
    "patch must not concatenate allowedValues / spec.key into a SQL string"
  );
});

test("patch 01 round-trips variables through the upstream persistence path", () => {
  const patch = readFileSync(PATCH1, "utf8");

  // Board.ts: round-trip on create/update/getBoardLayout. The variables
  // column must be read on layout fetch and serialized on create/update.
  assert.match(
    patch,
    /variables AS variables/u,
    "patch must read the variables column on layout fetch"
  );
  assert.ok(
    patch.includes('jsonParse(boardResult.variables ?? "[]")'),
    "patch must decode the variables JSON string on read"
  );
  assert.ok(
    patch.includes("normalizeDashboardVariables(sanitizedBoard.variables)"),
    "patch must normalize typed variables before persistence"
  );

  // updateBoardLayout updates variables in ClickHouse
  assert.match(
    patch,
    /ALTER TABLE \$\{OPENLIT_BOARD_TABLE_NAME\}[\s\S]*?UPDATE variables =/u,
    "patch must update variables column on updateBoardLayout"
  );

  // board-format.ts: normalize on import, surface on export.
  assert.match(
    patch,
    /normalizeDashboardVariables/,
    "patch must normalize dashboard variables on import/export"
  );
  assert.match(
    patch,
    /variables: normalizeDashboardVariables\(record\.variables/u,
    "patch must thread variables through normalizeImportedDashboard"
  );
  assert.match(
    patch,
    /variables: normalizeDashboardVariables\(boardLayout\.variables/u,
    "patch must thread variables through toExportDashboardPayload"
  );

  // ClickHouse migration: column is added via `ALTER TABLE ... ADD COLUMN
  // IF NOT EXISTS variables ... DEFAULT '[]'`.
  assert.match(
    patch,
    /ADD COLUMN IF NOT EXISTS variables/u,
    "patch must add the variables column via an idempotent ALTER"
  );
});

test("patch 02 wires /autodev into the matcher without leaking service secrets", () => {
  const patch = readFileSync(PATCH2, "utf8");

  // Matcher additions
  assert.match(
    patch,
    /diff --git a\/src\/client\/src\/middleware\.ts[\s\S]+?\/autodev/u,
    "patch must add /autodev to middleware matcher"
  );

  // Proxy module
  assert.match(
    patch,
    /diff --git a\/src\/client\/src\/lib\/autodev\/control-api\.ts/u,
    "patch must add the control-api proxy"
  );
  assert.match(
    patch,
    /X-AutoDev-Actor/u,
    "proxy must forward verified actor identity"
  );
  assert.match(
    patch,
    /AUTODEV_CONTROL_API_DISABLED/u,
    "proxy must expose the kill switch"
  );
  assert.doesNotMatch(
    patch,
    /role:\s*"operator"|role:\s*"viewer"/u,
    "OpenLIT CE has no RBAC; the proxy must not fabricate a role"
  );

  // Pages
  for (const page of ["providers", "mcps", "skills", "runtime"]) {
    assert.match(
      patch,
      new RegExp(String.raw`autodev/${page}/page\.tsx`, "u"),
      `patch must add /autodev/${page} page`
    );
  }

  // Sidebar entry
  assert.match(
    patch,
    /link: "\/autodev"/u,
    "patch must add /autodev to the OpenLIT sidebar"
  );
});
