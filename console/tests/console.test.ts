import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AgentDefinition,
  CANONICAL_NAV_GROUPS,
  CANONICAL_NAVIGATION,
  type CanonicalNavSection,
  type ControlApiMemoryWhyResponse,
  type ControlApiModelsResponse,
  type ControlApiPromptDetailResponse,
  type ControlApiProviderRecord,
  type ControlApiProvidersResponse,
  type ExperienceEnvelope,
  type GithubWorkflowDefinition,
  LOCAL_CONTROL_API_ACTOR,
  type McpServerResource,
  type MemoryInjectionUseCohortCell,
  type MemoryRecord,
  type MemorySessionOutcomeCohortCell,
  type MemorySessionOutcomeCohortPage,
  type MemoryStatusCounts,
  PROVIDER_ROLES,
  SANDBOX_MODES,
  type SkillEligibility,
  type ToolCatalogItem,
  type UsageMetricsData
} from "@simulatorlife/autodev-core";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER
} from "next/constants.js";
import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ResourceUnavailable } from "../app/_console.ts";
import * as memoryRoute from "../app/api/memory/route.ts";
import * as modelRoute from "../app/api/models/[model]/route.ts";
import * as promptMutationRoute from "../app/api/prompts/[name]/route.ts";
import * as providerLimitsRoute from "../app/api/providers/[provider]/limits/route.ts";
import * as providerRoleRoute from "../app/api/providers/[provider]/roles/[role]/route.ts";
import * as providerRoute from "../app/api/providers/[provider]/route.ts";
import EvaluationsPage from "../app/evaluations/page.ts";
import MemoryPage from "../app/memory/page.ts";
import { FilterNotice } from "../src/components/filters/FilterNotice.ts";
import {
  type FilterSpec,
  resolveFilter
} from "../src/components/filters/resolve-filter.ts";
import {
  ICON_PATHS,
  NAV_ICONS,
  navIcon
} from "../src/components/icons/Icon.ts";
import { AppShell } from "../src/components/layout/AppShell.ts";
import { PAGE_SECTION_STACK_CLASS } from "../src/components/layout/PageBody.ts";
import {
  pageRangeLabel,
  Pagination
} from "../src/components/navigation/Pagination.ts";
import { ControlFailureNotice } from "../src/components/status/ControlFailureNotice.ts";
import {
  MONO_ID_CLASS,
  MONO_META_CLASS,
  MONO_VALUE_CLASS
} from "../src/components/ui/text-classes.ts";
import {
  AgentDetailView,
  AgentsView,
  AppNav,
  BarChart,
  Breadcrumbs,
  CALLOUT_WARNING_CLASS,
  Chip,
  chipList,
  ClosePanelLink,
  CODE_BLOCK_CLASS,
  CODE_BLOCK_HEIGHT_CLASS,
  CODE_EDITOR_CLASS,
  CODE_SNIPPET_CLASS,
  CodeBlock,
  CodeEditor,
  ConvergenceBadge,
  DataTable,
  type DataTableProps,
  DEFAULT_MEMORY_PAGE_SIZE,
  DETAIL_DRAWER_CLASS,
  DETAIL_DRAWER_HEADER_CLASS,
  DETAIL_DRAWER_SUBTITLE_CLASS,
  DETAIL_DRAWER_TITLE_ROW_CLASS,
  DetailDrawer,
  EMPTY_BOX_CLASS,
  EMPTY_INLINE_CLASS,
  EmptyState,
  ENTITY_TITLE_CLASS,
  EvaluationsView,
  FilterBar,
  FilterSearchField,
  formatCount,
  formatLatency,
  formatTokenCount,
  GithubView,
  HooksView,
  isProvidersReturnPath,
  MAX_MEMORY_OFFSET,
  MCP_DETAIL_TABS,
  McpDetailView,
  McpsView,
  MEMORY_STATUS_LABEL,
  MEMORY_STATUS_ORDER,
  MEMORY_STATUS_VARIANT,
  MemoryCohortsView,
  memoryDetailHref,
  MemoryExperiencesView,
  type MemoryExperiencesViewProps,
  memoryFilterHref,
  memoryListHref,
  type MemoryListScope,
  memoryPageHref,
  MemoryRecordsView,
  MemoryView,
  ModelDetailView,
  NOT_OBSERVED_LABEL,
  PathText,
  PermissionsView,
  PromptDetailView,
  PromptsView,
  ProviderDetailView,
  ProvidersView,
  resolveActiveTabId,
  resolveMemoryPage,
  SECTION_HEADING_CLASS,
  SkillsView,
  StatCard,
  StatusBadge,
  tabHref,
  TabNav,
  TAG_SHAPE,
  ToolDetailView,
  ToolsView,
  UsageView,
  withControlFailure,
  WorkspacesView
} from "../src/index.ts";
import {
  CONSOLE_BUILD_DIST_DIR,
  CONSOLE_DEV_DIST_DIR,
  consoleDistDir
} from "../src/lib/build-output.ts";
import {
  CONTROL_REFUSAL_REASONS,
  readControlRefusal
} from "../src/lib/control-failure.ts";
import {
  canonicalNavPath,
  canonicalSectionFromPath
} from "../src/lib/routes.ts";
import {
  CONTROL_API_PATHS,
  fetchAgentDetail,
  fetchAgents,
  fetchControlApi,
  fetchEvaluations,
  fetchGithubWorkflows,
  fetchHooks,
  fetchMcps,
  fetchMemoryCohorts,
  fetchMemoryExperienceOutcomes,
  fetchMemoryExperiences,
  fetchMemoryHistory,
  fetchMemoryRecord,
  fetchMemoryRecords,
  fetchMemoryStatus,
  fetchMemoryUseCohorts,
  fetchModels,
  fetchPermissions,
  fetchPromptDetail,
  fetchPrompts,
  fetchPromptVersion,
  fetchPromptVersions,
  fetchProviders,
  fetchRuntime,
  fetchSkills,
  fetchTools,
  fetchWorkspaces,
  patchSkillRoles,
  readControlApiConfig
} from "../src/lib/server/control-api.ts";
import {
  readOpenLITUsageConfig,
  usageSelectionFromSearchParams
} from "../src/lib/server/openlit-usage.ts";
import {
  hooksFromControlApi,
  permissionsFromControlApi,
  promptDocumentFromControlApi,
  promptsFromControlApi,
  skillEligibilityFromControlApi,
  skillsFromControlApi,
  unresolvedSkillAssignmentsFromControlApi,
  workspacesFromControlApi
} from "../src/lib/server/views.ts";

const unavailablePromptHistory = {
  status: "unavailable",
  message: "Git history unavailable in this test."
} as const;

const MEMORY_PAGE_ENV_KEYS = [
  "HOME",
  "CODEX_HOME",
  "AUTODEV_CONTROL_API_TOKEN",
  "AUTODEV_CONTROL_API_BASE_URL",
  "AUTODEV_OPENLIT_SECRET_FILE",
  "AUTODEV_OPENLIT_USAGE_TOKEN",
  "AUTODEV_OPENLIT_USAGE_URL"
] as const;

function saveConsolePageEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    MEMORY_PAGE_ENV_KEYS.map((key) => [key, process.env[key]])
  );
}

function restoreConsolePageEnvironment(
  saved: Record<string, string | undefined>
): void {
  for (const key of MEMORY_PAGE_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const CONFIGURED_AGENT: AgentDefinition = {
  id: "orchestrator",
  role: "orchestrator",
  kind: "orchestrator",
  readOnly: false,
  configured: true,
  valid: null,
  status: "configured",
  convergence: "not-observed",
  primaryModel: "autodev/orchestrator",
  models: ["autodev/orchestrator"],
  providers: ["codex"],
  tools: [
    { name: "orchestration", type: "skill" },
    { name: "playwright", type: "mcp", server: "playwright" }
  ],
  toolNames: ["orchestration", "playwright"]
};

test("every canonical navigation resource has its own icon, and no icon is orphaned", () => {
  // The sidebar is the Console's primary wayfinding, and an icon is how an
  // operator recognises a resource before reading its label. A missing one is
  // invisible in a diff and to every other test: the link still renders, the
  // text still reads, and the gap only shows as one blunter row than its
  // neighbours.
  //
  // This matters more than a normal exhaustiveness check because the two lists
  // involved used to be written out separately -- a type union and a `Set`
  // literal of the same thirteen names -- so adding a resource to one left
  // the other stale, and which one you had edited decided whether it typechecked.
  const missing = CANONICAL_NAVIGATION.filter(
    (section) => navIcon(section) === null
  );
  assert.deepEqual(
    missing,
    [],
    `These navigation resources render with no icon: ${missing.join(", ")}`
  );

  // The other direction matters too: an icon declared as a nav icon that no
  // section uses is a section that was renamed or removed while its glyph
  // stayed behind, and it is exactly what would let a future section borrow a
  // dead resource's icon by accident.
  const orphaned = NAV_ICONS.filter(
    (name) => !(CANONICAL_NAVIGATION as readonly string[]).includes(name)
  );
  assert.deepEqual(
    orphaned,
    [],
    `These nav icons belong to no canonical section: ${orphaned.join(", ")}`
  );
  assert.deepEqual(
    [...NAV_ICONS].sort(),
    [...CANONICAL_NAVIGATION].sort(),
    "The nav icon set and the canonical navigation must be the same thirteen resources"
  );

  // And the set must not borrow another resource's glyph. `navIcon` returns
  // `null` rather than a fallback precisely so an unknown section cannot
  // inherit some other section's icon.
  assert.equal(navIcon("NotAResource"), null);
});

test("the icon set holds no glyph that nothing renders", () => {
  // `ICON_PATHS` describes itself as a deliberately closed set, which is what
  // keeps stroke weight and optical size consistent. A dead entry is not a
  // harmless spare part: it is a second spelling of a decision (this icon
  // drawn at 16 here, a hand-rolled one at 14 there) waiting to be used, and it
  // survives because nothing checks. Four entries had accumulated exactly that
  // way before this guard existed.
  //
  // A name is rendered either through the nav list or by a `name:` prop, so
  // both forms count as usage. The scan covers `app/` as well as `src/`
  // because routes render icons too, and skips `Icon.ts` itself so the
  // declarations do not mark themselves as used.
  const consoleRoot = join(import.meta.dirname, "..");
  const usage = new Set<string>(NAV_ICONS);
  for (const dir of ["src", "app"]) {
    for (const relative of readdirSync(join(consoleRoot, dir), {
      recursive: true
    })) {
      const file = join(consoleRoot, dir, relative.toString());
      if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
      if (file.endsWith(join("icons", "Icon.ts"))) continue;
      const source = readFileSync(file, "utf8");
      // Match the property, not any occurrence of the word: a section name like
      // "Tools" also appears in prose, in a route path, and in a test id.
      for (const match of source.matchAll(/\bname:\s*["'`]([\w]+)["'`]/gu)) {
        const name = match[1];
        if (name !== undefined) usage.add(name);
      }
    }
  }

  const dead = Object.keys(ICON_PATHS).filter((name) => !usage.has(name));
  assert.deepEqual(
    dead,
    [],
    `These icons are declared but never rendered: ${dead.join(", ")}`
  );

  // The set is closed in the other direction too: a `name:` prop is typed
  // against `IconName`, so the compiler already rejects a glyph that is not
  // declared. That is why only the dead direction needs a test.
  assert.ok(Object.keys(ICON_PATHS).length > 0, "the icon set is not empty");
});

test("missing evidence is reported in one word, from one constant", () => {
  // `NOT_OBSERVED_LABEL` exists so the one word that must never drift cannot.
  // It did not: eight sites spelled the same state as "Unknown" and one as
  // "N/A", and 18 more hard-coded the right word as a bare literal, which
  // leaves the constant decorative -- changing it would have moved the 24
  // constant sites and left the literals behind.
  //
  // The visible symptom was one page contradicting itself. `/mcps` renders two
  // stat cards about the same missing runtime probe: "Active Shims" read
  // "Not observed" and the card beside it, "Health", read "Unknown". An
  // operator cannot tell from that whether the Console disagrees with itself or
  // the probe answered two different questions, and a badge whose `status` is
  // `not-observed` while its `label` is "Unknown" splits the same fact in two.
  //
  // Scoped to the three literals that had drifted, because a broader rule is
  // where this class of guard dies: "a string that means missing" cannot be
  // distinguished from data by reading the source. `StatusBadge.ts` is skipped
  // because it declares the constant and documents the failure in prose.
  //
  // `memory-status.ts` is skipped for the same reason: it is the Memory
  // vocabulary declaration, where `unknown` is a value Core reports as an
  // outcome (`ExperienceOutcome` carries it beside success/partial/failure) and
  // not a stand-in for missing evidence. A view is not allowed to invent the
  // word; the table that declares the vocabulary has to contain it, or the
  // honest fix is to change what the Runtime reports rather than to reword it.
  const VOCABULARY_DECLARATIONS = [
    join("status", "StatusBadge.ts"),
    join("memory", "memory-status.ts")
  ];
  const consoleRoot = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  for (const dir of ["src", "app"]) {
    for (const relative of readdirSync(join(consoleRoot, dir), {
      recursive: true
    })) {
      const file = join(consoleRoot, dir, relative.toString());
      if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
      if (VOCABULARY_DECLARATIONS.some((skip) => file.endsWith(skip))) continue;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        // A comment quoting the word is documentation of the rule, not a
        // violation of it, and the component's own doc is mostly that.
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        for (const literal of ['"Unknown"', '"N/A"', '"—"']) {
          if (line.includes(literal)) {
            offenders.push(
              `${relative.toString()}:${index + 1} ${line.trim()}`
            );
          }
        }
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Report missing evidence as NOT_OBSERVED_LABEL, not as a literal: ${offenders.join(" | ")}`
  );

  // And the constant is what the pages actually render, so the guard above
  // cannot pass against a word that nothing ships.
  const unobserved = renderToStaticMarkup(
    React.createElement(McpsView, {
      servers: [],
      sourceValidity: true,
      validationIssues: []
    })
  );
  assert.ok(
    unobserved.includes(NOT_OBSERVED_LABEL),
    `the mcps page must render the canonical word, got: ${unobserved}`
  );
  assert.ok(
    !unobserved.includes("Unknown"),
    `the mcps page must not drift to another word, got: ${unobserved}`
  );
});

/** The `/tools` source filter, which is the shape every bounded filter takes. */
const SPEC: FilterSpec = {
  name: "source",
  allowed: ["all", "native", "mcp", "plugin"],
  fallback: "all"
};

test("an unrecognised URL filter is named, never resolved into a default", async () => {
  // Every list page read its filters out of the query string, and every one of
  // those values is arbitrary text. Each page answered an unrecognised value the
  // same way: substitute the default, then draw that default as the reader's own
  // choice. Measured in a browser, `?source=bogus` on `/tools` answered with the
  // whole 41-entry catalog and the "all" chip rendered as selected;
  // `?kind=bogus` on `/memory` drew a select reading "All Kinds" while the
  // request carried `kind=bogus` to the Runtime; `?tab=bogus` drew "Durable
  // Records" as the current tab. Three surfaces, one behaviour: the page asserts
  // a filter state it never observed.
  //
  // So a coercion is not a resolution. A bounded filter is silent, applied, or
  // *named as not applied*, and `resolveFilter` is the only thing that decides
  // which -- which is why the coupling assertion below matters more than any one
  // of these cases.

  // Silent: nothing to report, and the page's default applies.
  assert.deepEqual(resolveFilter(undefined, SPEC), {
    value: "all",
    unapplied: null
  });
  assert.deepEqual(resolveFilter("   ", SPEC), {
    value: "all",
    unapplied: null
  });
  // Accepted, including the fallback spelled out -- `?source=all` asks for "all",
  // it does not ask for an unknown source.
  assert.deepEqual(resolveFilter("mcp", SPEC), {
    value: "mcp",
    unapplied: null
  });
  assert.deepEqual(resolveFilter("all", SPEC), {
    value: "all",
    unapplied: null
  });
  // Unrecognised: the fallback is applied *and* the request is named, so the
  // page can say what it ignored instead of implying it was never asked.
  assert.deepEqual(resolveFilter("bogus", SPEC), {
    value: "all",
    unapplied: { name: "source", value: "bogus" }
  });
  // A pasted query string cannot reflow the page, and the echo stays escaped by
  // React rather than being sanitised into something it never was.
  const long = resolveFilter("z".repeat(200), SPEC);
  assert.equal(long.unapplied?.value.length, 40);
  assert.ok(long.unapplied?.value.endsWith("…"));

  // The notice is not decorative: one and several read differently, it claims no
  // outcome, and an empty list renders nothing at all.
  const one = renderToStaticMarkup(
    React.createElement(FilterNotice, {
      filters: [{ name: "source", value: "bogus" }]
    })
  );
  assert.match(one, /1 filter in this URL was not applied\./);
  assert.match(one, /source=&quot;bogus&quot;/);
  const two = renderToStaticMarkup(
    React.createElement(FilterNotice, {
      filters: [
        { name: "kind", value: "bogus" },
        { name: "status", value: "nope" }
      ]
    })
  );
  assert.match(two, /2 filters in this URL were not applied\./);
  assert.equal(
    renderToStaticMarkup(React.createElement(FilterNotice, { filters: [] })),
    ""
  );

  // The invariant that stops a page repeating the defect: a bounded filter the
  // page could not honour has to reach the DOM. Asserted on rendered output
  // rather than on imports, because `app/memory/page.ts` resolves the filters
  // and hands the list to `MemoryView`, which is what renders it -- a source
  // scan reading "does this file mention FilterNotice" fails that legitimate
  // split, and an unused import would satisfy it anyway.
  const toolRows = (source: string): string =>
    renderToStaticMarkup(
      React.createElement(ToolsView, {
        tools: [],
        coverage: { schema: "x", source: "y" } as never,
        validity: "valid",
        usageLink: "/usage",
        filters: { source, role: "" }
      })
    );
  assert.match(
    toolRows("bogus"),
    /1 filter in this URL was not applied\./,
    "/tools must name a source it does not accept instead of drawing the " +
      '"all" chip as if the reader had chosen it'
  );
  assert.doesNotMatch(toolRows("mcp"), /was not applied/);
  assert.doesNotMatch(toolRows(""), /was not applied/);

  const previousFetch = globalThis.fetch;
  const previousEnv = saveConsolePageEnvironment();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-filter-page-"));
  const renderMemory = async (
    searchParams: Record<string, string>
  ): Promise<string> => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/control/workspaces")) {
        return Response.json({
          schema: "autodev-control-workspaces-v1",
          source: "config/workspaces.json",
          readOnly: true,
          catalogStatus: "valid",
          totalWorkspaces: 1,
          workspaces: [
            {
              id: "SimulatorLife/AutoDev",
              baseBranch: "main",
              enabled: true,
              agentRoles: null
            }
          ]
        });
      }
      if (url.includes("/control/memory/records")) {
        return Response.json({
          schema: "autodev-memory-records-v1",
          items: [],
          total: 0,
          limit: 50,
          statusCounts: {
            proposed: 0,
            active: 0,
            superseded: 0,
            invalidated: 0,
            uncertain: 0
          },
          offset: 0,
          hasMore: false
        });
      }
      throw new Error(`Unexpected Memory page request: ${url}`);
    };
    return renderToStaticMarkup(
      await MemoryPage({ searchParams: Promise.resolve(searchParams) })
    );
  };
  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN = "filter-page-test-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";

    // Two refused filters on one URL are reported together, not one at a time.
    assert.match(
      await renderMemory({ tab: "records", kind: "bogus", status: "nope" }),
      /2 filters in this URL were not applied\.[^]*kind=&quot;bogus&quot;[^]*status=&quot;nope&quot;/
    );
    // A refused `tab` is named on whichever tab did render.
    assert.match(
      await renderMemory({ tab: "bogus" }),
      /1 filter in this URL was not applied\.[^]*tab=&quot;bogus&quot;/
    );
    // And a filter the page does accept produces no notice at all, on any tab.
    for (const params of [
      { tab: "records", kind: "procedural" },
      { tab: "cohorts", status: "invalidated" },
      { tab: "records" }
    ]) {
      assert.doesNotMatch(
        await renderMemory(params),
        /was not applied/,
        `${JSON.stringify(params)} is a filter this page accepts`
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
    restoreConsolePageEnvironment(previousEnv);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("MemoryPage asks the Runtime for the page the URL names", async () => {
  // The two halves of browsing have to agree: the views render links that carry
  // a `limit`/`offset`, and the read has to request them. Asserting on the links
  // alone would pass with a page that ignored its own query string and always
  // re-fetched the first 50 rows — which is what it used to do, because the
  // Console sent no page parameters and let the Runtime apply its default.
  const previousFetch = globalThis.fetch;
  const previousEnv = saveConsolePageEnvironment();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-memory-page-"));
  const requested: string[] = [];
  const renderPage = async (
    searchParams: Record<string, string>
  ): Promise<string> => {
    requested.length = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/control/workspaces")) {
        return Response.json({
          schema: "autodev-control-workspaces-v1",
          source: "config/workspaces.json",
          readOnly: true,
          catalogStatus: "valid",
          totalWorkspaces: 1,
          workspaces: [
            {
              id: "SimulatorLife/AutoDev",
              baseBranch: "main",
              enabled: true,
              agentRoles: null
            }
          ]
        });
      }
      if (url.includes("/control/memory/records")) {
        return Response.json({
          schema: "autodev-memory-records-v1",
          items: [],
          total: 1204,
          limit: 25,
          statusCounts: {
            proposed: 0,
            active: 0,
            superseded: 0,
            invalidated: 0,
            uncertain: 0
          },
          offset: 100,
          hasMore: true
        });
      }
      if (url.includes("/control/memory/experiences")) {
        return Response.json({
          schema: "autodev-memory-experiences-v1",
          items: [],
          total: 0,
          limit: 25,
          offset: 100,
          hasMore: false
        });
      }
      if (url.includes("/control/memory/session-cohorts")) {
        return Response.json({
          schema: "autodev-memory-session-cohorts-v1",
          cells: [],
          sessionCount: 0
        });
      }
      throw new Error(`Unexpected Memory page request: ${url}`);
    };
    return renderToStaticMarkup(
      await MemoryPage({ searchParams: Promise.resolve(searchParams) })
    );
  };

  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN = "memory-page-test-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";

    // A silent URL still asks for a page, so the first page is the Runtime's
    // default rather than an unbounded read.
    await renderPage({ tab: "records" });
    const records = requested.find((url) =>
      url.includes("/control/memory/records")
    );
    assert.ok(records);
    const firstUrl = new URL(records);
    assert.equal(firstUrl.searchParams.get("limit"), "50");
    assert.equal(firstUrl.searchParams.get("offset"), "0");

    const markup = await renderPage({
      tab: "records",
      limit: "25",
      offset: "100",
      kind: "procedural"
    });
    const paged = requested.find((url) =>
      url.includes("/control/memory/records")
    );
    assert.ok(paged);
    const pagedUrl = new URL(paged);
    assert.equal(pagedUrl.searchParams.get("limit"), "25");
    assert.equal(pagedUrl.searchParams.get("offset"), "100");
    assert.equal(pagedUrl.searchParams.get("kind"), "procedural");

    // Experiences are paged from the same URL state as records.
    await renderPage({ tab: "experiences", limit: "25", offset: "100" });
    const experiences = requested.find((url) =>
      url.includes("/control/memory/experiences")
    );
    assert.ok(experiences);
    const experiencesUrl = new URL(experiences);
    assert.equal(experiencesUrl.searchParams.get("limit"), "25");
    assert.equal(experiencesUrl.searchParams.get("offset"), "100");

    // The window the URL named reaches both list reads. It was parsed, drawn
    // on the cohorts tab, and preserved by three filter bars while records and
    // experiences ignored it -- a bounded filter the page reported as applied
    // on two of its three tabs.
    await renderPage({
      tab: "records",
      from: "2026-09-01T00:00:00.000Z",
      until: "2026-10-01T00:00:00.000Z"
    });
    for (const route of [
      "/control/memory/records",
      "/control/memory/experiences"
    ]) {
      const url = requested.find((request) => request.includes(route));
      assert.ok(url, `${route} must be read`);
      const parsed = new URL(url);
      assert.equal(
        parsed.searchParams.get("occurredFrom"),
        "2026-09-01T00:00:00.000Z",
        `${route} must apply the window's lower bound`
      );
      assert.equal(
        parsed.searchParams.get("occurredUntil"),
        "2026-10-01T00:00:00.000Z",
        `${route} must apply the window's upper bound`
      );
    }

    // A `total` larger than the page renders navigation, and the Next link is
    // the next page of the same filtered list.
    assert.match(markup, /data-pagination="memory-records-pagination"/);
    const nextAnchor = (markup.split("<a") ?? []).find((anchor) =>
      anchor.includes('rel="next"')
    );
    assert.ok(nextAnchor);
    const nextHref = nextAnchor.match(/href="([^"]+)"/u)?.[1];
    assert.ok(nextHref);
    const nextUrl = new URL(
      nextHref.replaceAll("&amp;", "&"),
      "http://console.test"
    );
    assert.equal(nextUrl.pathname, "/memory");
    assert.equal(nextUrl.searchParams.get("offset"), "125");
    assert.equal(nextUrl.searchParams.get("limit"), "25");
    assert.equal(nextUrl.searchParams.get("kind"), "procedural");

    // A page size the Runtime would reject is reported, not forwarded.
    const rejected = await renderPage({ tab: "records", limit: "9999" });
    assert.match(rejected, /1 filter in this URL was not applied\./);
    assert.match(rejected, /limit=&quot;9999&quot;/);
    const applied = requested.find((url) =>
      url.includes("/control/memory/records")
    );
    assert.ok(applied);
    assert.equal(new URL(applied).searchParams.get("limit"), "50");
  } finally {
    globalThis.fetch = previousFetch;
    restoreConsolePageEnvironment(previousEnv);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("the shell lets a keyboard user reach the page body without walking the nav", () => {
  // The sidebar is a persistent fourteen-link nav that precedes `<main>`, so
  // the same fourteen tab stops sat in front of every page. Measured in headless
  // Chromium across eight routes: fourteen before `<main>` on all of them, and on
  // the sparser pages most of the page -- `/mcps` has 22 focusable elements in
  // total and 8 inside `<main>`, `/tools/find_code` 23 and 9, `/memory` 29 and 15.
  //
  // Four things have to hold together, and each is a separate way for a skip
  // link to be useless: it must come first in the tab order rather than after the
  // nav; its target must actually receive focus, which `main` cannot do without
  // `tabIndex={-1}` -- the browser scrolls to a fragment target either way, and
  // then the next Tab resumes from the nav, the fourteen stops this exists to
  // avoid; it must be hidden until focused, since a permanently visible control is
  // a different defect; and it must reveal with a focus ring, or it is invisible
  // to the keyboard user it is for.
  const markup = renderToStaticMarkup(
    React.createElement(AppShell, { activeSection: "Tools" })
  );

  const href = /<a href="#([^"]+)"[^>]*data-skip-link/.exec(markup)?.[1];
  assert.ok(href !== undefined, `AppShell must render a skip link: ${markup}`);
  assert.ok(
    markup.includes(`<main id="${href}"`),
    `the skip link must target the main region it names (${href})`
  );
  assert.match(
    markup,
    /<main id="main-content" tabindex="-1"/,
    "the skip link's target must be focusable, or focus returns to the nav"
  );

  // First in the tab order: before the nav, not after it.
  assert.ok(
    markup.indexOf("data-skip-link") < markup.indexOf("<nav"),
    "the skip link must precede the nav so it is the first tab stop"
  );

  // Hidden until focused, then revealed, and revealed with a visible ring.
  const link = markup.slice(
    markup.indexOf('<a href="#'),
    markup.indexOf(">", markup.indexOf('<a href="#'))
  );
  assert.ok(link.includes("sr-only"), `must be visually hidden: ${link}`);
  assert.ok(
    link.includes("focus:not-sr-only"),
    `must reveal itself on focus: ${link}`
  );

  // The ring is not a class on the link: it comes from the one shared
  // `:where(a, button, …):focus-visible` rule in `globals.css`, so the thing
  // worth asserting is that the skip link is an anchor (which that rule matches)
  // and that the rule still covers anchors. Asserting a `focus:ring-*` utility
  // here would be asserting a mechanism this product does not use.
  assert.match(link, /^<a href="#/, `must be an anchor: ${link}`);
  const globals = readFileSync(
    join(import.meta.dirname, "..", "app", "globals.css"),
    "utf8"
  );
  assert.match(
    globals,
    /:where\([^)]*\ba\b[^)]*\):focus-visible\s*\{[^}]*outline:/,
    "the shared focus-visible rule must still cover anchors, or the revealed " +
      "skip link has no focus ring"
  );
});

test("a heading that shares a row with a sibling sits in a row that can wrap", () => {
  // A flex row that spaces its children apart has a minimum intrinsic width set
  // by whichever child refuses to shrink, and no amount of wrapping *inside* the
  // other child reduces it. On `/mcps` the section heading "Model Context
  // Protocol Servers" shared a non-wrapping row with a `whitespace-nowrap`
  // StatusBadge, and at 390px the heading collapsed into a 129px, three-line
  // column beside the badge: measured, not inferred. `/prompts` had the same
  // shape on "Edit Canonical Markdown Source", and `AppShell`'s header had it
  // one level up.
  //
  // The rule is that the *row* wraps, not that the heading is made flexible --
  // a heading squeezed beside a sibling reads as a rendering fault, and there is
  // no title to recover it from the way a truncated value has one.
  const roots = ["app", "src"].map((root) =>
    join(import.meta.dirname, "..", root)
  );
  const offenders: string[] = [];

  for (const root of roots) {
    for (const relative of readdirSync(root, { recursive: true })) {
      const file = join(root, relative.toString());
      if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/"([^"]*\bflex\b[^"]*)"/gu)) {
        if (!headingRowWithoutWrap(source, m)) continue;
        offenders.push(
          `${relative.toString()}:${source.slice(0, m.index).split("\n").length}  "${m[1]}"`
        );
      }
    }
  }
  // A rule, not a measurement: it matches nothing today and is expected to
  // match nothing. What it must not do is miss a regression, so it is
  // mutation-tested rather than asserting a count.
  assert.deepEqual(
    offenders,
    [],
    `These rows space a heading against a sibling but cannot wrap, so the ` +
      `heading absorbs the squeeze instead. Add flex-wrap to the row:\n${offenders.join("\n")}`
  );
});

/**
 * Whether a `flex` class string is a row that spaces its children apart, holds
 * a heading, and cannot wrap.
 *
 * The heading is part of the test rather than the rule because a row of two
 * equal chips has nothing to starve.
 */
function headingRowWithoutWrap(
  source: string,
  match: RegExpMatchArray
): boolean {
  const classList = match[1] ?? "";
  if (!/\bjustify-(?:between|end)\b/u.test(classList)) return false;
  if (!/\bitems-center\b/u.test(classList)) return false;
  if (/\bflex-(?:wrap|col|reverse)\b/u.test(classList)) return false;
  const after = source.slice(match.index ?? 0, (match.index ?? 0) + 900);
  return /createElement\(\s*"h[1-6]"/u.test(after);
}

test("a disabled control states why it is disabled", () => {
  // The target state requires an unobserved or immutable control to stay in
  // place, disabled, "with the reason available". Measured across all 20 routes,
  // four controls were disabled and all four said nothing: the `/usage`
  // dimension filters. Their visible label already read "Not observed", so each
  // site looked finished -- the reason has to be a separate thing to be visible
  // as a separate thing.
  //
  // Two channels, because there are two audiences: `title` for a pointer and an
  // `aria-describedby` pointing at visually hidden text for a screen reader.
  // `aria-label` is not usable here -- it would replace the visible
  // "Workspace:" label rather than add to it.
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: undefined,
      filterOptions: {
        workspace: null,
        provider: null,
        model: null,
        agent: null,
        skill: null
      },
      selection: { range: "24H", values: {} }
    })
  );
  // `disabled` must be followed by whitespace, `=`, `>` or `/`: the control's
  // class list carries `disabled:cursor-not-allowed`, and a bare
  // `[^>]*\sdisabled` matches that Tailwind variant on a control that is very
  // much enabled.
  const disabled = Array.from(
    markup.matchAll(/<select\b[^>]*\sdisabled(?=[\s=/>])[^>]*>/gu),
    (match) => match[0]
  );
  assert.ok(
    disabled.length >= 4,
    `expected the four unobserved dimension filters, got ${disabled.length} in: ${markup}`
  );
  for (const tag of disabled) {
    assert.match(
      tag,
      /title="[^"]{10,}"/,
      `a disabled select must carry its reason on a title, got: ${tag}`
    );
    const id = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
    assert.ok(
      id !== undefined && markup.includes(`id="${id}"`),
      `a disabled select must reference a description that exists, got: ${tag}`
    );
  }
  // And the description is real text, not an empty element the reference points
  // at -- which would satisfy the attribute check while saying nothing.
  assert.match(
    markup,
    /<span id="select-workspace-unobserved-reason" class="sr-only">[^<]{20,}<\/span>/u
  );

  // A live control must not claim to be disabled, so the description is not
  // rendered for it at all.
  const observed = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: undefined,
      filterOptions: {
        workspace: ["AutoDev"],
        provider: ["antigravity"],
        model: ["gemini-3.8-flash-high"],
        agent: ["orchestrator"],
        skill: null
      },
      selection: { range: "24H", values: {} }
    })
  );
  assert.doesNotMatch(observed, /-reason"\s+class="sr-only"/);
  assert.doesNotMatch(observed, /aria-describedby="select-workspace-reason"/);
});

test("the Tools summary row counts one collection once, not twice", () => {
  // The row held two authorities for the same question. "Composite catalog"
  // read the envelope's `totalTools`; "Native / MCP / Plugin entries" counted
  // the entries that actually arrived. A payload with two tools under a
  // `totalTools` of 1 rendered a composite of 1 above 0 + 2 + 0, and the same
  // split put "1" in the sidebar badge next to "Showing 2 of 2 tool entries".
  //
  // One collection, one count: every card in the row is counted from the same
  // entries, so the four can never contradict each other.
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "complete",
      validity: "valid",
      usageLink: "/usage",
      filters: { source: "", role: "" },
      tools: [
        {
          name: "mcp__github__create_issue",
          source: "mcp",
          sourceAuthority: "rulesync-mcp",
          server: "github",
          exposedRoles: ["orchestrator"],
          availability: "configured"
        },
        {
          name: "mcp__future__unconfigured",
          source: "mcp",
          sourceAuthority: "rulesync-mcp",
          server: "future",
          exposedRoles: [],
          availability: "not-observed"
        },
        {
          name: "apply_patch",
          source: "native",
          sourceAuthority: "codex-native",
          exposedRoles: ["orchestrator"],
          availability: "configured"
        }
      ]
    })
  );

  // Composite must be the sum of the three source counts: 1 + 2 = 3.
  assert.match(
    markup,
    /Composite catalog<\/span>[\s\S]*?>3</,
    "the composite total must equal the sum of the source counts"
  );
  assert.match(markup, /MCP entries<\/span>[\s\S]*?>2</);
  assert.match(markup, /Native entries<\/span>[\s\S]*?>1</);
  assert.match(markup, /Plugin entries<\/span>[\s\S]*?>0</);

  // An empty catalog is an observed zero, not an absence.
  const empty = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "complete",
      validity: "valid",
      usageLink: "/usage",
      filters: { source: "", role: "" },
      tools: []
    })
  );
  assert.match(empty, /Composite catalog<\/span>[\s\S]*?>0</);
});

test("an unobserved stat reads as an absence, not as a large measurement", () => {
  // Rendering "Not observed" in the value slot at `text-2xl` bold broke two
  // things at once. It is two words where a number is three or four glyphs, so
  // it wrapped inside a 200px card and dropped the value below its siblings'
  // baseline; and the callers that pass both a value and a subtitle said the
  // same thing twice, so the row read "Not observed" over "Not observed".
  const repeated = renderToStaticMarkup(
    React.createElement(StatCard, {
      title: "Cohort sessions",
      value: NOT_OBSERVED_LABEL,
      subtitle: NOT_OBSERVED_LABEL
    })
  );
  assert.equal(
    repeated.split(NOT_OBSERVED_LABEL).length - 1,
    1,
    "the unobserved label must not be printed twice"
  );
  assert.match(repeated, /data-stat-unobserved="true"/);
  assert.doesNotMatch(
    repeated,
    /text-2xl/,
    "an absent measurement must not wear a measurement's type scale"
  );

  // A subtitle that says something the label does not is real information and
  // stays.
  const explained = renderToStaticMarkup(
    React.createElement(StatCard, {
      title: "Ready agents",
      value: NOT_OBSERVED_LABEL,
      subtitle: "No runtime health probe"
    })
  );
  assert.match(explained, /No runtime health probe/);

  // A measured zero is a measurement. It keeps the value scale, and it keeps
  // its own subtitle -- the whole point of the "never synthesize" rule is that
  // zero and unobserved stay two different things.
  const zero = renderToStaticMarkup(
    React.createElement(StatCard, {
      title: "Durable records",
      value: 0,
      subtitle: "0 in scope"
    })
  );
  assert.match(zero, /text-2xl/);
  assert.match(zero, /0 in scope/);
  assert.doesNotMatch(zero, /data-stat-unobserved/);

  // A value built from two measurements is the case `value === LABEL` misses:
  // `/usage` composes input and output tokens, and with neither reported the
  // card said "Not observed / Not observed" at the value scale -- the row's one
  // confident measurement, beside three correctly quiet ones.
  const compositeUnobserved = renderToStaticMarkup(
    React.createElement(StatCard, {
      title: "Input / Output Tokens",
      value: `${NOT_OBSERVED_LABEL} / ${NOT_OBSERVED_LABEL}`,
      subtitle: "Physical attempt totals"
    })
  );
  assert.match(compositeUnobserved, /data-stat-unobserved="true"/);
  assert.doesNotMatch(
    compositeUnobserved,
    /text-2xl/,
    "a value whose every part is unobserved must not wear a measurement's scale"
  );

  // Half-observed is still observed: one part is a measured 0, so the card
  // carries a real number and keeps the value scale. Understating that would be
  // the same error in the other direction.
  const compositeHalf = renderToStaticMarkup(
    React.createElement(StatCard, {
      title: "Input / Output Tokens",
      value: `${NOT_OBSERVED_LABEL} / 0`
    })
  );
  assert.match(compositeHalf, /text-2xl/);
  assert.doesNotMatch(compositeHalf, /data-stat-unobserved/);
});

test("AppNav renders Configure/Observe/Operate groups with canonical membership, order, and URL links", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AppNav, {
      activeSection: "Agents",
      counts: { Agents: 8, MCPs: 5 }
    })
  );

  // The three canonical groups must each appear with the expected heading
  // and an aria-labelledby binding for accessibility.
  for (const groupId of ["Configure", "Observe", "Operate"] as const) {
    const headingId = `autodev-nav-group-${groupId.toLowerCase()}`;
    assert.ok(
      markup.includes(`id="${headingId}"`),
      `AppNav must render the heading for ${groupId}`
    );
    assert.ok(
      markup.includes(`aria-labelledby="${headingId}"`),
      `AppNav must bind the ${groupId} section to its heading`
    );
    assert.ok(
      markup.includes(`data-nav-group="${groupId}"`),
      `AppNav must expose data-nav-group="${groupId}"`
    );
    const visibleLabel = new RegExp(`>${groupId}<`);
    assert.ok(
      visibleLabel.test(markup),
      `AppNav must render the visible label "${groupId}"`
    );
  }

  // Each group must list its sections in canonical order, and groups must
  // appear Configure → Observe → Operate.
  const expectedOrder: readonly (typeof CANONICAL_NAV_GROUPS)[number][] = [
    ...CANONICAL_NAV_GROUPS
  ];
  const groupIndexes = expectedOrder.map((group) =>
    markup.indexOf(`data-nav-group="${group.id}"`)
  );
  for (const [i, idx] of groupIndexes.entries()) {
    assert.ok(idx !== -1, `Group ${expectedOrder[i]?.id} must render`);
    if (i > 0) {
      assert.ok(
        (idx ?? -1) > (groupIndexes[i - 1] ?? -1),
        `Group order must be Configure → Observe → Operate`
      );
    }
  }

  let lastIndex = -1;
  for (const group of CANONICAL_NAV_GROUPS) {
    const groupStart = markup.indexOf(`data-nav-group="${group.id}"`);
    let groupEnd = markup.length;
    for (const other of CANONICAL_NAV_GROUPS) {
      if (other.id === group.id) continue;
      const candidate = markup.indexOf(`data-nav-group="${other.id}"`);
      if (candidate !== -1 && candidate > groupStart && candidate < groupEnd) {
        groupEnd = candidate;
      }
    }
    for (const section of group.sections) {
      const idx = markup.indexOf(`data-nav-item="${section.toLowerCase()}"`);
      assert.ok(idx !== -1, `${section} must be present in AppNav`);
      assert.ok(idx > lastIndex, `${section} must appear in canonical order`);
      assert.ok(
        idx >= groupStart && idx < groupEnd,
        `${section} must be rendered inside the ${group.id} group`
      );
      lastIndex = idx;
    }
  }

  // AppNav must render the canonical sections through real <a href="/...">
  // links rather than buttons that mutate local section state.
  for (const section of CANONICAL_NAVIGATION) {
    const href = `href="/${section.toLowerCase()}"`;
    assert.ok(
      markup.includes(href),
      `AppNav must expose a URL link for ${section} (${href})`
    );
  }
  assert.equal(markup.includes("<button"), false);
  assert.equal(markup.includes("Projects"), false);
  assert.equal(markup.includes("Organizations"), false);
  assert.equal(markup.includes("Environments"), false);
  assert.equal(markup.includes("Rule Engine"), false);
  assert.equal(markup.includes("OpenGround"), false);
});

/**
 * The Console's keyboard-focus contract is a single global rule rather than a
 * per-component class: `:where(a, button, ...):focus-visible` draws an accent
 * outline at zero specificity, so a component may omit the utility without
 * losing the indicator. Tests assert the rule exists instead of demanding every
 * anchor re-declare it.
 */
function globalFocusRingIsDeclared(): boolean {
  const css = readFileSync(
    join(import.meta.dirname, "..", "app", "globals.css"),
    "utf8"
  );
  return /:where\([^)]*\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-accent\)/u.test(
    css
  );
}

test("AppNav brand link has visible keyboard focus and no unsupported status pulse", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AppNav, {
      activeSection: "Agents"
    })
  );

  const brandStart = markup.indexOf('data-nav-brand="autodev"');
  assert.ok(brandStart !== -1, "AppNav must render the brand link");
  const brandTagStart = markup.lastIndexOf("<a", brandStart);
  const brandTagEnd = markup.indexOf(">", brandStart);
  const brandTag = markup.slice(brandTagStart, brandTagEnd + 1);

  // The brand link must not silently remove the keyboard focus indicator
  // without providing a replacement; a visible focus-visible style must be
  // present instead.
  assert.equal(
    brandTag.includes("focus:outline-none"),
    false,
    "AppNav brand link must not remove focus outline without a visible replacement"
  );
  assert.ok(
    globalFocusRingIsDeclared(),
    "the shared :focus-visible outline rule must exist for keyboard focus"
  );
  // A component may still opt into its own visible ring; if it does, that ring
  // must be visible rather than `outline-none`.
  if (brandTag.includes("focus-visible:outline")) {
    assert.doesNotMatch(brandTag, /focus-visible:outline-none/u);
  }

  // The brand must not render a pulsing/health-status indicator beside it;
  // there is no runtime health evidence backing such a dot.
  const brandEnd = markup.indexOf("</a>", brandStart);
  const brandMarkup = markup.slice(brandTagStart, brandEnd);
  assert.doesNotMatch(
    brandMarkup,
    /\b(?:animate-pulse|bg-emerald-500)\b/u,
    "AppNav brand must not render an unsupported pulsing health-status dot"
  );
});

test("Breadcrumbs renders a server-renderable landmark with native ancestor links and aria-current on the current page", () => {
  const markup = renderToStaticMarkup(
    React.createElement(Breadcrumbs, {
      items: [{ label: "MCPs", href: "/mcps" }, { label: "playwright" }]
    })
  );

  // Landmarks: a single <nav aria-label="Breadcrumb"> with an ordered list.
  assert.match(markup, /<nav aria-label="Breadcrumb"/);
  const navStart = markup.indexOf('<nav aria-label="Breadcrumb"');
  const navEnd = markup.indexOf("</nav>", navStart);
  assert.ok(navStart !== -1 && navEnd !== -1);
  const navMarkup = markup.slice(navStart, navEnd + "</nav>".length);
  assert.match(navMarkup, /<ol/);
  assert.match(navMarkup, /<\/ol>/);

  // Ancestor item: a real <a href="/mcps"> anchor (no client-side router).
  assert.match(navMarkup, /<a href="\/mcps"[^>]*>MCPs<\/a>/);
  // Ancestor link must expose a visible keyboard focus state, either through the
  // shared rule or an explicit one it carries itself.
  assert.ok(
    globalFocusRingIsDeclared(),
    "the shared :focus-visible outline rule must exist for keyboard focus"
  );
  const ancestorTag = navMarkup.match(/<a href="\/mcps"[^>]*>/u)?.[0] ?? "";
  assert.doesNotMatch(ancestorTag, /focus-visible:outline-none/u);

  // Current-page item: a non-link <span aria-current="page"> with the
  // final item's label, and no href attribute.
  assert.match(
    navMarkup,
    /<span[^>]*aria-current="page"[^>]*>playwright<\/span>/
  );
  assert.equal(navMarkup.includes("playwright</a>"), false);

  // The trail is ordered: ancestor appears before the current-page item,
  // separated by a hidden "/" separator span.
  const ancestorIdx = navMarkup.indexOf('href="/mcps"');
  const currentIdx = navMarkup.indexOf('aria-current="page"');
  assert.ok(ancestorIdx !== -1 && currentIdx !== -1);
  assert.ok(
    ancestorIdx < currentIdx,
    "Breadcrumbs must place the ancestor before the current page"
  );
  assert.match(navMarkup, /aria-hidden="true"[^>]*>\/</);

  // No synthetic Home entry is added and no placeholder href="#" is ever
  // emitted by the component, even for ancestor items.
  assert.equal(navMarkup.includes("Home"), false);
  assert.equal(navMarkup.includes('href="#"'), false);
});

test('Breadcrumbs renders ancestor items without an href as non-link elements and never emits href="#"', () => {
  const markup = renderToStaticMarkup(
    React.createElement(Breadcrumbs, {
      items: [
        { label: "Workspace hub" },
        { label: "MCPs", href: "/mcps" },
        { label: "Unlinked group", href: "" },
        { label: "playwright" }
      ]
    })
  );

  const navStart = markup.indexOf('<nav aria-label="Breadcrumb"');
  const navEnd = markup.indexOf("</nav>", navStart);
  assert.ok(navStart !== -1 && navEnd !== -1);
  const navMarkup = markup.slice(navStart, navEnd + "</nav>".length);

  // The href-less ancestor renders as a plain span (no anchor wrapping it,
  // no aria-current, no placeholder href). Containment rather than a shape
  // regex: the span also carries `title` for the truncated full label, and an
  // optional group nested inside another quantifier is a pattern lint is right
  // to refuse.
  assert.ok(
    navMarkup.includes(
      'class="min-w-0 truncate rounded-sm text-fg font-medium" title="Workspace hub">Workspace hub</span>'
    ),
    `href-less ancestor should be a truncating plain span, got: ${navMarkup}`
  );
  assert.equal(navMarkup.includes("Workspace hub</a>"), false);
  assert.doesNotMatch(navMarkup, /<span[^>]*Workspace hub[^>]*aria-current/);
  assert.ok(
    navMarkup.includes('title="Unlinked group">Unlinked group</span>'),
    `empty-href ancestor should be a plain span, got: ${navMarkup}`
  );
  assert.equal(navMarkup.includes("Unlinked group</a>"), false);
  assert.equal(navMarkup.includes('href=""'), false);

  // The middle ancestor still renders as a native <a href> link.
  assert.match(navMarkup, /<a href="\/mcps"[^>]*>MCPs<\/a>/);

  // Only the final item carries aria-current="page".
  const currentMatches = navMarkup.match(/aria-current="page"/g) ?? [];
  assert.equal(currentMatches.length, 1);
  assert.match(
    navMarkup,
    /<span[^>]*aria-current="page"[^>]*>playwright<\/span>/
  );

  // Never emit a placeholder href="#" anywhere in the breadcrumb landmark.
  assert.equal(navMarkup.includes('href="#"'), false);
});

test("Breadcrumbs exposes a custom aria-label override for the landmark", () => {
  const markup = renderToStaticMarkup(
    React.createElement(Breadcrumbs, {
      ariaLabel: "MCP detail navigation",
      items: [{ label: "MCPs", href: "/mcps" }, { label: "playwright" }]
    })
  );
  assert.match(markup, /<nav aria-label="MCP detail navigation"/);
});

test("Breadcrumbs renders a single ancestor link with current-page aria state when only one parent is supplied", () => {
  const markup = renderToStaticMarkup(
    React.createElement(Breadcrumbs, {
      items: [{ label: "Prompts", href: "/prompts" }, { label: "dry" }]
    })
  );
  assert.match(markup, /<a href="\/prompts"[^>]*>Prompts<\/a>/);
  assert.match(markup, /<span[^>]*aria-current="page"[^>]*>dry<\/span>/);
  // Only one separator between the two items.
  const separatorMatches = markup.match(/aria-hidden="true"/g) ?? [];
  assert.equal(separatorMatches.length, 1);
});

test("the shrink chain holds: a long unbreakable identifier cannot widen its container", () => {
  // Every Console identifier the operator reads is a canonical name, not
  // prose: an agent role, a skill, an MCP server, a model id. Those can be one
  // token with nowhere legal to break, so on a phone-width panel they are the
  // one input guaranteed to overflow if the layout is wrong.
  //
  // The mechanism is easy to get wrong and invisible in review. A flex item's
  // automatic minimum size is its *min-content* width, and `break-words` does
  // not lower it -- `overflow-wrap: break-word` only breaks a token after the
  // box has already been narrowed below it, and narrowing requires `min-w-0`.
  // So `min-w-0` is required at every level between the container and the text,
  // and the assertion below names each of those levels: remove one and the
  // whole chain stops shrinking, no matter how many others remain.
  const UNBREAKABLE = "a".repeat(90);

  // The drawer header: header row, identity column, title row, then the title.
  const drawer = renderToStaticMarkup(
    React.createElement(DetailDrawer, {
      title: UNBREAKABLE,
      subtitle: "solver",
      closeHref: "/agents"
    })
  );
  for (const [what, className] of [
    ["drawer header row", DETAIL_DRAWER_HEADER_CLASS],
    ["drawer title row", DETAIL_DRAWER_TITLE_ROW_CLASS],
    ["entity title", ENTITY_TITLE_CLASS]
  ] as const) {
    assert.ok(
      className.includes("min-w-0"),
      `${what} must carry min-w-0 to shrink inside the panel, got: ${className}`
    );
  }
  // Both shared class constants have to reach the rendered header, or the
  // guard above would pass on a constant nothing uses.
  assert.ok(
    drawer.includes(DETAIL_DRAWER_HEADER_CLASS),
    `drawer must render the shared header class, got: ${drawer}`
  );
  assert.ok(
    drawer.includes(ENTITY_TITLE_CLASS),
    `drawer title must render the shared entity title class, got: ${drawer}`
  );

  // The chip list: the chip's `max-w-full` resolves against its `li`, so the
  // `li` needs a cap of its own. Without it the `li` sizes to content, the
  // chip is handed a container that was never narrower than itself, and
  // `truncate` silently does nothing.
  const chips = renderToStaticMarkup(
    chipList({ items: [UNBREAKABLE], emptyLabel: "None" })
  );
  assert.match(
    chips,
    /<li class="flex min-w-0 max-w-full items-center">/,
    `chip list item must be capped so the chip has a width to truncate to, got: ${chips}`
  );

  // The breadcrumb trail: same rule, and `title` keeps the full label
  // reachable once the visible one is ellipsized.
  const trail = renderToStaticMarkup(
    React.createElement(Breadcrumbs, {
      items: [{ label: UNBREAKABLE, href: "/agents" }]
    })
  );
  assert.match(
    trail,
    /class="min-w-0 max-w-full text-xs"/,
    `breadcrumb nav must be bounded by its container, got: ${trail}`
  );
  assert.ok(
    trail.includes(`title="${UNBREAKABLE}"`),
    `an ellipsized breadcrumb must keep the full label reachable, got: ${trail}`
  );
});

test("a truncating chip keeps its full text reachable instead of only its ellipsis", () => {
  // Truncation removes information. The operator sees an ellipsis and, if
  // nothing else carries the value, cannot recover the identifier at all --
  // so a chip that truncates has to keep the whole string reachable. The
  // default chip list is the case that mattered: it renders the item as the
  // chip's own text and passed no `label`, so the chip truncated and offered
  // no way to read what it had cut off.
  const name = "s".repeat(70);

  const chips = renderToStaticMarkup(
    chipList({ items: [name], emptyLabel: "" })
  );
  assert.match(chips, /truncate/, `chip must truncate a long identifier`);
  assert.ok(
    chips.includes(`title="${name}"`),
    `a truncating chip must title itself with the full text, got: ${chips}`
  );

  // A link chip titles itself too, but must not replace its own accessible
  // name with a redundant `aria-label` when the caller gave none.
  const link = renderToStaticMarkup(
    React.createElement(Chip, { href: "/skills/x" }, name)
  );
  assert.ok(
    link.includes(`title="${name}"`),
    `a truncating chip link must keep the full text reachable, got: ${link}`
  );
  assert.doesNotMatch(
    link,
    /aria-label/,
    `a link whose text is already the label must not have its name replaced`
  );

  // Non-string content has no single text to offer, and a wrong `title` is
  // worse than none.
  const structured = renderToStaticMarkup(
    React.createElement(Chip, null, React.createElement("span", null, "a"))
  );
  assert.doesNotMatch(structured, /title=/);
});

test("a path wraps between its segments and never inside one", () => {
  // Measured at 1440 against the live RuleSync catalog, `/prompts`'s Canonical
  // Source was cut on 70 of 70 rows: the constant `.rulesync/commands/` prefix
  // consumed 18 of the 38 characters while the part that differs between rows
  // was the part that disappeared. Truncation was the wrong tool, and so was
  // `break-words` — a path has no spaces, so it is one token to the line breaker
  // and gets split at an arbitrary character, which the contract forbids for
  // discrete content.
  const markup = renderToStaticMarkup(
    React.createElement(PathText, {
      path: ".rulesync/commands/advance-autodev.md"
    })
  );

  // Every separator is a legal break opportunity. React renders the void
  // element as `<wbr/>`, so the pattern has to accept the self-closing form --
  // matching `/<wbr>/` finds zero and reports a working component as broken.
  assert.equal((markup.match(/<wbr\s*\/?>/gu) ?? []).length, 2);
  // ...and the text is still exactly the path, with nothing added or removed.
  assert.ok(markup.includes(".rulesync/commands/advance-autodev.md"));
  // Strip the markup and compare what the reader actually gets. This is the
  // assertion that matters: the component's first version pushed each array
  // index alongside its string, and React rendered those numbers as text, so
  // the column read `.rulesync0/1commands1/2advance-autodev.md2` — a corrupt
  // identifier on the one column whose whole job is to be exact.
  assert.equal(
    markup.replaceAll(/<[^>]*>/gu, ""),
    ".rulesync/commands/advance-autodev.md"
  );
  // A truncating cell is only as good as what it can give back; the path is the
  // hover text, so the full value is always recoverable.
  assert.ok(markup.includes('title=".rulesync/commands/advance-autodev.md"'));

  // A rooted path breaks after its leading separator, which is a segment
  // boundary like any other, and keeps its text exactly.
  const rooted = renderToStaticMarkup(
    React.createElement(PathText, { path: "/composition-over-inheritance" })
  );
  assert.equal((rooted.match(/<wbr\s*\/?>/gu) ?? []).length, 1);
  assert.equal(
    rooted.replaceAll(/<[^>]*>/gu, ""),
    "/composition-over-inheritance"
  );
  // A value with no separator at all has no legal break point, so it must not
  // acquire one.
  const bare = renderToStaticMarkup(
    React.createElement(PathText, { path: "composition-over-inheritance" })
  );
  assert.equal((bare.match(/<wbr\s*\/?>/gu) ?? []).length, 0);
  assert.equal(
    bare.replaceAll(/<[^>]*>/gu, ""),
    "composition-over-inheritance"
  );

  // Asserted on rendered markup rather than by scanning source: a column can
  // declare `align: "path"` and still render a truncating span, and a source
  // grep would call that a pass.
  const workspaces = renderToStaticMarkup(
    React.createElement(WorkspacesView, {
      workspaces: [
        {
          id: "SimulatorLife/Colourful-Life",
          baseBranch: "main",
          enabled: true,
          agentRoles: null
        }
      ]
    })
  );
  assert.ok(
    workspaces.includes("SimulatorLife/<wbr/>Colourful-Life"),
    `workspaces should break after the separator, got: ${workspaces}`
  );
  // And the cell must not still be a truncating one.
  assert.ok(
    !/title="SimulatorLife\/Colourful-Life"[^>]*class="[^"]*\btruncate\b/u.test(
      workspaces
    ),
    "the repository cell should not truncate"
  );
});

test("StatusBadge renders valid variants", () => {
  // The word is asserted, not just the variant. `data-status` was the only thing
  // this checked, which is why two spellings of `not-observed` were both live:
  // the badge derived its label from the variant key, so `not-observed` came out
  // hyphenated wherever a caller did not happen to pass `NOT_OBSERVED_LABEL`.
  const WORDS: Record<string, string> = {
    configured: "Configured",
    valid: "Valid",
    invalid: "Invalid",
    ready: "Ready",
    unavailable: "Unavailable",
    converged: "Converged",
    pending: "Pending",
    error: "Error",
    "not-observed": NOT_OBSERVED_LABEL
  };
  for (const status of [
    "configured",
    "valid",
    "invalid",
    "ready",
    "unavailable",
    "converged",
    "pending",
    "error",
    "not-observed"
  ] as const) {
    const markup = renderToStaticMarkup(
      React.createElement(StatusBadge, { status })
    );
    assert.ok(markup.includes(`data-status="${status}"`));
    assert.ok(
      markup.includes(`>${WORDS[status]}<`),
      `${status} should read "${WORDS[status]}", got: ${markup}`
    );
  }
});

test("a status word is never spelled from its own variant key", () => {
  // `charAt(0).toUpperCase() + slice(1)` is a default that looks safe and is
  // not: it passes through whatever punctuation the key happens to use. The one
  // hyphenated variant therefore rendered "Not-observed", which is a different
  // word from the product's "Not observed" and appeared on `/agents` beside
  // badges reading the canonical spelling.
  const markup = renderToStaticMarkup(
    React.createElement(StatusBadge, { status: "not-observed" })
  );
  assert.ok(!markup.includes("Not-observed"));
  assert.ok(markup.includes(NOT_OBSERVED_LABEL));

  // A caller's explicit label still wins; the table is a default, not a lock.
  const overridden = renderToStaticMarkup(
    React.createElement(StatusBadge, { status: "ready", label: "Assigned" })
  );
  assert.ok(overridden.includes(">Assigned<"));
});

test("ConvergenceBadge names a verdict in the shared vocabulary", () => {
  // It used to hand the raw wire key to the badge as its label, so a converged
  // resource read "converged" in lowercase on `/providers/[id]/models/[model]`
  // while every other badge on the Console read "Converged".
  for (const [convergence, word] of [
    ["converged", "Converged"],
    ["pending", "Pending"],
    ["error", "Error"],
    ["not-observed", NOT_OBSERVED_LABEL]
  ] as const) {
    const markup = renderToStaticMarkup(
      React.createElement(ConvergenceBadge, {
        convergence,
        explanation: "Observed by the Runtime.",
        desiredGeneration: null,
        observedGeneration: null,
        lastError: null
      })
    );
    assert.ok(
      markup.includes(`>${word}<`),
      `${convergence} should read "${word}", got: ${markup}`
    );
  }
});

test("StatusBadge gives back a status word it has to cut", () => {
  // The badge is an `inline-flex` box, and `text-overflow` does not apply to a
  // flex container -- so a `truncate` written on the badge is inert and the word
  // is cut with no ellipsis and nothing on hover. Measured in headless Chromium
  // at 1280, `/skills` drew "Configured" with its right border and last glyph
  // gone on all fourteen rows, `/agents` and `/prompts` cut theirs by 9px and
  // 11px, and `/providers` cut a 284px environment variable name inside a 143px
  // cell. Three of those four carried no title at all.
  //
  // It was not fixed at the call sites' `weight`, and the comments on two of
  // those columns recorded a previous attempt at exactly that: a weight is a
  // share of a table whose width is whatever the container gives it, while the
  // badge's pixel width is fixed, so one number cannot serve every viewport.
  // The columns were widened against the table's 864px floor as well; this is
  // what makes the residual recoverable.
  const cut = renderToStaticMarkup(
    React.createElement(StatusBadge, {
      status: "configured",
      label: "Role prompt"
    })
  );
  assert.ok(
    cut.includes('title="Role prompt"'),
    `a badge that can be cut must give its label back on hover, got: ${cut}`
  );
  // On the label, not on the badge, and with `min-w-0` beside it: a flex item's
  // automatic minimum size is its min-content, and `white-space: nowrap` makes
  // that the whole word, so without it the item never shrinks and the ellipsis
  // never appears.
  assert.match(
    cut,
    /<span class="min-w-0 truncate">Role prompt<\/span>/,
    `the ellipsis must live on the label span, got: ${cut}`
  );

  // An explicit title is an explanation longer than the word and still wins.
  const explained = renderToStaticMarkup(
    React.createElement(StatusBadge, {
      status: "invalid",
      label: "Missing CODEX_ROUTER_COPILOT_API_KEY",
      title: "Set CODEX_ROUTER_COPILOT_API_KEY in the environment"
    })
  );
  assert.ok(
    explained.includes(
      'title="Set CODEX_ROUTER_COPILOT_API_KEY in the environment"'
    ),
    `a caller's own explanation must not be replaced by the bare label, got: ${explained}`
  );

  // The label still is the label: the status word is not consumed by the title.
  assert.match(explained, />Missing CODEX_ROUTER_COPILOT_API_KEY</);
});

test("AgentsView keeps readiness and convergence unknown without observations", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentsView, { agents: [CONFIGURED_AGENT] })
  );

  assert.equal(markup.includes("Runtime healthy"), false);
  assert.equal(markup.includes("Desired vs actual in sync"), false);
  assert.match(markup, /data-status="not-observed"/);
  assert.equal(markup.includes(">Not observed<"), true);
  assert.match(markup, /href="\/agents\/orchestrator"/);
});

test("Agent detail separates configuration from unobserved runtime state", () => {
  // Rendered with 70-character unbreakable skill and MCP identifiers rather
  // than the tidy fixture. A detail page whose real inputs are canonical
  // names -- not prose -- has to survive the name being longer than the panel,
  // and this is the one view where that combination is guaranteed: the title,
  // the breadcrumb trail and both name lists all render from the same agent.
  //
  // Spread the fixture rather than re-listing it: hand-rolling a second
  // `AgentDefinition` drifts from the type the moment a field is added, and
  // the drift surfaces as an undefined read deep in a child component rather
  // than as a type error here.
  const longName = (type: "skill" | "mcp", name: string) =>
    type === "skill" ? { type, name } : { type, name, server: name };
  const markup = renderToStaticMarkup(
    React.createElement(AgentDetailView, {
      agent: {
        ...CONFIGURED_AGENT,
        tools: [
          longName("skill", "s".repeat(70)),
          longName("mcp", "m".repeat(70))
        ]
      }
    })
  );

  assert.match(markup, /data-feature="agent-detail"/);
  assert.match(markup, /orchestrator/);
  assert.match(markup, /data-status="not-observed"/);
  assert.equal(markup.includes("Runtime healthy"), false);
  assert.equal(markup.includes("Converged"), false);

  // The name lists are the shared chip list, so the hand-typed copy that
  // carried its own geometry -- and with it neither `truncate` nor a cap the
  // chip could truncate against -- must not come back.
  assert.match(markup, /data-chips="agent-names"/);
  assert.doesNotMatch(
    markup,
    /rounded border border-border-strong bg-surface-raised px-2 py-1 font-mono/
  );
});

test("Agent detail exposes the shared breadcrumbs landmark with /agents parent and current-page aria state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentDetailView, { agent: CONFIGURED_AGENT })
  );

  // Server-rendered breadcrumbs landmark: single <nav aria-label="Breadcrumb">
  // containing the ordered <ol> with the canonical /agents ancestor and the
  // current-page role (agent.role = "orchestrator").
  assert.match(markup, /<nav aria-label="Breadcrumb"/);
  const breadcrumbNavStart = markup.indexOf('<nav aria-label="Breadcrumb"');
  const breadcrumbNavEnd = markup.indexOf("</nav>", breadcrumbNavStart);
  assert.ok(breadcrumbNavStart !== -1 && breadcrumbNavEnd !== -1);
  const breadcrumbMarkup = markup.slice(
    breadcrumbNavStart,
    breadcrumbNavEnd + "</nav>".length
  );
  assert.match(breadcrumbMarkup, /<a href="\/agents"[^>]*>Agents<\/a>/);
  assert.match(
    breadcrumbMarkup,
    /<span[^>]*aria-current="page"[^>]*>orchestrator<\/span>/
  );
  // No synthetic Home entry added.
  assert.equal(breadcrumbMarkup.includes("Home"), false);
});

test("Prompt list links to source detail instead of synthesizing a preview", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: [
        {
          name: "dry",
          path: ".rulesync/commands/dry.md",
          description: "Dry-run command"
        }
      ],
      validationIssues: [],
      commandSourceValidity: true
    })
  );

  assert.match(markup, /href="\/prompts\/dry"/);
  assert.equal(markup.includes("Prompt Preview"), false);
  assert.equal(markup.includes("Lossless round-trip"), false);
});

test("PromptsView distinguishes an unavailable command source from a valid empty source", () => {
  const commands = [
    {
      name: "orchestrator",
      path: "agents/prompts/roles/orchestrator.md",
      kind: "role" as const
    }
  ];
  const invalid = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands,
      validationIssues: [],
      commandSourceValidity: false
    })
  );
  assert.match(invalid, /data-prompt-command-source="false"/);
  assert.match(invalid, /RuleSync `.rulesync\/commands\/` is invalid/);
  assert.match(invalid, /Agent Role Prompts/);
  assert.doesNotMatch(invalid, /RuleSync Commands[\s\S]*?>0</);

  const missing = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: [],
      validationIssues: [],
      commandSourceValidity: null
    })
  );
  assert.match(missing, /data-prompt-command-source="not-observed"/);
  assert.match(missing, /RuleSync `.rulesync\/commands\/` was not observed/);
  assert.match(missing, /Not observed/);
});

/** Shared "nothing observed yet" reconciliation fixture for detail renders. */
const unobservedPromptReconciliation: ControlApiPromptDetailResponse["reconciliation"] =
  {
    status: {
      convergence: "not-observed",
      desiredGeneration: null,
      observedGeneration: null,
      lastApplyAt: null,
      lastObservationAt: null,
      lastError: null,
      explanation: "No applied generation has been observed."
    },
    history: []
  };

test("Prompt detail surfaces the Runtime-derived reconciliation for the resource", () => {
  const prompt = promptDocumentFromControlApi({
    schema: "autodev-control-prompt-detail-v4",
    name: "dry",
    type: "command",
    source: ".rulesync/commands/dry.md",
    content: "# /dry\n\nUse a dry run.",
    preview: "## Rendered Prompt\n\n**Use a dry run.**",
    revision: "c".repeat(64),
    diff: {
      summary: "Canonical RuleSync command.",
      identifier: "c".repeat(64)
    },
    reconciliation: {
      status: {
        convergence: "pending",
        desiredGeneration: "gen-2",
        observedGeneration: null,
        lastApplyAt: "2026-02-03T04:05:06Z",
        lastObservationAt: null,
        lastError: null,
        explanation: "Applied generation gen-2 is not observed yet."
      },
      history: [
        {
          action: "patch_prompt_command",
          resource: "/control/prompts/dry",
          timestamp: "2026-02-03T04:05:06Z",
          actor: "autodev-local",
          outcome: "ok",
          reason: null,
          changes: {
            desiredGeneration: "gen-2",
            observedGeneration: null,
            restartRequired: false
          }
        }
      ]
    }
  });
  const markup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      prompt,
      reconciliation: {
        status: {
          convergence: "pending",
          desiredGeneration: "gen-2",
          observedGeneration: null,
          lastApplyAt: "2026-02-03T04:05:06Z",
          lastObservationAt: null,
          lastError: null,
          explanation: "Applied generation gen-2 is not observed yet."
        },
        history: [
          {
            action: "patch_prompt_command",
            resource: "/control/prompts/dry",
            timestamp: "2026-02-03T04:05:06Z",
            actor: "autodev-local",
            outcome: "ok",
            reason: null,
            changes: {
              desiredGeneration: "gen-2",
              observedGeneration: null,
              restartRequired: false
            }
          }
        ]
      },
      history: unavailablePromptHistory
    })
  );
  assert.match(markup, /data-section="prompt-reconciliation"/);
  assert.match(markup, /data-feature="reconciliation"/);
  // The verdict, the generations behind it, and the operation that produced
  // them all come from Runtime evidence, not from the page's own state.
  assert.match(markup, /data-status="pending"/);
  assert.match(markup, /Applied generation gen-2 is not observed yet\./);
  assert.match(markup, /data-field="desired-generation"[^>]*>gen-2</);
  // An unobserved generation must never render as an empty value.
  assert.match(markup, /data-field="observed-generation"[^>]*>Not observed</);

  // The labelled facts must give the value the room, not split the row evenly.
  // At `1fr 1fr` the label "Desired generation" occupied half a wide panel to
  // render in about a third of it, and the 64-character generation hash --
  // the one value on this panel worth comparing -- wrapped onto two lines.
  assert.match(markup, /sm:grid-cols-\[max-content_1fr\]/);
  assert.doesNotMatch(
    markup,
    /class="grid grid-cols-1 gap-1 text-xs text-fg-muted sm:grid-cols-2"/,
    "a label/value list must not split its row evenly"
  );
  assert.match(markup, /patch_prompt_command/);
  assert.match(markup, /data-history-outcome="ok"/);
});

test("Prompt detail reports an empty operation history instead of implying one", () => {
  const prompt = promptDocumentFromControlApi({
    schema: "autodev-control-prompt-detail-v4",
    name: "dry",
    type: "command",
    source: ".rulesync/commands/dry.md",
    content: "# /dry",
    preview: "",
    revision: "d".repeat(64),
    diff: {
      summary: "Canonical RuleSync command.",
      identifier: "d".repeat(64)
    },
    reconciliation: unobservedPromptReconciliation
  });
  const markup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      prompt,
      reconciliation: unobservedPromptReconciliation,
      history: unavailablePromptHistory
    })
  );
  assert.match(markup, /data-status="not-observed"/);
  assert.match(markup, /No recorded operations for this resource\./);
});

test("Prompt detail renders canonical text and reports an actually empty source", () => {
  const source = "# /dry\n\nUse a dry run.";
  const prompt = promptDocumentFromControlApi({
    schema: "autodev-control-prompt-detail-v4",
    name: "dry",
    type: "command",
    source: ".rulesync/commands/dry.md",
    content: source,
    preview: "## Rendered Prompt\n\n**Use a dry run.**",
    revision: "a".repeat(64),
    diff: {
      summary: "Canonical RuleSync command.",
      identifier: "a".repeat(64)
    },
    reconciliation: {
      status: {
        convergence: "not-observed",
        desiredGeneration: null,
        observedGeneration: null,
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: "Not observed."
      },
      history: []
    }
  });
  const markup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      reconciliation: unobservedPromptReconciliation,
      prompt,
      history: unavailablePromptHistory
    })
  );
  assert.match(markup, /Use a dry run\./);
  // The prompt body is content inside this page, so its own Markdown headings
  // are demoted past the Console's body sections. A `##` in the prompt must not
  // surface as a page-level heading above them.
  assert.match(
    markup,
    /<h5 class="mb-2 mt-4 text-lg font-semibold text-fg">Rendered Prompt<\/h5>/
  );
  assert.doesNotMatch(markup, /<h[123][^>]*>Rendered Prompt<\/h[123]>/);
  assert.match(markup, /<strong>Use a dry run\.<\/strong>/);
  assert.match(markup, /\.rulesync\/commands\/dry\.md/);
  assert.match(markup, /data-prompt-editor="canonical"/);
  assert.match(markup, /action="\/api\/prompts\/dry"/);
  assert.match(markup, /name="expectedRevision" value="a{64}"/);
  assert.match(markup, /Save &amp; Apply/);
  assert.match(markup, /data-prompt-history="unavailable"/);
  assert.match(markup, /Git history unavailable in this test\./);

  const hostilePreview = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      reconciliation: unobservedPromptReconciliation,
      prompt: {
        ...prompt,
        preview: "<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))"
      },
      history: unavailablePromptHistory
    })
  );
  assert.doesNotMatch(hostilePreview, /<script>/iu);
  assert.doesNotMatch(hostilePreview, /href="javascript:/iu);

  const versionHash = "b".repeat(40);
  const comparisonMarkup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      reconciliation: unobservedPromptReconciliation,
      prompt,
      history: {
        status: "available",
        versions: [{ versionHash, updatedAt: "2026-01-02T03:04:05Z" }],
        hasMore: false
      },
      selectedVersion: {
        schema: "autodev-control-prompt-version-v1",
        name: "dry",
        versionHash,
        updatedAt: "2026-01-02T03:04:05Z",
        content: source,
        diff: "-Use a dry run.\n+Use the current source.\n"
      }
    })
  );
  assert.match(comparisonMarkup, new RegExp(`revision=${versionHash}`));
  assert.match(comparisonMarkup, /data-prompt-version-comparison=/);
  assert.match(comparisonMarkup, /data-prompt-diff="observed"/);
  assert.match(comparisonMarkup, /Use the current source\./);
  assert.match(comparisonMarkup, /View committed source/);

  const applyFailedMarkup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      reconciliation: unobservedPromptReconciliation,
      prompt,
      history: unavailablePromptHistory,
      saveOutcome: "apply-failed"
    })
  );
  assert.match(applyFailedMarkup, /data-prompt-save-outcome="apply-failed"/);
  assert.match(applyFailedMarkup, /source was saved, but RuleSync generation/);

  const roleMarkup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      reconciliation: unobservedPromptReconciliation,
      prompt: {
        name: "orchestrator",
        kind: "role",
        path: "agents/prompts/roles/orchestrator.md",
        content: "# Role prompt",
        preview: "# Role prompt",
        revision: "d".repeat(64)
      },
      history: unavailablePromptHistory
    })
  );
  assert.match(roleMarkup, /data-prompt-editor="read-only"/);
  assert.equal(roleMarkup.includes("/api/prompts/orchestrator"), false);

  const emptyMarkup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      reconciliation: unobservedPromptReconciliation,
      prompt: { ...prompt, content: "" },
      history: unavailablePromptHistory
    })
  );
  assert.match(emptyMarkup, /data-prompt-content="empty"/);
  assert.equal(emptyMarkup.includes("# /dry"), false);
});

test("PromptsView and PromptDetailView render prompt types, linkage, and Git authority metadata", () => {
  const listMarkup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: [
        {
          name: "dry",
          path: ".rulesync/commands/dry.md",
          kind: "command",
          description: "Dry-run command"
        },
        {
          name: "orchestrator",
          path: "agents/prompts/roles/orchestrator.md",
          kind: "role",
          description: "Agent role prompt for orchestrator"
        }
      ],
      validationIssues: [],
      commandSourceValidity: true
    })
  );
  assert.match(listMarkup, /RuleSync Commands/);
  assert.match(listMarkup, /Agent Role Prompts/);
  assert.match(listMarkup, /Role prompt/);
  assert.match(listMarkup, /href="\/agents\/orchestrator"/);
  assert.match(listMarkup, /href="\/evaluations\?prompt=orchestrator"/);

  const detailMarkup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      reconciliation: unobservedPromptReconciliation,
      prompt: {
        name: "orchestrator",
        kind: "role",
        path: "agents/prompts/roles/orchestrator.md",
        content: "# Orchestrator System Prompt\nYou are an orchestrator.",
        preview: "# Orchestrator System Prompt\nYou are an orchestrator.",
        revision: "c".repeat(64)
      },
      history: unavailablePromptHistory
    })
  );
  assert.match(detailMarkup, /data-section="prompt-linkage"/);
  assert.match(detailMarkup, /Authority &amp; Versioning/);
  assert.match(detailMarkup, /Role prompt source/);
  assert.match(detailMarkup, /Related Agent/);
  assert.match(detailMarkup, /href="\/agents\/orchestrator"/);
  assert.match(detailMarkup, /Observability Linkage/);
  assert.match(detailMarkup, /href="\/evaluations\?prompt=orchestrator"/);
  assert.match(detailMarkup, /href="\/usage\?role=orchestrator"/);
  assert.match(detailMarkup, /Canonical Markdown Source/);
  assert.match(detailMarkup, /2 lines/);

  // Breadcrumb: shared breadcrumbs landmark with /prompts parent and
  // current-page aria state for the prompt name (no inline back link).
  assert.match(detailMarkup, /<nav aria-label="Breadcrumb"/);
  const breadcrumbNavStart = detailMarkup.indexOf(
    '<nav aria-label="Breadcrumb"'
  );
  const breadcrumbNavEnd = detailMarkup.indexOf("</nav>", breadcrumbNavStart);
  assert.ok(breadcrumbNavStart !== -1 && breadcrumbNavEnd !== -1);
  const breadcrumbMarkup = detailMarkup.slice(
    breadcrumbNavStart,
    breadcrumbNavEnd + "</nav>".length
  );
  assert.match(breadcrumbMarkup, /<a href="\/prompts"[^>]*>Prompts<\/a>/);
  assert.match(
    breadcrumbMarkup,
    /<span[^>]*aria-current="page"[^>]*>orchestrator<\/span>/
  );
  // No synthetic Home entry added and no legacy back-link copy remains.
  assert.equal(breadcrumbMarkup.includes("Home"), false);
  assert.equal(detailMarkup.includes("← Prompts"), false);
});

test("DataTable renders table with columns and data", () => {
  interface TestRow {
    readonly id: string;
    readonly name: string;
  }
  const data: readonly TestRow[] = [
    { id: "1", name: "Alpha" },
    { id: "2", name: "Beta" }
  ];
  const markup = renderToStaticMarkup(
    React.createElement<DataTableProps<TestRow>>(DataTable, {
      data,
      columns: [
        { id: "id", header: "ID", cell: (r: TestRow) => r.id },
        {
          id: "name",
          header: "Name",
          cell: (r: TestRow) => r.name,
          align: "tokens"
        }
      ],
      keyExtractor: (r: TestRow) => r.id,
      emptyMessage: "No rows."
    })
  );
  assert.ok(markup.includes("Alpha"));
  assert.ok(markup.includes("Beta"));
  assert.ok(markup.includes("<table"));
  assert.match(markup, /<td[^>]*class="[^"]*truncate[^"]*"[^>]*>1<\/td>/);
  // A `tokens` column wraps between items, and claims a larger share of the
  // width than a plain label so the browser cannot collapse it to one chip per
  // line. It breaks a token only when the token cannot fit on a line at all:
  // these columns hold identifiers and paths, which have no spaces, and
  // `break-normal` did not truncate them either -- it let them paint out of the
  // cell and across the next column.
  assert.match(markup, /class="[^"]*whitespace-normal break-words[^"]*"/);
  // Column widths are relative shares resolved to percentages, so a table
  // fills its container and a too-wide column set shrinks proportionally
  // instead of forcing a horizontal scroll.
  assert.ok(
    Array.from(markup.matchAll(/style="width:([0-9.]+)%"/g)).length > 0,
    "every column must resolve to a percentage of the table width"
  );
  // Fixed layout is what makes those percentages authoritative: without it a
  // long cell would grow its column past the declared share.
  assert.match(markup, /<table class="[^"]*table-fixed[^"]*"/);
});

test("DataTable distributes column width by weight, not by absolute length", () => {
  interface TestRow {
    readonly id: string;
  }
  const markup = renderToStaticMarkup(
    React.createElement<DataTableProps<TestRow>>(DataTable, {
      data: [{ id: "1" }],
      columns: [
        {
          id: "wide",
          header: "Wide",
          cell: (r: TestRow) => r.id,
          weight: 300
        },
        {
          id: "narrow",
          header: "Narrow",
          cell: (r: TestRow) => r.id,
          weight: 100
        }
      ],
      keyExtractor: (r: TestRow) => r.id,
      emptyMessage: "No rows."
    })
  );
  // Header and body cells must agree, so a column cannot change width when the
  // table switches between a header-only and a populated render.
  const headerWidths = Array.from(
    markup.matchAll(/<th [^>]*style="width:([0-9.]+)%"/g),
    (match) => Number(match[1])
  );
  const cellWidths = Array.from(
    markup.matchAll(/<td [^>]*style="width:([0-9.]+)%"/g),
    (match) => Number(match[1])
  );
  assert.equal(headerWidths.length, 2);
  assert.deepEqual(cellWidths, headerWidths);
  assert.equal(headerWidths[0], 75);
  assert.equal(headerWidths[1], 25);
  // The sums must total 100% so the table never overflows its container.
  assert.equal(
    headerWidths.reduce((sum, value) => sum + value, 0),
    100
  );
});

test("DataTable wraps column headers instead of truncating them", () => {
  interface TestRow {
    readonly id: string;
  }
  const markup = renderToStaticMarkup(
    React.createElement<DataTableProps<TestRow>>(DataTable, {
      data: [{ id: "1" }],
      columns: [
        {
          id: "convergence",
          header: "Convergence",
          cell: (r: TestRow) => r.id
        }
      ],
      keyExtractor: (r: TestRow) => r.id,
      emptyMessage: "No rows."
    })
  );
  // Relative widths shrink proportionally on a narrower viewport, so a header
  // that runs out of room wraps. Truncating it would render "CONVERGEN…" and
  // hide which column it labels.
  //
  // It wraps at word boundaries only. `break-words` used to be here, which let a
  // single-word header split mid-word -- "CONVERGENC E" -- and that reads as a
  // rendering fault rather than as a label. A column too narrow for its own
  // single word is a width to fix, not a word to break.
  assert.match(
    markup,
    /<th [^>]*class="[^"]*break-normal[^"]*"[^>]*><span data-column-label="[^"]*">Convergence<\/span><\/th>/
  );
  assert.doesNotMatch(markup, /<th [^>]*class="[^"]*truncate[^"]*"/);
  assert.doesNotMatch(markup, /<th [^>]*class="[^"]*break-words[^"]*"/);
});

test("no column is narrower than its own header", () => {
  // A column header is a label. The target state is explicit that "a column's
  // weight must be large enough for its own header: a header that renders as an
  // ellipsis is a layout defect, not acceptable truncation", and that a
  // single-word header which cannot fit "breaks rather than hiding which column
  // it labels".
  //
  // Two columns were measured breaking that rule and neither was caught here:
  // `/mcps` Transport and Overrides rendered as `TRANSPORTOVERRIDES` with no
  // gap, because the Transport weight had been cut to 95 while its header needs
  // 114. Their comments claimed the column fitted its header, which is how a
  // hand-tuned width becomes fiction.
  //
  // The minimums are measured, not computed, and that is the whole design of
  // this guard. The obvious alternative — estimate the header from its character
  // count — is wrong in both directions at once: uppercase 12px with
  // `tracking-wider` is 8.6px per character for `METRICS` and 9.1px for
  // `TRANSPORT`, and the figure that produced the original defect (8.1) was low
  // enough to certify a column that did not fit. Font metrics are not available
  // here, so the browser measures once and the numbers are asserted from then
  // on. Changing a weight without re-measuring fails this.
  //
  // Coverage is asserted rather than assumed: a header rendered by these views
  // but absent from the table below is a failure, not a skip. That is what keeps
  // the guard from going quietly vacuous as columns are added.
  // Measured in Chromium at each table's own floor, 2026-10. Keyed by the
  // header as authored: `uppercase` is a stylesheet concern and the markup
  // carries the source casing.
  const MEASURED_MINIMUM_PX: Record<string, number> = {
    Edit: 63,
    "Run Time": 65,
    Type: 67,
    Path: 68,
    Tool: 69,
    MCPs: 71,
    "Skill Name": 71,
    State: 74,
    "Role Scope": 77,
    Trace: 77,
    "Role / Agent": 78,
    Model: 79,
    Skills: 79,
    "Server Name": 84,
    Status: 84,
    Health: 85,
    "Target Role": 85,
    Source: 87,
    Models: 88,
    "Base Branch": 89,
    "Default State": 91,
    "Trigger Events": 91,
    "Eligible Roles": 92,
    "GitHub Actions State": 92,
    Metrics: 92,
    Related: 92,
    "Primary Model": 93,
    "Exposed Roles": 95,
    "Tier priority": 96,
    Outcome: 100,
    Provider: 100,
    "Command / Prompt": 104,
    "Cron Schedule": 104,
    RuleSync: 104,
    Overrides: 108,
    Providers: 109,
    Workflow: 111,
    "Canonical Source": 112,
    Transport: 114,
    Credential: 117,
    "Repository / Workspace": 117,
    "Configured roles": 120,
    Connection: 122,
    Enablement: 122,
    "Role enablement": 122,
    Description: 123,
    Availability: 124,
    Convergence: 133,
    // Measured in Chromium against the Providers table rendered with the longest
    // names the product shows ("gemini-3.8-flash-high"), as the width of each
    // header's own text. These are header widths, which is what this guard asks:
    // the Roles and Agent Limits columns are far wider than their headers
    // because their content is four dense rows of controls, and a column that is
    // merely wider than its header is the requirement -- content that cannot
    // fit is a different failure, caught by the browser sweep rather than here.
    Roles: 44,
    "Agent Limits": 95
  };

  // Rendered header text -> column pixels at the table's own floor.
  function columnWidthsAtFloor(markup: string): readonly [string, number][] {
    const minWidth = /style="[^"]*min-width:\s*(\d+)px/.exec(markup);
    assert.ok(minWidth, "the table declares its own floor as a pixel width");
    const floor = Number(minWidth[1]);
    const out: [string, number][] = [];
    for (const th of markup.matchAll(
      /<th [^>]*style="[^"]*width:\s*([\d.]+)%[^"]*"[^>]*>([\s\S]*?)<\/th>/g
    )) {
      // Read the label element rather than the whole header: a column may
      // carry a help affordance beside its label, and that affordance is not
      // part of the label a width has to fit.
      const inner = th[2] ?? "";
      const labelled =
        /<span data-column-label="[^"]*">([\s\S]*?)<\/span>/.exec(inner);
      const header = (labelled?.[1] ?? inner).replaceAll(/<[^>]*>/g, "").trim();
      out.push([header, (Number(th[1]) / 100) * floor]);
    }
    return out;
  }

  // One row per view, on purpose: every one of these renders an empty state
  // rather than a table when it has no rows, so an empty fixture would leave
  // this guard matching nothing and passing for the wrong reason. This is every
  // list surface that declares columns — `/hooks` is absent because it renders
  // no table at all, and `/permissions` because it fails closed.
  const markup = [
    renderToStaticMarkup(
      React.createElement(AgentsView, { agents: [CONFIGURED_AGENT] })
    ),
    renderToStaticMarkup(
      React.createElement(SkillsView, {
        skills: [
          {
            name: "orchestration",
            description: "Coordination",
            path: ".rulesync/skills/orchestration"
          }
        ],
        eligibility: [{ skill: "orchestration", roles: ["orchestrator"] }],
        unresolvedAssignments: [],
        sourceValidity: true,
        validationIssues: [],
        assignmentRoles: ["orchestrator", "worker"],
        executionContractRevision: "c".repeat(64)
      })
    ),
    renderToStaticMarkup(
      React.createElement(PromptsView, {
        commands: [
          {
            name: "dry",
            path: ".rulesync/commands/dry.md",
            description: "Dry-run command"
          }
        ],
        validationIssues: [],
        commandSourceValidity: true
      })
    ),
    renderToStaticMarkup(
      React.createElement(ProvidersView, {
        providers: PROVIDERS_FIXTURE,
        models: { status: "available", data: MODELS_FIXTURE }
      })
    ),
    renderToStaticMarkup(
      React.createElement(ToolsView, {
        tools: [
          {
            name: "find_code",
            source: "rulesync",
            exposedRoles: ["orchestrator"],
            description: "Find code"
          }
        ] as never,
        coverage: { schema: "x", source: "y" } as never,
        validity: "valid",
        usageLink: "/usage",
        filters: { source: "", role: "" }
      })
    ),
    renderToStaticMarkup(
      React.createElement(GithubView, {
        workflows: [
          {
            id: "_scheduler.yml",
            name: "scheduler",
            path: ".github/workflows/_scheduler.yml",
            events: ["schedule"],
            schedules: ["*/15 * * * *"]
          }
        ]
      })
    ),
    renderToStaticMarkup(
      React.createElement(WorkspacesView, {
        workspaces: [
          {
            id: "SimulatorLife/AutoDev",
            baseBranch: "main",
            enabled: true,
            agentRoles: null
          }
        ]
      })
    ),
    renderToStaticMarkup(
      React.createElement(McpsView, {
        servers: [
          {
            name: "context7",
            enabled: true,
            transport: "http",
            targetOverrides: [{ target: "codexcli", enabled: false }],
            declared: true,
            roles: ["docs-researcher"]
          }
        ],
        sourceValidity: true,
        validationIssues: []
      })
    ),
    renderToStaticMarkup(
      React.createElement(EvaluationsView, {
        evaluations: [
          {
            id: "eval-1",
            agentRole: "orchestrator",
            model: "autodev/orchestrator",
            passed: null,
            timestamp: "2026-10-01T00:00:00.000Z",
            metrics: [{ name: "latency", value: 12, pass: null }]
          }
        ]
      })
    )
  ].join("");

  const offenders: string[] = [];
  const seen: string[] = [];
  for (const [header, px] of columnWidthsAtFloor(markup)) {
    seen.push(header);
    const minimum = MEASURED_MINIMUM_PX[header];
    if (minimum === undefined) {
      offenders.push(
        `${header}: no measured minimum recorded — measure it in the browser and add it here`
      );
      continue;
    }
    if (px + 0.5 < minimum) {
      offenders.push(
        `${header}: ${px.toFixed(1)}px at the floor, measured minimum ${minimum}px`
      );
    }
  }

  assert.ok(
    seen.length >= 47,
    `the guard must cover every column it is about, got ${seen.length}: ${seen.join(" | ")}`
  );
  assert.deepEqual(
    offenders,
    [],
    `These columns are narrower than their own header at the table floor:\n${offenders.join("\n")}`
  );
});

test("DataTable clamps prose cells on an inner box, not the table cell", () => {
  interface TestRow {
    readonly id: string;
    readonly description: string;
  }
  const markup = renderToStaticMarkup(
    React.createElement<DataTableProps<TestRow>>(DataTable, {
      data: [{ id: "1", description: "A long description." }],
      columns: [
        { id: "id", header: "ID", cell: (r: TestRow) => r.id },
        {
          id: "description",
          header: "Description",
          cell: (r: TestRow) => r.description,
          align: "prose",
          clampLines: 2
        }
      ],
      keyExtractor: (r: TestRow) => r.id,
      emptyMessage: "No rows."
    })
  );
  // `-webkit-line-clamp` needs a box display, so the clamp belongs on a wrapper
  // inside the cell; clamping the `<td>` itself breaks its table-cell layout.
  assert.match(
    markup,
    /<td[^>]*class="[^"]*whitespace-normal break-words[^"]*"[^>]*><div class="line-clamp-2">/
  );
});

test("DataTable keeps a truncated cell's full value reachable, whatever it is built from", () => {
  // The target state requires it directly: "single-value cells truncate with
  // the full value reachable on hover". DataTable owns the `truncate` default,
  // so it owns the recovery -- a view cannot be trusted to remember it per
  // column, and fourteen views would each get it wrong differently.
  const value = "workspace/SimulatorLife/AutoDev/scope/that/never/ends";
  const cell = (
    align?: "truncate" | "tokens" | "prose",
    text: string = value
  ) =>
    React.createElement<DataTableProps<{ v: string }>>(DataTable, {
      data: [{ v: text }],
      columns: [
        {
          id: "c",
          header: "Scope",
          cell: (r: { v: string }) => r.v,
          ...(align === undefined ? {} : { align })
        }
      ],
      keyExtractor: (r: { v: string }) => r.v,
      emptyMessage: "No rows."
    });

  // The default align truncates, so the cell carries the whole value.
  const truncated = renderToStaticMarkup(cell());
  assert.match(
    truncated,
    /<td[^>]*class="[^"]*truncate[^"]*"[^>]*title="[^"]*"[^>]*>/,
    `a truncating cell must title itself with the whole value, got: ${truncated}`
  );
  assert.ok(truncated.includes(`title="${value}"`));

  // A `tokens` or `prose` cell wraps rather than truncates, so a title would
  // be claiming something false about a value that is fully visible.
  for (const align of ["tokens", "prose"] as const) {
    const wrapping = renderToStaticMarkup(cell(align));
    assert.doesNotMatch(
      wrapping,
      /<td[^>]*title=/,
      `a wrapping (${align}) cell must not claim to be truncated, got: ${wrapping}`
    );
  }

  // An empty cell gets no title: `title=""` is a tooltip with nothing in it.
  const empty = renderToStaticMarkup(cell("truncate", ""));
  assert.doesNotMatch(empty, /<td[^>]*title=/);

  // An element cell gets the same treatment, because the recovery is the
  // cell's, not the element's. This assertion used to require the *absence* of
  // a title here, on the reasoning that "a chip titles itself and a link holds
  // the value in its destination". Swept against the live router, that
  // reasoning was wrong for most of the cells it covered: a column of plain
  // spans (GitHub cron schedule), a column of chip `<div>`s (GitHub trigger
  // events) and a column of styled links (/tools EDIT) each had no title
  // anywhere and no href carrying what was hidden, so the ellipsis was the only
  // copy of the value. The title is derived from the node's own children, so it
  // repeats exactly what the cell shows rather than describing it.
  const elementCell = renderToStaticMarkup(
    React.createElement<DataTableProps<{ v: string }>>(DataTable, {
      data: [{ v: value }],
      columns: [
        {
          id: "c",
          header: "Scope",
          cell: (r: { v: string }) =>
            React.createElement(
              "span",
              { className: "truncate", title: r.v },
              r.v
            )
        }
      ],
      keyExtractor: (r: { v: string }) => r.v,
      emptyMessage: "No rows."
    })
  );
  assert.match(
    elementCell,
    /<td[^>]*title="/,
    `a truncating cell must title itself whatever its content is built from, got: ${elementCell}`
  );
  assert.ok(elementCell.includes(`title="${value}"`));

  // The three shapes that were actually cut in the browser, so the rule is
  // proved against the markup that motivated it rather than against one shape.
  for (const build of [
    (r: { v: string }) =>
      React.createElement("span", { className: "text-xs" }, r.v),
    (r: { v: string }) =>
      React.createElement(
        "div",
        { className: "flex flex-wrap gap-1" },
        React.createElement("span", { key: "a" }, r.v),
        React.createElement("span", { key: "b" }, "workflow_dispatch")
      ),
    (r: { v: string }) =>
      React.createElement(
        "a",
        { href: "/mcps/codegraphcontext", className: "font-mono" },
        r.v
      ),
    // A component whose visible text arrives as a `label` prop rather than as
    // children, which is how `StatusBadge` is written. Reading children alone
    // found nothing here, so the cell got no title -- the same hole the rule
    // exists to close, one level deeper. This is the shape the /mcps "Not
    // observed" pills take.
    (r: { v: string }) =>
      React.createElement(StatusBadge, { status: "not-observed", label: r.v })
  ]) {
    const cut = renderToStaticMarkup(
      React.createElement<DataTableProps<{ v: string }>>(DataTable, {
        data: [{ v: value }],
        columns: [
          {
            id: "c",
            header: "Scope",
            cell: (r: { v: string }) => build(r)
          }
        ],
        keyExtractor: (r: { v: string }) => r.v,
        emptyMessage: "No rows."
      })
    );
    // The title carries every part of the cell, not just the first: a chip row
    // has more than one value to lose, and a title naming only the first would
    // still drop the second.
    const title = /<td[^>]*title="([^"]*)"/.exec(cut)?.[1];
    assert.ok(
      title !== undefined && title.includes(value),
      `every truncating cell shape must keep its value, got: ${cut}`
    );
  }
});

test("StatCard renders value and title", () => {
  const markup = renderToStaticMarkup(
    React.createElement(StatCard, {
      title: "Requests",
      value: 1234,
      subtitle: "Last 24h"
    })
  );
  assert.ok(markup.includes("Requests"));
  assert.ok(markup.includes("1234"));
  assert.ok(markup.includes("Last 24h"));
});

test("server Control API client uses only its configured token and fixed local actor", async () => {
  const token = "server-only-control-token";
  const requests: Array<{ readonly url: string; readonly headers: Headers }> =
    [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers)
    });
    return Response.json({
      schema: "autodev-control-providers-v2",
      orchestratorTier: "orchestrator",
      tiers: [],
      providers: []
    });
  };

  const result = await fetchProviders(
    { baseUrl: "http://127.0.0.1:4101", serviceToken: token },
    { fetchImpl }
  );

  const request = requests[0];
  assert.ok(request);
  assert.equal(
    request.url,
    `http://127.0.0.1:4101${CONTROL_API_PATHS.providers}`
  );
  assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
  assert.equal(request.headers.get("x-autodev-actor"), LOCAL_CONTROL_API_ACTOR);
  const toolsResult = await fetchTools(
    { baseUrl: "http://127.0.0.1:4101", serviceToken: token },
    {
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers)
        });
        return Response.json({
          schema: "autodev-control-tools-v1",
          source: "execution-contract",
          readOnly: true,
          coverage: "partial",
          totalTools: 0,
          tools: []
        });
      }
    }
  );

  assert.equal(
    requests[1]?.url,
    `http://127.0.0.1:4101${CONTROL_API_PATHS.tools}`
  );
  assert.equal(requests[1]?.headers.get("authorization"), `Bearer ${token}`);
  assert.equal(
    requests[1]?.headers.get("x-autodev-actor"),
    LOCAL_CONTROL_API_ACTOR
  );
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(toolsResult).includes(token), false);
  assert.equal(readControlApiConfig({} as NodeJS.ProcessEnv), null);
});

test("Control API detail fetchers encode identifiers and preserve not-found status", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json(
      {
        code: "autodev_control_api_unknown_resource",
        message: "Unknown resource.",
        status: 404
      },
      { status: 404 }
    );
  };
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "server-only"
  };

  const agent = await fetchAgentDetail("role/name", config, { fetchImpl });
  const prompt = await fetchPromptDetail("name with spaces", config, {
    fetchImpl
  });

  assert.equal(urls[0], "http://127.0.0.1:4101/control/agents/role%2Fname");
  assert.equal(
    urls[1],
    "http://127.0.0.1:4101/control/prompts/name%20with%20spaces"
  );
  assert.equal(agent.kind, "http-error");
  assert.equal(agent.status, 404);
  assert.equal(prompt.kind, "http-error");
  assert.equal(prompt.status, 404);

  const stalePrompt = await fetchPromptDetail("dry", config, {
    fetchImpl: async () =>
      Response.json({
        schema: "autodev-control-prompt-detail-v2",
        name: "dry",
        type: "command",
        source: ".rulesync/commands/dry.md",
        content: "# Dry",
        revision: "a".repeat(64)
      })
  });
  assert.equal(stalePrompt.kind, "invalid-response");
  if (stalePrompt.kind === "invalid-response") {
    assert.equal(
      stalePrompt.code,
      "autodev_control_api_invalid_prompt_detail_response"
    );
    assert.match(stalePrompt.message, /v4 reconciliation contract/);
  }
});

test("Prompt version fetchers validate recent history and selected revision identity", async () => {
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "server-only"
  };
  const versionHash = "a".repeat(40);
  const urls: string[] = [];
  const payloads: unknown[] = [
    {
      schema: "autodev-control-prompt-versions-v1",
      name: "audit",
      status: "available",
      versions: [{ versionHash, updatedAt: "2026-01-02T03:04:05Z" }],
      hasMore: false
    },
    {
      schema: "autodev-control-prompt-version-v1",
      name: "audit",
      versionHash,
      updatedAt: "2026-01-02T03:04:05Z",
      content: "# Audit",
      diff: ""
    }
  ];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json(payloads.shift());
  };

  const versions = await fetchPromptVersions("audit", config, { fetchImpl });
  const version = await fetchPromptVersion("audit", versionHash, config, {
    fetchImpl
  });
  assert.equal(versions.kind, "ok");
  assert.equal(version.kind, "ok");
  assert.deepEqual(urls, [
    "http://127.0.0.1:4101/control/prompts/audit/versions",
    `http://127.0.0.1:4101/control/prompts/audit/versions/${versionHash}`
  ]);

  const mismatchedVersion = await fetchPromptVersion(
    "audit",
    versionHash,
    config,
    {
      fetchImpl: async () =>
        Response.json({
          schema: "autodev-control-prompt-version-v1",
          name: "other-command",
          versionHash,
          updatedAt: "2026-01-02T03:04:05Z",
          content: "# Other",
          diff: ""
        })
    }
  );
  assert.equal(mismatchedVersion.kind, "invalid-response");

  const mismatchedHistory = await fetchPromptVersions("audit", config, {
    fetchImpl: async () =>
      Response.json({
        schema: "autodev-control-prompt-versions-v1",
        name: "other-command",
        status: "available",
        versions: [],
        hasMore: false
      })
  });
  assert.equal(mismatchedHistory.kind, "invalid-response");

  const malformedUnavailable = await fetchPromptVersions("audit", config, {
    fetchImpl: async () =>
      Response.json({
        schema: "autodev-control-prompt-versions-v1",
        name: "audit",
        status: "unavailable",
        versions: [{ versionHash, updatedAt: "2026-01-02T03:04:05Z" }],
        hasMore: false
      })
  });
  assert.equal(malformedUnavailable.kind, "invalid-response");
});

test("Skills fetcher validates the v2 catalog contract and rejects stale responses", async () => {
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "server-only"
  };
  const payload = {
    schema: "autodev-control-skills-v2",
    source: ".rulesync/skills+execution-contract",
    readOnly: true,
    valid: true,
    executionContractRevision: "b".repeat(64),
    assignmentRoles: ["validator"],
    issues: [],
    skills: [
      {
        name: "audit",
        description: "Review canonical sources.",
        path: ".rulesync/skills/audit/SKILL.md",
        roles: ["validator"]
      }
    ],
    unresolvedAssignments: []
  };
  const valid = await fetchSkills(config, {
    fetchImpl: async () => Response.json(payload)
  });
  assert.equal(valid.kind, "ok");
  if (valid.kind === "ok") assert.deepEqual(valid.data, payload);

  const noContract = await fetchSkills(config, {
    fetchImpl: async () =>
      Response.json({ ...payload, executionContractRevision: null })
  });
  assert.equal(
    noContract.kind,
    "ok",
    "no contract file is an observed state the page renders, not a broken read"
  );

  // A revision the assignment form would post is the only thing detecting a
  // concurrent write, so a missing or malformed one has to fail the whole
  // response. Treating it as optional would let the page render a form that is
  // refused on every submission.
  for (const executionContractRevision of [undefined, "not-a-digest", 17]) {
    const malformedRevision = await fetchSkills(config, {
      fetchImpl: async () =>
        Response.json({ ...payload, executionContractRevision })
    });
    assert.equal(
      malformedRevision.kind,
      "invalid-response",
      `revision ${String(executionContractRevision)} must not be accepted`
    );
  }

  const stale = await fetchSkills(config, {
    fetchImpl: async () =>
      Response.json({
        schema: "autodev-control-skills-v1",
        source: "execution-contract",
        readOnly: true,
        skills: [{ name: "audit", roles: ["validator"] }]
      })
  });
  assert.equal(stale.kind, "invalid-response");
  if (stale.kind === "invalid-response") {
    assert.equal(stale.code, "autodev_control_api_invalid_skills_response");
    assert.match(stale.message, /requires the v2 canonical catalog contract/);
  }
});

test("fetchControlApi extracts code and message from Control API error envelope", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json(
      {
        error: {
          code: "autodev_control_api_unauthorized",
          message:
            "Control API requires the AutoDev server-side service credential.",
          type: "autodev_control_api_error"
        }
      },
      { status: 401 }
    );
  const result = await fetchControlApi(
    "/control/skills",
    {
      baseUrl: "http://127.0.0.1:4101",
      serviceToken: "test"
    },
    { fetchImpl }
  );
  assert.equal(result.kind, "unauthorized");
  if (result.kind === "unauthorized") {
    assert.equal(result.status, 401);
    assert.equal(result.code, "autodev_control_api_unauthorized");
    assert.equal(
      result.message,
      "Control API requires the AutoDev server-side service credential."
    );
  }
});

test("readControlApiConfig and readOpenLITUsageConfig fall back to canonical secret file when token is unset", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "autodev-console-test-secrets-"));
  const secretFile = join(tempDir, "openlit-secrets.env");
  writeFileSync(
    secretFile,
    "AUTODEV_CONTROL_API_TOKEN=file-control-token\nAUTODEV_OPENLIT_USAGE_TOKEN=file-usage-token\n"
  );
  try {
    const controlConfig = readControlApiConfig({
      CODEX_HOME: tempDir
    } as unknown as NodeJS.ProcessEnv);
    assert.ok(controlConfig);
    assert.equal(controlConfig.serviceToken, "file-control-token");

    const usageConfig = readOpenLITUsageConfig({
      CODEX_HOME: tempDir
    });
    assert.ok(usageConfig);
    assert.equal(usageConfig.serviceToken, "file-usage-token");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * Regression suite: missing data must NOT render green/optimistic state.
 *
 * Each view must report `Not observed` -- and only that word -- rather than
 * fabricated `100%`, `Connected`, `Active`, `Recorded`, or `Available`.
 */

test("Usage role and provider breakdowns use distinct semantic chart series", () => {
  const metrics: UsageMetricsData = {
    logicalRequests: 3,
    totalInputTokens: 1000,
    totalOutputTokens: 2000,
    cacheReadRate: 50,
    p95LatencyMs: 100,
    physicalAttempts: 5,
    mcpCalls: 1,
    p95McpDurationMs: 10,
    mcpErrors: 0,
    requestsByRole: [{ role: "orchestrator", count: 3 }],
    attemptsByProvider: [{ provider: "codex", count: 5 }],
    callsByTool: []
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, { metrics })
  );

  // Each breakdown is its own series, so both the bar it draws and the value it
  // prints carry that series colour and never the other's.
  assert.ok(
    markup.includes("bg-chart-1"),
    "role breakdown draws a chart-1 bar"
  );
  assert.ok(markup.includes("text-chart-1"), "role breakdown value is chart-1");
  assert.ok(
    markup.includes("bg-chart-2"),
    "provider breakdown draws a chart-2 bar"
  );
  assert.ok(
    markup.includes("text-chart-2"),
    "provider breakdown value is chart-2"
  );
  // The bar is the value encoding; it is an inline percentage because it comes
  // from the data rather than from the class list.
  assert.match(
    markup,
    /class="block h-full rounded-sm bg-chart-1" style="width:100%"/
  );
  // And the exact value is still readable as text, so the chart never becomes
  // the only way to get a number.
  assert.ok(markup.includes(">3</span>"));
  assert.ok(markup.includes(">5</span>"));
});

test("UsageView with no metrics renders explicit 'Not observed' values", () => {
  const markup = renderToStaticMarkup(React.createElement(UsageView, {}));
  assert.match(markup, /Not observed/);
  assert.match(markup, /data-usage-observed="false"/);
  // Filters must NOT seed hardcoded providers/workspaces/models/roles.
  assert.equal(
    markup.includes("SimulatorLife/AutoDev"),
    false,
    "UsageView must not seed workspaces with fixture values"
  );
  assert.equal(
    markup.includes("gpt-5.6-terra"),
    false,
    "UsageView must not seed models with fixture values"
  );
});

test("Usage values stay readable at large scales and keep unattributed groups explicit", () => {
  assert.equal(formatCount(8320), "8,320");
  assert.equal(formatTokenCount(1_443_517_000), "1.4B");
  assert.equal(formatTokenCount(3_561_000), "3.6M");
  assert.equal(formatLatency(42_364.660_695_649_996), "42.4 s");
  assert.equal(formatLatency(84.313_416_499_999_99), "84.3 ms");
  assert.equal(formatLatency(null), "Not observed");

  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: {
        logicalRequests: 8320,
        totalInputTokens: 1_443_517_000,
        totalOutputTokens: 3_561_000,
        cacheReadRate: null,
        p95LatencyMs: 42_364.660_695_649_996,
        physicalAttempts: 8320,
        mcpCalls: 6,
        p95McpDurationMs: 84.313_416_499_999_99,
        mcpErrors: 0,
        requestsByRole: [{ role: "", count: 126 }],
        attemptsByProvider: [{ provider: "codex", count: 3419 }],
        callsByTool: [{ tool: "", count: 1234 }]
      }
    })
  );
  assert.match(markup, /1\.4B \/ 3\.6M/);
  assert.match(markup, /42\.4 s/);
  assert.match(markup, /84\.3 ms/);
  assert.match(markup, /Not attributed/);
  assert.match(markup, /8,320/);
  assert.match(markup, /3,419/);
  assert.match(markup, /1,234/);
});

test("Usage URL filters preserve stock time ranges, custom dates, and server-only credentials", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");
  assert.deepEqual(
    usageSelectionFromSearchParams(
      {
        range: "7D",
        workspace: ["repo-a", "repo-b", "repo-a", ""],
        provider: "openai",
        skill: "unbound",
        startDate: "2026-09-20",
        endDate: "2026-10-01"
      },
      now
    ),
    {
      range: "7D",
      values: { workspace: ["repo-a", "repo-b"], provider: ["openai"] },
      customRange: { startDate: "2026-09-20", endDate: "2026-10-01" }
    }
  );
  assert.deepEqual(
    usageSelectionFromSearchParams(
      { range: "CUSTOM", startDate: "2026-09-01", endDate: "2026-10-01" },
      now
    ),
    {
      range: "CUSTOM",
      values: {},
      customRange: { startDate: "2026-09-01", endDate: "2026-10-01" }
    }
  );
  assert.equal(
    usageSelectionFromSearchParams({ range: "all-time" }, now).range,
    "24H"
  );
  assert.deepEqual(
    readOpenLITUsageConfig({
      AUTODEV_OPENLIT_USAGE_TOKEN: " secret ",
      AUTODEV_OPENLIT_USAGE_URL: "http://openlit:3000/"
    }),
    { baseUrl: "http://openlit:3000", serviceToken: "secret" }
  );
  assert.equal(readOpenLITUsageConfig({}), null);
});

test("UsageView persists selected filters in GET controls without defaults", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      selection: {
        range: "7D",
        values: { provider: ["openai"] },
        customRange: { startDate: "2026-09-20", endDate: "2026-10-01" }
      },
      filterOptions: {
        workspace: [],
        provider: ["openai", "anthropic"],
        model: null,
        agent: [],
        skill: null
      }
    })
  );
  // The form method is spelled by the shared FilterBar primitive now, so this
  // asserts the behaviour (a GET filter submission) rather than the casing one
  // call site happened to use.
  assert.match(markup, /method="GET"/i);
  assert.match(markup, /aria-label="Usage filters"/);
  assert.match(markup, /name="range"/);
  assert.match(markup, /value="7D" selected/);
  assert.match(markup, /name="startDate" value="2026-09-20"/);
  assert.match(markup, /name="endDate" value="2026-10-01"/);
  assert.match(markup, /name="startDate"/);
  assert.match(markup, /name="endDate"/);
  assert.match(markup, /value="openai" selected/);
  assert.match(markup, /data-filter-options-observed="false"/);
  assert.match(markup, /data-usage-observed="false"/);
});

test("UsageView exposes custom-range controls with UTC date state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      selection: {
        range: "CUSTOM",
        values: {},
        customRange: { startDate: "2026-09-17", endDate: "2026-10-01" }
      }
    })
  );
  assert.match(markup, /<details[^>]*open=""/);
  assert.match(markup, /value="24H"/);
  assert.match(markup, /value="7D"/);
  assert.match(markup, /value="1M"/);
  assert.match(markup, /value="3M"/);
  assert.match(markup, /value="CUSTOM" selected/);
  assert.match(markup, /Custom range accepts up to 90 days/);
  assert.match(markup, /current telemetry retention is about 30 days/);
  assert.equal(markup.includes("OpenLIT"), false);
});

test("UsageView with empty arrays still reports no synthetic counts", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsageView, {
      metrics: {
        logicalRequests: null,
        totalInputTokens: null,
        totalOutputTokens: null,
        cacheReadRate: null,
        p95LatencyMs: null,
        physicalAttempts: null,
        mcpCalls: null,
        p95McpDurationMs: null,
        mcpErrors: null,
        requestsByRole: [],
        attemptsByProvider: [],
        callsByTool: []
      }
    })
  );
  assert.match(markup, /Not observed/);
  assert.match(markup, /No logical requests were observed in this time range/);
  assert.match(markup, /No provider attempts were observed in this time range/);
  assert.match(markup, /No MCP tool calls were observed in this time range/);
  assert.match(markup, /data-usage-observed="true"/);
});

test("McpsView never reports 'Connected' or '100%' without runtime evidence", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpsView, {
      servers: [
        {
          name: "playwright",
          enabled: false,
          transport: "stdio",
          declared: true,
          roles: ["browser-tester"],
          targetOverrides: [{ target: "codexcli", enabled: false }]
        }
      ],
      sourceValidity: true,
      validationIssues: []
    })
  );
  assert.equal(markup.includes("Connected"), false);
  assert.equal(markup.includes("100%"), false);
  assert.equal(markup.includes("All servers available"), false);
  assert.match(markup, /data-mcp-connection-observed="false"/);
  assert.match(markup, /RuleSync source valid/);
  assert.match(markup, /codexcli: disabled/);
  assert.match(markup, />Disabled</);
  assert.match(markup, /data-status="configured"/);
  assert.match(markup, /STDIO/);
  assert.match(markup, /href="\/mcps\/playwright"/);
});

test("McpDetailView combines canonical desired state with unknown runtime health", () => {
  const server: McpServerResource = {
    name: "context7",
    enabled: true,
    transport: "http",
    targetOverrides: [{ target: "codexcli", enabled: false }],
    declared: true,
    roles: ["docs-researcher"]
  };
  const overviewMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server,
      activeTab: "overview"
    })
  );
  assert.match(overviewMarkup, /Desired state/);
  assert.match(overviewMarkup, /Enabled by default/);
  assert.match(overviewMarkup, /Runtime connection/);
  assert.match(overviewMarkup, /Not observed/);
  assert.doesNotMatch(overviewMarkup, /Connected/);

  const configurationMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server,
      activeTab: "configuration"
    })
  );
  assert.match(configurationMarkup, /codexcli: disabled/);

  const roleAccessMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server,
      activeTab: "role-access"
    })
  );
  assert.match(roleAccessMarkup, /docs-researcher/);

  const toolsMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server,
      activeTab: "tools"
    })
  );
  assert.match(toolsMarkup, /Configured tool allowlist/);
  assert.match(toolsMarkup, /data-tool-allowlist-projection="unknown"/);
  assert.match(toolsMarkup, />Not observed</);
  assert.doesNotMatch(toolsMarkup, /Connected/);

  const activityMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server,
      activeTab: "activity"
    })
  );
  assert.match(activityMarkup, /Tools, resources, prompts, and activity/);
});

test("McpDetailView renders populated configured tool allowlist from the Tools capability projection", () => {
  const server: McpServerResource = {
    name: "context7",
    enabled: true,
    transport: "http",
    targetOverrides: [],
    declared: true,
    roles: ["docs-researcher"]
  };
  const configuredTools: readonly ToolCatalogItem[] = [
    {
      name: "resolve-library-id",
      source: "mcp",
      server: "context7",
      sourceAuthority: "execution-contract",
      availability: "configured",
      exposedRoles: ["docs-researcher"]
    },
    {
      name: "get-library-docs",
      source: "mcp",
      server: "context7",
      sourceAuthority: "execution-contract",
      availability: "configured",
      exposedRoles: ["docs-researcher", "code-reviewer"]
    }
  ];
  const toolsMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "tools"
    })
  );
  assert.match(toolsMarkup, /Configured tool allowlist/);
  assert.match(toolsMarkup, /data-tool-allowlist-projection="partial"/);
  assert.match(toolsMarkup, /data-enumerated-tool-count="2"/);
  assert.match(toolsMarkup, /resolve-library-id/);
  assert.match(toolsMarkup, /get-library-docs/);
  assert.match(toolsMarkup, />docs-researcher</);
  assert.match(toolsMarkup, />code-reviewer</);
  assert.doesNotMatch(toolsMarkup, /Connected/);
  assert.doesNotMatch(toolsMarkup, /data-status="ready"/);

  const activityMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "activity"
    })
  );
  assert.match(activityMarkup, /Not observed/);
  assert.match(activityMarkup, /Tools, resources, prompts, and activity/);
});

test("McpDetailView distinguishes no enumerated allowlist entries from an empty live inventory", () => {
  const server: McpServerResource = {
    name: "context7",
    enabled: true,
    transport: "http",
    targetOverrides: [],
    declared: true,
    roles: ["docs-researcher"]
  };
  const toolsMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: [],
      server,
      activeTab: "tools"
    })
  );
  assert.match(toolsMarkup, /Configured tool allowlist/);
  assert.match(toolsMarkup, /data-tool-allowlist-projection="partial-empty"/);
  assert.match(toolsMarkup, /data-enumerated-tool-count="0"/);
  assert.match(toolsMarkup, /No allowlist entries enumerated/);
  assert.match(toolsMarkup, /live inventory remains unknown/);
  assert.doesNotMatch(toolsMarkup, /None configured/);
  assert.doesNotMatch(toolsMarkup, /Connected/);
  assert.doesNotMatch(toolsMarkup, /data-status="ready"/);

  const overviewMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: [],
      server,
      activeTab: "overview"
    })
  );
  assert.match(overviewMarkup, /Not observed/);
});

test("McpDetailView distinguishes an unavailable tool source from an empty allowlist", () => {
  const server: McpServerResource = {
    name: "playwright",
    enabled: false,
    transport: "stdio",
    targetOverrides: [],
    declared: true,
    roles: ["browser-tester"]
  };
  const toolsMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server,
      activeTab: "tools"
    })
  );
  assert.match(toolsMarkup, /Configured tool allowlist/);
  assert.match(toolsMarkup, /data-tool-allowlist-projection="unknown"/);
  assert.doesNotMatch(toolsMarkup, /data-enumerated-tool-count="0"/);
  assert.match(toolsMarkup, />Not observed</);
  assert.doesNotMatch(toolsMarkup, /None configured/);
  assert.doesNotMatch(toolsMarkup, /Connected/);
  assert.doesNotMatch(toolsMarkup, /data-status="ready"/);

  const activityMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server,
      activeTab: "activity"
    })
  );
  assert.match(activityMarkup, /Tools, resources, prompts, and activity/);
  assert.match(activityMarkup, /Not observed/);
});

test("McpDetailView renders full §14 diagnostic sub-panels across their owning tabs with configuration and unobserved runtime state", () => {
  const server: McpServerResource = {
    name: "lsp",
    enabled: true,
    transport: "stdio",
    command: "bash",
    args: ["-lc", "exec run-lsp.sh"],
    cwd: "/Users/test/workspace",
    envKeys: ["LSP_SERVER_PATH", "LSP_TIMEOUT"],
    defaultToolsApprovalMode: "approve",
    targetOverrides: [
      {
        target: "codexcli",
        enabled: true,
        defaultToolsApprovalMode: "approve",
        enabledTools: ["lsp_goto_definition"]
      }
    ],
    declared: true,
    roles: ["orchestrator"]
  };
  const configuredTools: readonly ToolCatalogItem[] = [
    {
      name: "lsp_goto_definition",
      source: "mcp",
      server: "lsp",
      sourceAuthority: "execution-contract",
      availability: "configured",
      exposedRoles: ["orchestrator"]
    }
  ];

  const configurationMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "configuration"
    })
  );
  assert.match(configurationMarkup, /data-section="mcp-configuration"/);
  assert.match(configurationMarkup, /Server configuration/);
  assert.match(configurationMarkup, /exec run-lsp\.sh/);
  assert.match(configurationMarkup, /\/Users\/test\/workspace/);
  assert.match(configurationMarkup, /LSP_SERVER_PATH, LSP_TIMEOUT/);
  assert.match(configurationMarkup, /mode: approve/);
  assert.match(configurationMarkup, /tools: lsp_goto_definition/);

  const connectionHealthMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "connection-health"
    })
  );
  assert.match(connectionHealthMarkup, /data-section="mcp-connection-health"/);
  assert.match(connectionHealthMarkup, /Connection &amp; Health/);
  assert.match(connectionHealthMarkup, /Probe status: Not observed/);

  const roleAccessMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "role-access"
    })
  );
  assert.match(roleAccessMarkup, /data-section="mcp-role-access"/);

  const toolsMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "tools"
    })
  );
  assert.match(toolsMarkup, /data-section="mcp-tools"/);

  const resourcesMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "resources"
    })
  );
  assert.match(resourcesMarkup, /data-section="mcp-resources"/);
  assert.match(resourcesMarkup, /Resources inventory: Not observed/);

  const promptsMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "prompts"
    })
  );
  assert.match(promptsMarkup, /data-section="mcp-prompts"/);
  assert.match(promptsMarkup, /Prompts inventory: Not observed/);

  const activityMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "activity"
    })
  );
  assert.match(activityMarkup, /data-section="mcp-activity"/);
  assert.match(activityMarkup, /Activity: Not observed/);

  const errorsLogsMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools,
      server,
      activeTab: "errors-logs"
    })
  );
  assert.match(errorsLogsMarkup, /data-section="mcp-errors-logs"/);
  assert.match(errorsLogsMarkup, /Error logs: Not observed/);
});

test("MCP_DETAIL_TABS declares the exact target-state tab order and count", () => {
  assert.equal(MCP_DETAIL_TABS.length, 9);
  assert.deepEqual(
    MCP_DETAIL_TABS.map((tab) => tab.id),
    [
      "overview",
      "configuration",
      "connection-health",
      "tools",
      "resources",
      "prompts",
      "role-access",
      "activity",
      "errors-logs"
    ]
  );
  assert.deepEqual(
    MCP_DETAIL_TABS.map((tab) => tab.label),
    [
      "Overview",
      "Configuration",
      "Connection / Health",
      "Tools",
      "Resources",
      "Prompts",
      "Role Access",
      "Activity",
      "Errors / Logs"
    ]
  );
});

test("McpDetailView tab navigation renders all nine tabs as deterministic, URL-addressable links with aria-current on the active tab", () => {
  const server: McpServerResource = {
    name: "playwright",
    enabled: false,
    transport: "stdio",
    targetOverrides: [],
    declared: true,
    roles: []
  };
  const markup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server,
      activeTab: "resources"
    })
  );
  assert.match(markup, /aria-label="playwright detail sections"/);
  for (const tab of MCP_DETAIL_TABS) {
    const expectedHref = "/mcps/playwright?tab=" + tab.id;
    assert.ok(
      markup.includes('href="' + expectedHref + '"'),
      "expected tab href " + expectedHref
    );
  }
  const activeCurrentMatches = markup.match(/aria-current="page"/g) ?? [];
  // The active TabNav tab carries aria-current="page", and the current-page
  // breadcrumb item also carries aria-current="page". The McpDetailView
  // therefore exposes exactly two aria-current markers: the active tab and
  // the current-page breadcrumb.
  assert.equal(activeCurrentMatches.length, 2);
  assert.match(markup, /aria-current="page"[^>]*data-tab-item="resources"/);
  // Breadcrumb: native link to /mcps ancestor and aria-current on the
  // current page (the MCP server name), no synthetic Home entry.
  assert.match(markup, /href="\/mcps"/);
  assert.match(markup, /<span[^>]*aria-current="page"[^>]*>playwright<\/span>/);
});

test("McpDetailView falls back to the Overview tab for an unknown or missing ?tab= value", () => {
  const server: McpServerResource = {
    name: "playwright",
    enabled: false,
    transport: "stdio",
    targetOverrides: [],
    declared: true,
    roles: []
  };
  const unknownTabMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server,
      activeTab: "not-a-real-tab"
    })
  );
  assert.match(unknownTabMarkup, /data-section="mcp-overview"/);
  assert.match(unknownTabMarkup, /Desired state/);
  assert.doesNotMatch(unknownTabMarkup, /data-section="mcp-configuration"/);
  assert.match(
    unknownTabMarkup,
    /aria-current="page"[^>]*data-tab-item="overview"/
  );

  const missingTabMarkup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: null,
      server
    })
  );
  assert.match(missingTabMarkup, /data-section="mcp-overview"/);
  assert.match(missingTabMarkup, /Desired state/);
  assert.match(
    missingTabMarkup,
    /aria-current="page"[^>]*data-tab-item="overview"/
  );
});

test("McpDetailView renders exactly one data-section panel per tab with no content discarded across all nine tabs", () => {
  const server: McpServerResource = {
    name: "lsp",
    enabled: true,
    transport: "stdio",
    command: "bash",
    args: ["-lc", "exec run-lsp.sh"],
    targetOverrides: [],
    declared: true,
    roles: ["orchestrator"]
  };
  const configuredTools: readonly ToolCatalogItem[] = [
    {
      name: "lsp_goto_definition",
      source: "mcp",
      server: "lsp",
      sourceAuthority: "execution-contract",
      availability: "configured",
      exposedRoles: ["orchestrator"]
    }
  ];
  const observedSectionIds = new Set();
  for (const tab of MCP_DETAIL_TABS) {
    const markup = renderToStaticMarkup(
      React.createElement(McpDetailView, {
        sourceValidity: true,
        configuredTools,
        server,
        activeTab: tab.id
      })
    );
    const sectionMatches = markup.match(/data-section="mcp-[a-z-]+"/g) ?? [];
    assert.equal(
      sectionMatches.length,
      1,
      "expected exactly one rendered data-section for tab " + tab.id
    );
    observedSectionIds.add(sectionMatches[0]);
  }
  assert.deepEqual(
    [...observedSectionIds].sort(),
    [
      'data-section="mcp-activity"',
      'data-section="mcp-configuration"',
      'data-section="mcp-connection-health"',
      'data-section="mcp-errors-logs"',
      'data-section="mcp-overview"',
      'data-section="mcp-prompts"',
      'data-section="mcp-resources"',
      'data-section="mcp-role-access"',
      'data-section="mcp-tools"'
    ].sort()
  );
});

test("TabNav and tab helpers render accessible native links and fall back for unknown tab ids", () => {
  const tabs = [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta" }
  ];
  assert.equal(resolveActiveTabId(tabs, "beta", "alpha"), "beta");
  assert.equal(resolveActiveTabId(tabs, "unknown", "alpha"), "alpha");
  assert.equal(resolveActiveTabId(tabs, undefined, "alpha"), "alpha");
  assert.equal(tabHref("/x", "beta"), "/x?tab=beta");
  assert.equal(tabHref("/x", "beta", "view"), "/x?view=beta");
  assert.equal(
    tabHref("/x", "tab value", "view name"),
    "/x?view%20name=tab%20value"
  );

  const markup = renderToStaticMarkup(
    React.createElement(TabNav, {
      navLabel: "Test tabs",
      basePath: "/x",
      tabs,
      activeTabId: "beta"
    })
  );
  assert.match(markup, /<nav aria-label="Test tabs"/);
  assert.match(markup, /href="\/x\?tab=alpha"/);
  assert.match(markup, /href="\/x\?tab=beta"/);
  const activeCurrentMatches = markup.match(/aria-current="page"/g) ?? [];
  assert.equal(activeCurrentMatches.length, 1);
  assert.match(markup, /aria-current="page"[^>]*data-tab-item="beta"/);
});

test("McpDetailView labels execution-contract role assignments as configured access, not runtime exposure", () => {
  const server: McpServerResource = {
    name: "lsp",
    enabled: true,
    transport: "stdio",
    declared: true,
    roles: [],
    targetOverrides: []
  };
  const markup = renderToStaticMarkup(
    React.createElement(McpDetailView, {
      sourceValidity: true,
      configuredTools: [],
      server,
      activeTab: "role-access"
    })
  );
  assert.match(markup, /Configured role access/);
  assert.match(markup, /No roles assigned to this server/);
  assert.equal(markup.includes("runtime projection"), false);
});

test("McpsView renders an explicit empty configured-role scope", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpsView, {
      servers: [
        {
          name: "lsp",
          enabled: true,
          transport: "stdio",
          declared: true,
          roles: [],
          targetOverrides: []
        }
      ],
      sourceValidity: true,
      validationIssues: []
    })
  );
  assert.match(markup, /Configured roles/);
  assert.match(markup, /No roles assigned/);
});

test("McpsView distinguishes invalid canonical configuration from an empty list", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpsView, {
      servers: [],
      sourceValidity: false,
      validationIssues: []
    })
  );
  assert.match(markup, /data-mcp-source-validity="false"/);
  assert.match(markup, /RuleSync source invalid/);
  assert.match(markup, /Configured MCPs/);
  assert.match(markup, />Invalid</);
  assert.match(markup, /no MCP configuration was projected/);
  assert.doesNotMatch(markup, /Configured MCPs[\s\S]*?>0</);
});

test("SkillsView never reports 'Active' or 'Recorded' without OTel evidence", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [
        {
          name: "orchestration",
          description: "Coordination",
          path: ".rulesync/skills/orchestration"
        }
      ],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["orchestrator"],
      executionContractRevision: "c".repeat(64)
    })
  );
  assert.equal(markup.includes("Active"), false);
  assert.equal(markup.includes("Recorded"), false);
  assert.match(markup, /data-skill-runtime-observed="false"/);
});

test("SkillsView distinguishes declared role scope from missing eligibility evidence", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [
        { name: "assigned", description: "", path: "assigned" },
        { name: "unscoped", description: "", path: "unscoped" },
        { name: "unobserved", description: "", path: "unobserved" }
      ],
      eligibility: [
        { skill: "assigned", roles: ["orchestrator"] },
        { skill: "unscoped", roles: [] }
      ],
      unresolvedAssignments: [{ skill: "missing", roles: ["worker"] }],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["orchestrator", "worker"],
      executionContractRevision: "c".repeat(64)
    })
  );
  assert.match(markup, /Role-assigned/);
  assert.match(markup, /of 3 configured/);
  assert.match(markup, /orchestrator/);
  assert.match(markup, /No roles assigned/);
  assert.match(markup, /Not observed/);
  assert.equal(markup.includes("Universal / All"), false);
  assert.match(markup, /Unresolved role assignments/);
  assert.match(markup, /Assigned to: worker/);
});

test("SkillsView does not synthesize empty catalog counts for an unavailable RuleSync source", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: null,
      validationIssues: [],
      assignmentRoles: ["orchestrator"],
      executionContractRevision: "c".repeat(64)
    })
  );
  assert.match(markup, /data-skill-source-validity="not-observed"/);
  assert.match(markup, /RuleSync `.rulesync\/skills\/` has not been observed/);
  assert.match(markup, /Not observed/);
  assert.doesNotMatch(markup, /Configured[\s\S]*?>0</);
  assert.match(markup, /RuleSync `.rulesync\/skills\/` was not observed/);
});

test("WorkspacesView keeps availability and unconfigured role scope explicit", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspacesView, {
      workspaces: [
        {
          id: "SimulatorLife/AutoDev",
          baseBranch: "main",
          enabled: true,
          agentRoles: null
        },
        {
          id: "SimulatorLife/Other",
          baseBranch: "main",
          enabled: false,
          agentRoles: []
        }
      ]
    })
  );
  assert.equal(markup.includes("Available"), false);
  assert.equal(markup.includes("All roles"), false);
  assert.match(markup, /data-workspace-availability-observed="false"/);
  assert.match(markup, /Configuration, not runtime availability/);
  assert.match(markup, /Enablement/);
  assert.equal((markup.match(/data-status="not-observed"/gu) ?? []).length, 2);
  assert.equal((markup.match(/data-status="configured"/gu) ?? []).length, 2);
  assert.match(markup, /data-role-scope="not-configured">Not configured/);
  assert.match(markup, /data-role-scope="empty">No roles assigned/);
  assert.match(markup, />Enabled</);
  assert.match(markup, />Disabled</);
});

test("GithubView renders parsed workflow triggers and keeps Actions API facts explicitly unavailable", () => {
  const workflows: readonly GithubWorkflowDefinition[] = [
    {
      id: "_scheduler.yml",
      name: "scheduler",
      path: ".github/workflows/_scheduler.yml",
      events: ["schedule", "workflow_dispatch"],
      schedules: ["*/15 * * * *"]
    },
    {
      id: "agent-invoke.yml",
      name: null,
      path: ".github/workflows/agent-invoke.yml",
      events: ["workflow_call"],
      schedules: []
    }
  ];
  const markup = renderToStaticMarkup(
    React.createElement(GithubView, { workflows })
  );

  // Observed definition facts render as real content.
  assert.ok(markup.includes("scheduler"));
  assert.ok(markup.includes("*/15 * * * *"));
  assert.ok(markup.includes(".github/workflows/_scheduler.yml"));
  assert.ok(markup.includes("workflow_call"));
  assert.ok(markup.includes("No schedule trigger"));

  // Unobserved runtime facts must never be synthesized as live/healthy.
  assert.equal(markup.includes("Enabled"), false);
  assert.equal(markup.includes("Active"), false);
  assert.match(markup, /data-github-actions-facts-observed="false"/);
  assert.ok(markup.includes("Unavailable"));
  assert.ok(
    markup.includes("GitHub Actions API") || markup.includes("Actions API")
  );

  // No dispatch/cancel/rerun/schedule controls ship in this slice.
  assert.equal(markup.includes("<button"), false);
});

test("GithubView renders an explicit empty state with no workflow definitions", () => {
  const markup = renderToStaticMarkup(
    React.createElement(GithubView, { workflows: [] })
  );
  assert.ok(markup.includes("No workflow definitions were found."));
});

test("GithubView renders authoritative read-only GitHub Actions runtime state and scoped stats when observed", () => {
  const workflows: readonly GithubWorkflowDefinition[] = [
    {
      id: "_scheduler.yml",
      name: "scheduler",
      path: ".github/workflows/_scheduler.yml",
      events: ["schedule", "workflow_dispatch"],
      schedules: ["*/15 * * * *"],
      actionsState: "active",
      actionsWorkflowId: 101,
      actionsHtmlUrl:
        "https://github.com/SimulatorLife/AutoDev/actions/workflows/_scheduler.yml",
      recentRunsCount: 2,
      lastRunStatus: "completed",
      lastRunConclusion: "success",
      lastRunCreatedAt: "2026-10-04T05:00:00Z",
      lastRunHtmlUrl:
        "https://github.com/SimulatorLife/AutoDev/actions/runs/5001"
    },
    {
      id: "agent-invoke.yml",
      name: "Agent Invoke",
      path: ".github/workflows/agent-invoke.yml",
      events: ["workflow_call"],
      schedules: [],
      actionsState: "disabled_manually",
      actionsWorkflowId: 102,
      actionsHtmlUrl:
        "https://github.com/SimulatorLife/AutoDev/actions/workflows/agent-invoke.yml",
      recentRunsCount: 0,
      lastRunStatus: null,
      lastRunConclusion: null,
      lastRunCreatedAt: null,
      lastRunHtmlUrl: null
    }
  ];

  const markup = renderToStaticMarkup(
    React.createElement(GithubView, {
      workflows,
      runtimeFactsAvailable: true,
      runtimeStatus: "available",
      repository: "SimulatorLife/AutoDev",
      stats: {
        totalRuns: 1,
        successfulRuns: 1,
        failedRuns: 0,
        inProgressRuns: 0,
        cancelledRuns: 0,
        successRate: 1
      },
      recentRuns: [
        {
          id: 5001,
          name: "scheduler",
          workflowId: 101,
          workflowPath: ".github/workflows/_scheduler.yml",
          headBranch: "main",
          headSha: "c47aeaa297b555fbd0b3cf961028bc8ae06485ed",
          event: "schedule",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://github.com/SimulatorLife/AutoDev/actions/runs/5001",
          createdAt: "2026-10-04T05:00:00Z",
          updatedAt: "2026-10-04T05:05:00Z",
          runAttempt: 1
        }
      ]
    })
  );

  // Observed facts and indicators
  assert.match(markup, /data-github-actions-facts-observed="true"/);
  assert.ok(markup.includes("Actions API Connected"));
  assert.ok(markup.includes("SimulatorLife/AutoDev"));
  assert.ok(markup.includes("Active"));
  assert.ok(markup.includes("Disabled (Manual)"));

  // Statistics
  assert.ok(markup.includes("Recent Workflow Runs"));
  assert.ok(markup.includes(">1<"));
  assert.ok(markup.includes("most recent 1 returned run"));
  assert.ok(markup.includes("not total-history counts"));
  assert.ok(markup.includes("Recent Success Rate"));
  assert.ok(markup.includes(">100%<"));

  // Recent run row
  assert.ok(markup.includes("#5001"));
  assert.ok(markup.includes("c47aeaa"));
  assert.ok(markup.includes("schedule"));

  // Distinguishes YAML schedule from observed state:
  assert.ok(markup.includes("*/15 * * * *"));
  assert.ok(markup.includes("No schedule trigger"));

  // Read-only: the page displays observations but exposes no browser mutation
  // affordances, including forms, buttons, or operator-action labels.
  assert.equal(markup.includes("<form"), false);
  assert.equal(markup.includes("<button"), false);
  assert.equal(markup.includes("Dispatch workflow"), false);
  assert.equal(markup.includes("Enable workflow"), false);
  assert.equal(markup.includes("Disable workflow"), false);
});

test("GithubView displays explicit unavailable notice without synthesizing zero or healthy values", () => {
  const markup = renderToStaticMarkup(
    React.createElement(GithubView, {
      workflows: [
        {
          id: "ci.yml",
          name: "CI",
          path: ".github/workflows/ci.yml",
          events: ["push"],
          schedules: []
        }
      ],
      runtimeFactsAvailable: false,
      runtimeStatus: "unavailable",
      runtimeMessage: "AUTODEV_GITHUB_TOKEN is not configured on the server."
    })
  );

  assert.match(markup, /data-github-actions-facts-observed="false"/);
  assert.ok(
    markup.includes("AUTODEV_GITHUB_TOKEN is not configured on the server.")
  );
  assert.ok(markup.includes("Unavailable"));
  assert.equal(markup.includes("Recent Success Rate"), false);
  assert.equal(markup.includes("Active Workflows"), false);
});

test("ToolsView renders explicit availability per tool with the catalog coverage banner", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      validity: "valid",
      usageLink: "/usage",
      filters: { source: "", role: "" },
      tools: [
        {
          name: "read_file",
          source: "native",
          sourceAuthority: "codex-native",
          availability: "configured",
          exposedRoles: ["orchestrator"]
        }
      ]
    })
  );
  assert.equal(markup.includes(">ready<"), false);
  assert.match(markup, /data-status="configured"/);
  assert.match(markup, /data-tools-coverage="partial"/);
  assert.match(
    markup,
    /Partial catalog: the execution-contract role projection is observed/
  );
  assert.doesNotMatch(markup, /Universal/);
  // The banner must carry real utility classes. It selects them through a
  // helper that returns a string, so it is exactly the shape of mistake that
  // emits the constant's *name* as the class and silently drops every style.
  assert.match(markup, new RegExp(`class="${CALLOUT_WARNING_CLASS}"`));
  assert.doesNotMatch(markup, /CALLOUT_[A-Z_]+_CLASS/);
});

test("ToolsView keeps an unavailable capability source unknown instead of zero", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "unknown",
      validity: "not-observed",
      usageLink: "/usage",
      filters: { source: "", role: "" },
      tools: []
    })
  );
  assert.match(markup, /Composite catalog/);
  assert.match(markup, />Not observed</);
  assert.match(markup, /The canonical RuleSync MCP source was not observed/);
  assert.doesNotMatch(markup, /Composite catalog[\s\S]*?>0</);
});

test("ToolsView surfaces availability through the StatusBadge vocabulary and never invents ready", () => {
  const configuredMarkup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      validity: "valid",
      usageLink: "/usage",
      filters: { source: "", role: "" },
      tools: [
        {
          name: "exec_command",
          source: "native",
          sourceAuthority: "codex-native",
          availability: "configured",
          exposedRoles: ["orchestrator"]
        }
      ]
    })
  );
  assert.match(configuredMarkup, /data-status="configured"/);

  const unavailableMarkup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      validity: "valid",
      usageLink: "/usage",
      filters: { source: "", role: "" },
      tools: [
        {
          name: "exec_command",
          source: "native",
          sourceAuthority: "codex-native",
          availability: "invalid",
          exposedRoles: ["orchestrator"]
        }
      ]
    })
  );
  assert.match(unavailableMarkup, /data-status="invalid"/);
});

test("MemoryPage requires a valid canonical workspace catalog before querying memory", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = saveConsolePageEnvironment();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-memory-page-"));
  const requests: string[] = [];
  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN = "memory-page-test-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return Response.json({
        schema: "autodev-control-workspaces-v1",
        source: "config/workspaces.json",
        readOnly: true,
        catalogStatus: "invalid",
        totalWorkspaces: 0,
        workspaces: []
      });
    };

    const markup = renderToStaticMarkup(
      await MemoryPage({ searchParams: Promise.resolve({}) })
    );
    assert.match(markup, /data-error-code="autodev_workspace_catalog_invalid"/);
    assert.match(markup, /no Memory scope is inferred/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.includes("/control/memory/"), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreConsolePageEnvironment(previousEnv);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("MemoryPage rejects URL workspace ids outside the canonical catalog before memory reads", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = saveConsolePageEnvironment();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-memory-page-"));
  const requests: string[] = [];
  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN = "memory-page-test-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return Response.json({
        schema: "autodev-control-workspaces-v1",
        source: "config/workspaces.json",
        readOnly: true,
        catalogStatus: "valid",
        totalWorkspaces: 1,
        workspaces: [
          {
            id: "SimulatorLife/AutoDev",
            baseBranch: "main",
            enabled: true,
            agentRoles: null
          }
        ]
      });
    };

    const markup = renderToStaticMarkup(
      await MemoryPage({
        searchParams: Promise.resolve({ workspaceId: "Unlisted/Repository" })
      })
    );
    assert.match(markup, /data-error-code="autodev_memory_workspace_unknown"/);
    assert.match(markup, /requested scope was not queried/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.includes("/control/memory/"), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreConsolePageEnvironment(previousEnv);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("MemoryPage reports failed experience history instead of rendering an empty list", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = saveConsolePageEnvironment();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-memory-page-"));
  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN = "memory-page-test-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/control/workspaces")) {
        return Response.json({
          schema: "autodev-control-workspaces-v1",
          source: "config/workspaces.json",
          readOnly: true,
          catalogStatus: "valid",
          totalWorkspaces: 1,
          workspaces: [
            {
              id: "SimulatorLife/AutoDev",
              baseBranch: "main",
              enabled: true,
              agentRoles: null
            }
          ]
        });
      }
      if (url.includes("/control/memory/records")) {
        return Response.json({
          schema: "autodev-memory-records-v1",
          items: [],
          total: 0,
          limit: 50,
          statusCounts: {
            proposed: 0,
            active: 0,
            superseded: 0,
            invalidated: 0,
            uncertain: 0
          },
          offset: 0,
          hasMore: false
        });
      }
      if (url.includes("/control/memory/experiences")) {
        return Response.json(
          {
            error: {
              code: "autodev_memory_unavailable",
              message: "Experience history is unavailable."
            }
          },
          { status: 503 }
        );
      }
      if (url.includes("/control/memory/cohorts")) {
        return Response.json({
          schema: "autodev-memory-session-outcome-cohorts-v1",
          workspaceId: "SimulatorLife/AutoDev",
          repositoryId: "SimulatorLife/AutoDev",
          occurredFrom: "2026-09-01T00:00:00Z",
          occurredUntil: "2026-10-01T00:00:00Z",
          cells: [],
          sessionCount: 0,
          reportedSessionCount: 0,
          unreportedSessionCount: 0,
          mixedModeSessionCount: 0,
          conflictingOutcomeSessionCount: 0
        });
      }
      throw new Error(`Unexpected Memory page request: ${url}`);
    };

    const markup = renderToStaticMarkup(
      await MemoryPage({
        searchParams: Promise.resolve({ tab: "experiences" })
      })
    );
    assert.match(markup, /data-status="unavailable"/);
    assert.match(markup, /Experience history is unavailable\./);
    assert.equal(
      markup.includes("No captured memory experiences found"),
      false
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreConsolePageEnvironment(previousEnv);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("EvaluationsPage loads the linked trace through the Usage token and keeps prompt scope", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = saveConsolePageEnvironment();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-evaluations-page-"));
  const requests: Array<{
    url: string;
    headers: Headers;
    method: string | undefined;
  }> = [];
  const spanId = "0123456789abcdef";
  const traceId = "0123456789abcdef0123456789abcdef";
  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN = "evaluation-control-test-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
    process.env.AUTODEV_OPENLIT_USAGE_TOKEN = "evaluation-usage-test-token";
    process.env.AUTODEV_OPENLIT_USAGE_URL = "http://127.0.0.1:3000";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        headers: new Headers(init?.headers),
        method: init?.method
      });
      if (url.endsWith("/control/evaluations")) {
        return Response.json({
          schema: "autodev-control-evaluations-v1",
          source: "openlit_evaluation",
          readOnly: true,
          totalEvaluations: 1,
          evaluations: [
            {
              id: "evaluation-1",
              spanId,
              agentRole: "orchestrator",
              promptName: "dry",
              model: "gpt-5.6-terra",
              metrics: [{ name: "quality", value: 1, pass: true }],
              passed: true,
              timestamp: "2026-10-05T12:00:00.000Z"
            }
          ]
        });
      }
      if (url.endsWith(`/api/autodev/usage/span/${spanId}`)) {
        return Response.json({
          schema: "autodev-openlit-trace-detail-v1",
          traceId,
          selectedSpanId: spanId,
          partial: false,
          spans: [
            {
              spanId,
              parentSpanId: null,
              spanName: "gen_ai.client_operation",
              serviceName: "autodev-router",
              timestamp: "2026-10-05T12:00:00.000Z",
              durationNs: 12_300_000,
              statusCode: "OK",
              spanAttributes: { prompt: "sensitive prompt value" }
            }
          ]
        });
      }
      throw new Error(`Unexpected Evaluations page request: ${url}`);
    };

    const markup = renderToStaticMarkup(
      await EvaluationsPage({
        searchParams: Promise.resolve({ prompt: "dry", spanId })
      })
    );
    assert.match(markup, /data-trace-state="observed"/);
    assert.match(markup, /Trace ID:/);
    assert.match(markup, /gen_ai\.client_operation/);
    assert.match(markup, /Root span/);
    assert.match(markup, /12\.3 ms/);
    assert.match(
      markup,
      /href="\/evaluations\?prompt=dry&amp;spanId=0123456789abcdef"/
    );
    assert.equal(markup.includes("sensitive prompt value"), false);
    assert.equal(requests.length, 2);
    assert.equal(
      requests[0]?.headers.get("authorization"),
      "Bearer evaluation-control-test-token"
    );
    assert.equal(requests[1]?.method, "GET");
    assert.equal(
      requests[1]?.headers.get("authorization"),
      "Bearer evaluation-usage-test-token"
    );
    assert.equal(markup.includes("evaluation-usage-test-token"), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreConsolePageEnvironment(previousEnv);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("EvaluationsPage rejects malformed trace query IDs without calling the Usage endpoint", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = saveConsolePageEnvironment();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-evaluations-page-"));
  let usageRequests = 0;
  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN = "evaluation-control-test-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
    process.env.AUTODEV_OPENLIT_USAGE_TOKEN = "evaluation-usage-test-token";
    process.env.AUTODEV_OPENLIT_USAGE_URL = "http://127.0.0.1:3000";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/control/evaluations")) {
        return Response.json({
          schema: "autodev-control-evaluations-v1",
          source: "openlit_evaluation",
          readOnly: true,
          totalEvaluations: 0,
          evaluations: []
        });
      }
      usageRequests += 1;
      throw new Error(`Unexpected trace lookup: ${url}`);
    };

    const markup = renderToStaticMarkup(
      await EvaluationsPage({
        searchParams: Promise.resolve({ spanId: "not-a-span-id" })
      })
    );
    assert.match(markup, /data-trace-state="invalid-span-id"/);
    assert.equal(usageRequests, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreConsolePageEnvironment(previousEnv);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("EvaluationsView with empty results renders the explicit empty state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationsView, { evaluations: [] })
  );
  assert.match(
    markup,
    /No evaluation results are present in the available history/
  );
  assert.match(markup, /data-evaluation-pass-rate-observed="false"/);
  assert.match(markup, /Not observed/);
  assert.equal(markup.includes("100%"), false);
});

test("EvaluationsView renders safe trace details and prompt-preserving span links", () => {
  const spanId = "0123456789abcdef";
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      evaluations: [],
      promptFilter: "dry",
      traceLookup: {
        kind: "observed",
        detail: {
          schema: "autodev-openlit-trace-detail-v1",
          traceId: "0123456789abcdef0123456789abcdef",
          selectedSpanId: spanId,
          partial: true,
          spans: [
            {
              spanId,
              parentSpanId: null,
              spanName: "gen_ai.client_operation",
              serviceName: "autodev-router",
              timestamp: "2026-10-05T12:00:00.000Z",
              durationNs: 1_250_000,
              statusCode: "OK"
            }
          ]
        }
      }
    })
  );
  assert.match(markup, /data-feature="evaluation-trace-detail"/);
  assert.match(markup, /data-trace-partial="true"/);
  assert.match(markup, /Trace ID:/);
  assert.match(markup, /gen_ai\.client_operation/);
  assert.match(markup, /autodev-router/);
  assert.match(
    markup,
    /href="\/evaluations\?prompt=dry&amp;spanId=0123456789abcdef"/
  );
  assert.match(markup, /Back to evaluations/);
});

test("EvaluationsView keeps a missing trace out of its empty-history state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      evaluations: [],
      traceLookup: { kind: "not-found" }
    })
  );
  assert.match(markup, /data-trace-state="not-found"/);
  assert.match(markup, /data-status="not-observed"/);
  assert.match(markup, /was not observed in retained telemetry/);
  assert.match(markup, /No evaluation results are present/);
});

test("EvaluationsView keeps missing verdicts unobserved", () => {
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      evaluations: [
        {
          id: "eval-unscored",
          agentRole: "orchestrator",
          model: "unknown",
          metrics: [{ name: "quality", value: 0.99, pass: null }],
          passed: null,
          timestamp: "2026-10-04 12:00:00"
        }
      ]
    })
  );
  assert.match(markup, /data-evaluation-pass-rate-observed="false"/);
  assert.match(markup, /Not observed/);
  assert.match(markup, /quality: 0\.99 · Not observed/);
  assert.equal(markup.includes(">Failed<"), false);
  assert.equal(markup.includes("99%"), false);
});

test("EvaluationsView links valid span references and marks invalid ones", () => {
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      evaluations: [
        {
          id: "eval-with-trace",
          spanId: "0123456789abcdef",
          agentRole: "orchestrator",
          model: "gpt-5.6-terra",
          metrics: [],
          passed: null,
          timestamp: "2026-10-04 12:00:00"
        },
        {
          id: "eval-without-otel-span",
          spanId: "offline_0123",
          agentRole: "worker",
          model: "unknown",
          metrics: [],
          passed: null,
          timestamp: "2026-10-04 12:01:00"
        }
      ]
    })
  );
  assert.match(
    markup,
    /href="\/evaluations\?spanId=0123456789abcdef"[^>]*data-evaluation-trace-span-id="0123456789abcdef"/
  );
  assert.match(markup, /Invalid reference/);
  assert.equal(
    markup.includes('data-evaluation-trace-span-id="offline_0123"'),
    false
  );
});

test("fetchEvaluations issues authenticated GET to /control/evaluations", async () => {
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "test-token-123"
  };
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(input, "http://127.0.0.1:4101/control/evaluations");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-token-123");
    assert.equal(headers.get("x-autodev-actor"), LOCAL_CONTROL_API_ACTOR);
    return Response.json({
      schema: "autodev-control-evaluations-v1",
      source: "openlit_evaluation",
      readOnly: true,
      totalEvaluations: 1,
      evaluations: [
        {
          id: "eval-1",
          spanId: "0123456789abcdef",
          agentRole: "orchestrator",
          promptName: "dry",
          model: "gpt-5.6-terra",
          metrics: [{ name: "relevance", value: 0.95, pass: true }],
          passed: true,
          timestamp: "2026-10-04 12:00:00"
        }
      ]
    });
  };
  const result = await fetchEvaluations(config, { fetchImpl: mockFetch });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.data.totalEvaluations, 1);
    assert.equal(result.data.evaluations[0]?.agentRole, "orchestrator");
    assert.equal(result.data.evaluations[0]?.spanId, "0123456789abcdef");
  }
});

test("fetchEvaluations preserves unavailable telemetry status", async () => {
  const result = await fetchEvaluations(
    {
      baseUrl: "http://127.0.0.1:4101",
      serviceToken: "test-token-123"
    },
    {
      fetchImpl: async () =>
        Response.json(
          {
            error: {
              code: "autodev_control_evaluations_unavailable",
              message:
                "Evaluation history is unavailable from the telemetry store."
            }
          },
          { status: 503 }
        )
    }
  );
  assert.equal(result.kind, "http-error");
  if (result.kind === "http-error") {
    assert.equal(result.status, 503);
    assert.equal(result.code, "autodev_control_evaluations_unavailable");
  }
});

test("Prompts fetcher validates source state and rejects stale contracts", async () => {
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "server-only"
  };
  const current = await fetchPrompts(config, {
    fetchImpl: async () =>
      Response.json({
        schema: "autodev-control-prompts-v2",
        source: ".rulesync/commands",
        readOnly: true,
        issues: [],
        valid: true,
        totalCommands: 1,
        commands: [
          {
            name: "dry",
            path: ".rulesync/commands/dry.md",
            description: "Run a dry pass."
          }
        ],
        rolePrompts: []
      })
  });
  assert.equal(current.kind, "ok");
  if (current.kind === "ok")
    assert.equal(current.data.commands[0]?.description, "Run a dry pass.");

  const stale = await fetchPrompts(config, {
    fetchImpl: async () =>
      Response.json({
        schema: "autodev-control-prompts-v1",
        source: "rulesync",
        readOnly: true,
        totalCommands: 1,
        commands: [],
        rolePrompts: []
      })
  });
  assert.equal(stale.kind, "invalid-response");
  if (stale.kind === "invalid-response") {
    assert.equal(stale.code, "autodev_control_api_invalid_prompts_response");
    assert.match(stale.message, /requires the v2 source-validity contract/);
  }
});

test("fetchGithubWorkflows issues authenticated GET to /control/github", async () => {
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "test-token-123"
  };
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(input, "http://127.0.0.1:4101/control/github");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-token-123");
    assert.equal(headers.get("x-autodev-actor"), LOCAL_CONTROL_API_ACTOR);
    return Response.json({
      schema: "autodev-control-github-v1",
      source: ".github/workflows",
      readOnly: true,
      catalogStatus: "valid",
      totalWorkflows: 1,
      runtimeFactsAvailable: false,
      // The Runtime emits the whole envelope on both the observed and the
      // unavailable path, so the fixture carries every one of these: a partial
      // fixture is what let a drifted payload pass unnoticed before the guard.
      runtimeStatus: "unavailable",
      runtimeMessage: "AUTODEV_GITHUB_TOKEN is not configured.",
      repository: null,
      stats: null,
      recentRuns: [],
      workflows: [
        {
          id: "_scheduler.yml",
          name: "scheduler",
          path: ".github/workflows/_scheduler.yml",
          events: ["schedule", "workflow_dispatch"],
          schedules: ["*/15 * * * *"]
        }
      ]
    });
  };
  const result = await fetchGithubWorkflows(config, { fetchImpl: mockFetch });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.data.catalogStatus, "valid");
    assert.equal(result.data.runtimeFactsAvailable, false);
    assert.equal(result.data.workflows[0]?.id, "_scheduler.yml");
    assert.deepEqual(result.data.workflows[0]?.schedules, ["*/15 * * * *"]);
  }
});

test("EvaluationsView renders metrics, pass rate, and outcome badges when evaluations exist", () => {
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      evaluations: [
        {
          id: "eval-1",
          agentRole: "orchestrator",
          promptName: "dry",
          model: "gpt-5.6-terra",
          metrics: [{ name: "relevance", value: 0.95, pass: true }],
          passed: true,
          timestamp: "2026-10-04 12:00:00"
        }
      ]
    })
  );
  assert.match(markup, /data-evaluation-pass-rate-observed="true"/);
  assert.match(markup, /100%/);
  assert.match(markup, /orchestrator/);
  assert.match(markup, /gpt-5\.6-terra/);
  assert.match(markup, /relevance: 0\.95/);
  assert.match(markup, /Passed/);
});

test("the metric chips wrap between items instead of clipping each to its prefix", () => {
  // Live rows carry two metrics whose names share a prefix -- `tool_calls` and
  // `tool_failures`. In a `flex` row that cannot wrap, both chips were clipped
  // inside their own boxes and rendered as `to…` and `to…`: two readings that
  // were the same reading twice, which is worse than either one being cut.
  //
  // Wrapping is the fix the target state asks for directly ("discrete cell
  // content ... wraps between items, never mid-token"), and it is also what
  // makes the column's width budget legible, since the budget now has to fit
  // one chip rather than half of two.
  const markup = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      evaluations: [
        {
          id: "eval-two-metrics",
          agentRole: "orchestrator",
          model: "gemini-3.8-flash-high",
          metrics: [
            { name: "tool_calls", value: 14, pass: true },
            { name: "tool_failures", value: 4, pass: false }
          ],
          passed: false,
          timestamp: "2026-10-05T09:48:00.000Z"
        }
      ]
    })
  );

  assert.match(markup, /flex flex-wrap/, "metric chips must be able to wrap");
  // Each metric keeps its own full text, so a clipped chip is still told apart
  // from its neighbour by the name rather than by position.
  assert.match(markup, /tool_calls: 14 · Passed/);
  assert.match(markup, /tool_failures: 4 · Failed/);
});

const PROVIDERS_FIXTURE: ControlApiProvidersResponse = {
  schema: "autodev-control-providers-v2",
  orchestratorTier: "orchestrator",
  tiers: [
    { tier: "default", groups: [["claude"], ["codex"]] },
    { tier: "orchestrator", groups: [["codex"], ["claude"]] }
  ],
  providers: [
    {
      id: "claude",
      disabled: false,
      agentLimits: { perSession: 3, acrossSessions: 8 },
      route: {
        pattern: "^(sonnet|claude-[a-z0-9-]*[a-z0-9])$",
        baseUrl: "http://127.0.0.1:4000/v1",
        healthUrl: "http://127.0.0.1:4000/health/liveliness"
      },
      credential: { envKey: "LITELLM_API_KEY", configured: false },
      roles: {
        default: {
          priority: 1,
          model: "sonnet",
          mutable: true,
          convergence: {
            convergence: "converged",
            desiredGeneration: "default:1/sonnet",
            observedGeneration: "default:1/sonnet",
            lastApplyAt: "2026-10-05T15:00:00.000Z",
            lastObservationAt: "2026-10-05T15:00:00.000Z",
            lastError: null,
            explanation: "Converged."
          }
        },
        smart: {
          priority: 2,
          model: "claude-opus-5-5",
          mutable: true,
          convergence: {
            convergence: "converged",
            desiredGeneration: "smart:2/claude-opus-5-5",
            observedGeneration: "smart:2/claude-opus-5-5",
            lastApplyAt: "2026-10-05T15:00:00.000Z",
            lastObservationAt: "2026-10-05T15:00:00.000Z",
            lastError: null,
            explanation: "Converged."
          }
        },
        orchestrator: {
          priority: 1,
          model: "claude-opus-5-5",
          mutable: true,
          convergence: {
            convergence: "converged",
            desiredGeneration: "orchestrator:1/claude-opus-5-5",
            observedGeneration: "orchestrator:1/claude-opus-5-5",
            lastApplyAt: "2026-10-05T15:00:00.000Z",
            lastObservationAt: "2026-10-05T15:00:00.000Z",
            lastError: null,
            explanation: "Converged."
          }
        },
        subagent: {
          priority: 2,
          model: "sonnet",
          mutable: true,
          convergence: {
            convergence: "converged",
            desiredGeneration: "subagent:2/sonnet",
            observedGeneration: "subagent:2/sonnet",
            lastApplyAt: "2026-10-05T15:00:00.000Z",
            lastObservationAt: "2026-10-05T15:00:00.000Z",
            lastError: null,
            explanation: "Converged."
          }
        }
      },
      models: [
        { tier: "default", model: "sonnet" },
        { tier: "orchestrator", model: "claude-opus-5-5" }
      ],
      priorities: [
        { tier: "default", group: 1 },
        { tier: "orchestrator", group: 2 }
      ],
      orchestratorReasoningEffort: "medium",
      health: {
        cooldown: {
          kind: "transient",
          failureClass: "session_limit",
          until: "2026-10-05T16:00:00.000Z",
          resetsAt: null,
          lastResortEligible: true
        },
        failureStreak: 2,
        probeFailureStreak: 0,
        inFlightRequests: 1,
        activeAgents: 1,
        attempts: 10,
        successes: 8,
        failures: 2,
        lastSuccessAt: "2026-10-05T15:00:00.000Z",
        lastFailure: {
          at: "2026-10-05T15:30:00.000Z",
          failureClass: "session_limit",
          status: 429
        }
      }
    },
    {
      id: "codex",
      disabled: true,
      agentLimits: { perSession: null, acrossSessions: null },
      route: {
        pattern: "^gpt-.*$",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        healthUrl: null
      },
      credential: { envKey: null, configured: true },
      roles: {
        default: {
          priority: 2,
          model: "gpt-6-luna",
          mutable: true,
          convergence: {
            convergence: "pending",
            desiredGeneration: "default:2/gpt-6-luna",
            observedGeneration: null,
            lastApplyAt: "2026-10-05T15:30:00.000Z",
            lastObservationAt: null,
            lastError: null,
            explanation: "Pending observation."
          }
        },
        smart: {
          priority: 2,
          model: "gpt-6-luna",
          mutable: true,
          convergence: {
            convergence: "pending",
            desiredGeneration: "smart:2/gpt-6-luna",
            observedGeneration: null,
            lastApplyAt: "2026-10-05T15:30:00.000Z",
            lastObservationAt: null,
            lastError: null,
            explanation: "Pending observation."
          }
        },
        orchestrator: {
          priority: "disabled",
          model: null,
          mutable: true,
          convergence: {
            convergence: "converged",
            desiredGeneration: "orchestrator:disabled/none",
            observedGeneration: "orchestrator:disabled/none",
            lastApplyAt: "2026-10-05T15:30:00.000Z",
            lastObservationAt: "2026-10-05T15:30:00.000Z",
            lastError: null,
            explanation: "Converged."
          }
        },
        subagent: {
          priority: 3,
          model: "gpt-6-luna",
          mutable: false,
          convergence: {
            convergence: "not-observed",
            desiredGeneration: null,
            observedGeneration: null,
            lastApplyAt: null,
            lastObservationAt: null,
            lastError: null,
            explanation: "Not observed."
          }
        }
      },
      models: [
        { tier: "default", model: "gpt-6-luna" },
        { tier: "orchestrator", model: "gpt-6-luna" }
      ],
      priorities: [
        { tier: "default", group: 2 },
        { tier: "orchestrator", group: 1 }
      ],
      orchestratorReasoningEffort: null,
      health: null
    }
  ]
};

const MODELS_FIXTURE: ControlApiModelsResponse = {
  schema: "autodev-control-models-v2",
  source: "model-routing.json",
  models: [
    {
      id: "claude-opus-5-5",
      provider: "claude",
      tiers: ["orchestrator"],
      displayName: null,
      enablement: {
        enabled: true,
        mutable: true,
        convergence: {
          convergence: "converged",
          desiredGeneration: "enabled=true",
          observedGeneration: "enabled=true",
          lastApplyAt: "2026-10-05T15:00:00.000Z",
          lastObservationAt: "2026-10-05T15:00:00.000Z",
          lastError: null,
          explanation: "Converged."
        }
      }
    },
    {
      id: "sonnet",
      provider: "claude",
      tiers: ["default"],
      displayName: "Claude Sonnet subscription",
      // Never written through the Control API, so the Runtime reports no
      // observation. The model being disabled is a separate, evidenced fact.
      enablement: {
        enabled: false,
        mutable: true,
        convergence: {
          convergence: "not-observed",
          desiredGeneration: "enabled=false",
          observedGeneration: "enabled=false",
          lastApplyAt: null,
          lastObservationAt: null,
          lastError: null,
          explanation: "Not observed."
        }
      }
    },
    {
      id: "gpt-6-luna",
      provider: "codex",
      tiers: ["default", "orchestrator"],
      displayName: "GPT-6 Luna",
      enablement: {
        enabled: true,
        mutable: true,
        convergence: {
          convergence: "pending",
          desiredGeneration: "enabled=true",
          observedGeneration: null,
          lastApplyAt: "2026-10-06T09:30:00.000Z",
          lastObservationAt: null,
          lastError: null,
          explanation: "Applied, awaiting observation."
        }
      }
    }
  ]
};

function formTags(markup: string): string[] {
  return Array.from(markup.matchAll(/<form\b[^>]*>/gu), (match) => match[0]);
}

function hiddenValue(
  markup: string,
  form: string,
  name: string
): string | null {
  const start = markup.indexOf(form);
  const end = markup.indexOf("</form>", start);
  const match = new RegExp(`name="${name}" value="([^"]*)"`, "u").exec(
    markup.slice(start, end)
  );
  return match?.[1] ?? null;
}

test("AgentsView shows read-only provider summaries that link to Providers", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentsView, {
      agents: [CONFIGURED_AGENT],
      providers: PROVIDERS_FIXTURE,
      runtime: {
        schema: "autodev-control-runtime-v1",
        routerInstanceId: "router-uuid-test",
        lifecycle: {
          state: "ready",
          draining: false,
          changedAt: "2026-10-05T15:00:00.000Z",
          activeResponseRequests: 1
        },
        concurrency: { effectivePerSessionLimit: 2, activeSubagentThreads: 1 },
        inFlightRequestCount: 1
      }
    })
  );
  assert.match(markup, /data-section="configured-agents"/);
  assert.match(markup, /data-section="runtime-health"/);
  assert.match(markup, /router-uuid-test/);
  assert.match(markup, /data-agent-providers="orchestrator"/);
  assert.match(markup, /href="\/providers\/codex"/);
  // codex is disabled for the orchestrator role the agent runs as. The summary
  // carries that as a status mark rather than a spelled-out badge, so density
  // does not cost the state: it must stay available to assistive technology
  // and as a hover title.
  assert.match(markup, /aria-label="Disabled"/);
  assert.match(markup, /data-status="unavailable"/);
  // Provider controls and routing live in Providers, not Agents.
  assert.equal(markup.includes("<form"), false);
  assert.equal(markup.includes('data-section="providers-routing"'), false);
  assert.equal(markup.includes("chatgpt.com"), false);
});

test("AgentDetailView renders a read-only provider summary and concurrency details", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentDetailView, {
      agent: CONFIGURED_AGENT,
      providers: PROVIDERS_FIXTURE
    })
  );
  assert.match(markup, /data-section="agent-providers"/);
  assert.match(markup, /data-section="agent-concurrency"/);
  assert.match(markup, /href="\/providers\/codex"/);
  assert.match(markup, /Provider controls and routing live in Providers/);
  assert.match(markup, /Session concurrency limit/);
  assert.equal(markup.includes("<form"), false);
});

test("Agents provider summaries stay not observed without provider configuration", () => {
  const agentsMarkup = renderToStaticMarkup(
    React.createElement(AgentsView, {
      agents: [CONFIGURED_AGENT]
    })
  );
  const summaryStart = agentsMarkup.indexOf("data-agent-providers=");
  const summaryEnd = agentsMarkup.indexOf("</ul>", summaryStart);
  const summary = agentsMarkup.slice(summaryStart, summaryEnd);
  assert.match(summary, /data-status="not-observed"/);
  assert.equal(summary.includes(">Enabled<"), false);
  assert.equal(summary.includes(">Disabled<"), false);

  const detailMarkup = renderToStaticMarkup(
    React.createElement(AgentDetailView, { agent: CONFIGURED_AGENT })
  );
  const detailStart = detailMarkup.indexOf('data-section="agent-providers"');
  const detailEnd = detailMarkup.indexOf('data-section="agent-concurrency"');
  const detail = detailMarkup.slice(detailStart, detailEnd);
  assert.match(detail, /data-status="not-observed"/);
  assert.equal(detail.includes(">Enabled<"), false);
  assert.equal(detail.includes(">Disabled<"), false);
});

test("HooksView only renders hooks with valid action command lists", () => {
  const hooks = hooksFromControlApi({
    schema: "autodev-control-hooks-v1",
    source: "test",
    readOnly: true,
    valid: true,
    issues: [],
    hooks: {
      sessionStart: [{ command: "echo hi", matcher: ".*" }]
    }
  });
  const markup = renderToStaticMarkup(
    React.createElement(HooksView, {
      hooks,
      sourceValidity: true,
      validationIssues: []
    })
  );
  assert.match(markup, /echo hi/);
  assert.match(markup, /Source validation/);
  assert.doesNotMatch(
    markup,
    /data-validation-issue-count/,
    "a valid source has no faults, and a panel saying so would add nothing"
  );
});

test("HooksView reports source validity as unknown when no validation is available", () => {
  const markup = renderToStaticMarkup(
    React.createElement(HooksView, { hooks: [], validationIssues: [] })
  );
  assert.match(markup, /data-hook-state="not-observed"/);
  assert.equal(markup.includes(">Valid<"), false);
});

test("HooksView names the fault the Runtime located instead of only calling the source invalid", () => {
  const markup = renderToStaticMarkup(
    React.createElement(HooksView, {
      hooks: [],
      sourceValidity: false,
      validationIssues: [
        {
          location: "SessionStart action 2",
          message:
            'Action 2 of "SessionStart" is not a command hook with a non-empty command string.'
        },
        {
          location: "PreCompact",
          message: '"PreCompact" is not a known hook event.'
        }
      ]
    })
  );
  assert.match(markup, /data-validation-issue-count="2"/);
  assert.match(markup, /data-validation-issue="SessionStart action 2"/u);
  assert.match(
    markup,
    /is not a command hook with a non-empty command string/u
  );
  assert.match(markup, /data-validation-issue="PreCompact"/u);
  assert.match(markup, /is not a known hook event/u);
  // The count is in the empty-state line too, so an operator reading only the
  // hook list still learns there were two faults and not one.
  assert.match(markup, /2 problems found/);
});

test("an empty list names its resource instead of inheriting a generic sentence", () => {
  // DataTable used to default `emptyMessage` to "No items to display.", and
  // fifteen of the seventeen list views overrode it -- the two that did not
  // rendered a sentence naming no resource at all, and the next list view added
  // would have inherited it silently. `emptyMessage` is now required, so the
  // typecheck is the guard; this pins the rendered outcome and keeps the
  // retired default from coming back.
  const agents = renderToStaticMarkup(
    React.createElement(AgentsView, { agents: [] })
  );
  assert.match(agents, /No agents are configured\./u);

  const permissions = renderToStaticMarkup(
    React.createElement(PermissionsView, {
      policy: {
        approvalPolicy: "on-demand",
        sandboxMode: "workspace-write",
        approvalsReviewer: "user",
        networkAccess: true,
        webSearch: true,
        defaultToolsApprovalMode: "approve"
      },
      roleMatrices: []
    })
  );
  assert.match(permissions, /No role capability matrices were observed\./u);

  for (const markup of [agents, permissions]) {
    assert.match(markup, /data-empty-state="table"/u);
    assert.doesNotMatch(markup, /No items to display\./u);
  }

  // Coverage is asserted rather than assumed: an unreadable directory would
  // make the scan below pass without having looked at anything.
  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const scanned: string[] = [];
  const offenders: string[] = [];
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const file = join(featuresDir, relative.toString());
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    scanned.push(file);
    if (readFileSync(file, "utf8").includes("No items to display.")) {
      offenders.push(relative.toString());
    }
  }
  assert.ok(
    scanned.length >= 20,
    "the scan must actually read the feature views"
  );
  assert.deepEqual(offenders, []);
});

test("View adapters translate Control API responses without inventing data", () => {
  const skillsResponse = {
    schema: "autodev-control-skills-v2" as const,
    source: ".rulesync/skills+execution-contract",
    readOnly: true,
    valid: true,
    executionContractRevision: "a".repeat(64),
    assignmentRoles: ["browser-tester", "validator"],
    skills: [
      {
        name: "playwright",
        description: "Run browser checks.",
        path: ".rulesync/skills/playwright/SKILL.md",
        roles: ["browser-tester", "validator"]
      },
      {
        name: "audit",
        description: "Audit catalog state.",
        path: ".rulesync/skills/audit/SKILL.md",
        roles: []
      }
    ],
    unresolvedAssignments: [{ name: "missing", roles: ["worker"] }],
    issues: []
  };
  const skills = skillsFromControlApi(skillsResponse);
  assert.deepEqual(skills[0], {
    name: "playwright",
    description: "Run browser checks.",
    path: ".rulesync/skills/playwright/SKILL.md"
  });
  assert.deepEqual(skillEligibilityFromControlApi(skillsResponse), [
    { skill: "playwright", roles: ["browser-tester", "validator"] },
    { skill: "audit", roles: [] }
  ]);
  assert.deepEqual(unresolvedSkillAssignmentsFromControlApi(skillsResponse), [
    { skill: "missing", roles: ["worker"] }
  ]);

  const prompts = promptsFromControlApi({
    schema: "autodev-control-prompts-v2",
    source: ".rulesync/commands",
    readOnly: true,
    issues: [],
    valid: true,
    totalCommands: 1,
    commands: [
      { name: "dry", path: ".rulesync/commands/dry.md", description: "DRY" }
    ],
    rolePrompts: [
      {
        role: "orchestrator",
        path: "agents/prompts/roles/orchestrator.md"
      }
    ]
  });
  assert.equal(prompts[0]?.name, "dry");
  assert.equal(prompts[1]?.name, "orchestrator");

  const promptDocument = promptDocumentFromControlApi({
    schema: "autodev-control-prompt-detail-v4",
    name: "dry",
    type: "command",
    source: ".rulesync/commands/dry.md",
    content: "Exact source",
    preview: "Parsed prompt body",
    revision: "b".repeat(64),
    diff: {
      summary: "Canonical RuleSync command.",
      identifier: "b".repeat(64)
    },
    reconciliation: {
      status: {
        convergence: "converged",
        desiredGeneration: "b".repeat(64),
        observedGeneration: "b".repeat(64),
        lastApplyAt: "2026-01-01T00:00:00.000Z",
        lastObservationAt: "2026-01-01T00:00:00.000Z",
        lastError: null,
        explanation: "Converged."
      },
      history: []
    }
  });
  assert.deepEqual(promptDocument, {
    name: "dry",
    kind: "command",
    path: ".rulesync/commands/dry.md",
    content: "Exact source",
    preview: "Parsed prompt body",
    revision: "b".repeat(64)
  });

  const workspaces = workspacesFromControlApi({
    schema: "autodev-control-workspaces-v1",
    source: "test",
    readOnly: true,
    catalogStatus: "valid",
    totalWorkspaces: 1,
    workspaces: [
      {
        id: "SimulatorLife/AutoDev",
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      }
    ]
  });
  assert.equal(workspaces[0]?.id, "SimulatorLife/AutoDev");

  const perms = permissionsFromControlApi({
    schema: "autodev-control-permissions-v1",
    source: "test",
    readOnly: true,
    policy: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
      networkAccess: true,
      webSearch: true,
      defaultToolsApprovalMode: "approve"
    },
    rolePermissions: {
      orchestrator: {
        readOnly: false,
        sandbox: "workspace-write",
        networkAccess: true,
        approvals: "never",
        mcp: ["cocoindex-code", "lsp"],
        mcpTools: { lsp: ["lsp_find_symbol", "lsp_goto_definition"] },
        skills: ["autodev-session-diagnostics", "ccc"]
      }
    }
  });
  assert.equal(perms.roleMatrices[0]?.sandboxMode, "workspace-write");
  // The effective capability matrix must be the projected list, never a
  // placeholder empty list the UI would render as "None".
  assert.deepEqual(perms.roleMatrices[0]?.allowedMcpServers, [
    "cocoindex-code",
    "lsp"
  ]);
  assert.deepEqual(perms.roleMatrices[0]?.allowedSkills, [
    "autodev-session-diagnostics",
    "ccc"
  ]);
});

test("the capability matrix lists the fixed roles in the one order the app uses", () => {
  // The matrix sorted roles alphabetically, so it showed `orchestrator` before
  // `smart` -- an order the target state does not use anywhere. It fixes the
  // sequence as Default, Smart, Orchestrator, Subagent and calls them the
  // canonical roles.
  //
  // `AgentRole` is an open union, so a Runtime may report roles outside the
  // four. Those must stay visible -- dropping a role the API sent would hide
  // evidence -- but they rank after the fixed four and keep a deterministic
  // order among themselves, so the table cannot churn between reads.
  const role = () => ({
    readOnly: true,
    sandbox: "workspace-write",
    networkAccess: true,
    approvals: "user",
    mcp: [],
    mcpTools: {},
    skills: []
  });
  const ordered = permissionsFromControlApi({
    schema: "autodev-control-permissions-v1",
    source: "test",
    readOnly: true,
    policy: {
      approvalPolicy: "on-demand",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
      networkAccess: true,
      webSearch: true,
      defaultToolsApprovalMode: "approve"
    },
    // Deliberately scrambled, plus two roles outside the fixed four.
    rolePermissions: {
      subagent: role(),
      worker: role(),
      orchestrator: role(),
      explorer: role(),
      smart: role(),
      default: role()
    }
  }).roleMatrices.map((matrix) => matrix.role);

  assert.deepEqual(ordered, [
    "default",
    "smart",
    "orchestrator",
    "subagent",
    "explorer",
    "worker"
  ]);
});

test("the policy cards read as prose rather than raw config values", () => {
  // Three cards in that row render words -- "Workspace write", "Allowed",
  // "Enabled" -- and the fourth rendered the enum itself, so `on-demand`
  // appeared on the page in display-sized type as `on-demand`.
  for (const [approvalPolicy, expected] of [
    ["on-demand", "On demand"],
    ["always", "Always"],
    ["never", "Never"]
  ] as const) {
    const markup = renderToStaticMarkup(
      React.createElement(PermissionsView, {
        policy: {
          approvalPolicy,
          sandboxMode: "workspace-write",
          approvalsReviewer: "user",
          networkAccess: true,
          webSearch: true,
          defaultToolsApprovalMode: "approve"
        },
        roleMatrices: []
      })
    );
    assert.match(markup, new RegExp(`>${expected}<`, "u"));
    assert.doesNotMatch(markup, new RegExp(`>${approvalPolicy}<`, "u"));
  }
});

test("Every canonical Console route path maps to a canonical nav section", () => {
  for (const section of CANONICAL_NAVIGATION) {
    const path = canonicalNavPath(section);
    assert.equal(canonicalSectionFromPath(path), section);
  }
  assert.equal(canonicalSectionFromPath("/not-a-resource"), null);
});
test("Canonical nav order matches Configure/Observe/Operate grouping", () => {
  const expected: readonly CanonicalNavSection[] = [
    "Agents",
    "Providers",
    "MCPs",
    "Skills",
    "Hooks",
    "Prompts",
    "Permissions",
    "Tools",
    "Usage",
    "Evaluations",
    "Memory",
    "Workspaces",
    "GitHub"
  ];
  assert.deepEqual([...CANONICAL_NAVIGATION], [...expected]);
});

/**
 * A Memory list's address, for tests that render a Memory view directly.
 *
 * The views no longer assemble their own links from `workspaceId`/`query`
 * fragments, so a test has to state the list it is rendering. Defaults match
 * what `/memory` resolves to when the URL says nothing.
 */
function memoryListScope(
  overrides: Partial<MemoryListScope> = {}
): MemoryListScope {
  return {
    tab: "records",
    workspaceId: "SimulatorLife/AutoDev",
    from: "2026-09-01T00:00:00.000Z",
    until: "2026-10-01T00:00:00.000Z",
    limit: 50,
    offset: 0,
    ...overrides
  };
}

test("the Memory lifecycle vocabulary has one owner", () => {
  // These were three declarations split across two files — labels and order in
  // `MemoryView`, the tone map in `MemoryRecordsView` — plus a per-row label that
  // capitalized the wire key. Adding a sixth status could have updated one and
  // missed the other, and the rollup chart and the records table would then
  // disagree about the same record. `Record<MemoryStatus, …>` makes the gap a
  // typecheck failure; this asserts the tables agree and are actually used.
  assert.deepEqual(
    [...MEMORY_STATUS_ORDER].sort(),
    Object.keys(MEMORY_STATUS_LABEL).sort()
  );
  assert.deepEqual(
    [...MEMORY_STATUS_ORDER].sort(),
    Object.keys(MEMORY_STATUS_VARIANT).sort()
  );

  const recordFor = (status: MemoryRecord["status"]): MemoryRecord => ({
    id: "mem-vocab",
    kind: "procedural",
    status,
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "Vocabulary probe.",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  });

  for (const status of MEMORY_STATUS_ORDER) {
    const markup = renderToStaticMarkup(
      React.createElement(MemoryRecordsView, {
        records: [recordFor(status)],
        total: 1,
        listScope: memoryListScope()
      })
    );
    // Scoped to the row's own badge. Asserting `markup.includes("Active")` was
    // satisfied by the filter dropdown's `<option>Active</option>` — so this
    // exact bug, the badge wearing the tone's word instead of the lifecycle
    // state's, passed while every row on screen read "Ready".
    const badge =
      /data-status="([a-z-]+)"[^>]*>[\s\S]*?<span class="min-w-0 truncate">([^<]*)</u.exec(
        markup
      );
    assert.ok(badge !== null, `${status} should render a status badge`);
    assert.equal(
      badge[1],
      MEMORY_STATUS_VARIANT[status],
      `${status} should wear the ${MEMORY_STATUS_VARIANT[status]} tone`
    );
    assert.equal(
      badge[2],
      MEMORY_STATUS_LABEL[status],
      `${status} should read "${MEMORY_STATUS_LABEL[status]}", not the tone's word`
    );
  }
});

test("a Memory record shows its claim and scope instead of an ellipsis", () => {
  const claim =
    "The AutoDev Console is the single operator surface for every canonical resource in the monorepo.";
  const record = {
    id: "rec-prose",
    kind: "semantic",
    status: "active",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim,
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  };
  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [record],
      total: 1,
      listScope: memoryListScope()
    })
  );

  // The claim is the page. It was one truncating line, so every row of the
  // captured workspace read "The AutoDev Console is f…".
  assert.ok(markup.includes(claim), "the full claim should be in the markup");
  // `data-column-label` carries the column *id*, not its header text.
  const rowStart = markup.lastIndexOf("<tr", markup.indexOf(claim));
  const row = markup.slice(
    rowStart,
    markup.indexOf("</tr>", markup.indexOf(claim))
  );
  assert.ok(
    row.includes("line-clamp-2"),
    `the claim should clamp to two lines: ${row}`
  );
  // Scoped to the claim cell: the badge label and the Kind tag in the same row
  // legitimately carry `truncate`, and asserting on the whole row would be a
  // guard that can never pass.
  const claimCell = row.slice(
    row.indexOf("<td", row.indexOf("line-clamp-2") - 400)
  );
  assert.ok(
    !/\btruncate\b/u.test(
      claimCell.slice(0, claimCell.indexOf("line-clamp-2"))
    ),
    `the claim cell must not truncate: ${claimCell.slice(0, 200)}`
  );
  assert.ok(
    !markup.includes("max-w-md"),
    "the claim's fixed max width should be gone"
  );

  // The scope is a repository path and was capped at 150px, which its own
  // comment admitted "truncates on every row" in any real repository. The
  // separator stays on the first line and the break follows it.
  assert.ok(
    markup.includes("SimulatorLife/<wbr/>AutoDev"),
    "the scope should break after its separator"
  );
  assert.ok(!markup.includes("max-w-[150px]"), "the scope cap should be gone");
});

test("MemoryRecordsView renders records, lifecycle status badges, and claim text", () => {
  const sampleRecord: MemoryRecord = {
    id: "mem-001",
    kind: "procedural",
    status: "active",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "Always execute test suites before pushing code to main.",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: ["exp-1"],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [sampleRecord],
      total: 1,
      listScope: memoryListScope()
    })
  );

  assert.match(markup, /data-memory-record-id="mem-001"/);
  assert.match(markup, /data-memory-kind="procedural"/);
  assert.match(markup, /data-status="ready"/);
  assert.match(markup, /Active/);
  assert.match(
    markup,
    /Always execute test suites before pushing code to main\./
  );
});

test("MemoryRecordsView renders record detail panel with validity and transition history", () => {
  const sampleRecord: MemoryRecord = {
    id: "mem-002",
    kind: "semantic",
    status: "proposed",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim:
      "Use exact Optional Property Types throughout all TSX feature views.",
    validity: { state: "unverified", evidence: [] },
    provenance: {
      experienceIds: ["exp-1"],
      evidence: [
        {
          kind: "file",
          uri: "console/src/features/memory/MemoryRecordsView.ts"
        }
      ],
      createdBy: "agent-1",
      createdAt: "2026-10-02T00:00:00Z"
    },
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  };

  const sampleHistory = {
    schema: "autodev-memory-history-v1" as const,
    memory: sampleRecord,
    relatedMemories: [],
    // The Runtime's own lifecycle event, unchanged. This fixture used to be
    // written in the view's `{ actor, reason, timestamp }` spelling while the
    // route sent `{ actorId, reasonCode, occurredAt }`, so the fixture agreed
    // with the view and disagreed with the only producer.
    transitions: [
      {
        id: "event-001",
        memoryId: "mem-002",
        action: "proposed" as const,
        actorId: "operator-1",
        occurredAt: "2026-10-02T00:00:00Z",
        toStatus: "proposed" as const,
        reasonCode: "candidate_submitted" as const,
        evidence: [],
        relatedMemoryIds: []
      }
    ]
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [sampleRecord],
      total: 1,
      selectedRecord: sampleRecord,
      history: sampleHistory,
      listScope: memoryListScope()
    })
  );

  assert.match(markup, /data-selected-record-panel="mem-002"/);
  assert.match(markup, /Durable Claim/);
  assert.match(markup, /Validity State/);
  assert.match(markup, /Transition History/);
  // The transition carries the machine reason and the actor who made it.
  assert.match(markup, /Proposed for review/);
  assert.match(markup, /operator-1/);
  assert.match(markup, /Verify &amp; Promote/);
  assert.match(markup, /Invalidate/);
});

test("a Memory record shows its claim and scope instead of an ellipsis", () => {
  const claim =
    "The AutoDev Console is the single operator surface for every canonical resource in the monorepo.";
  const record = {
    id: "rec-prose",
    kind: "semantic",
    status: "active",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim,
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  };
  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [record],
      total: 1,
      listScope: memoryListScope()
    })
  );

  // The claim is the page. It was one truncating line, so every row of the
  // captured workspace read "The AutoDev Console is f…".
  assert.ok(markup.includes(claim), "the full claim should be in the markup");
  // `data-column-label` carries the column *id*, not its header text.
  const rowStart = markup.lastIndexOf("<tr", markup.indexOf(claim));
  const row = markup.slice(
    rowStart,
    markup.indexOf("</tr>", markup.indexOf(claim))
  );
  assert.ok(
    row.includes("line-clamp-2"),
    `the claim should clamp to two lines: ${row}`
  );
  // Scoped to the claim cell: the badge label and the Kind tag in the same row
  // legitimately carry `truncate`, and asserting on the whole row would be a
  // guard that can never pass.
  const claimCell = row.slice(
    row.indexOf("<td", row.indexOf("line-clamp-2") - 400)
  );
  assert.ok(
    !/\btruncate\b/u.test(
      claimCell.slice(0, claimCell.indexOf("line-clamp-2"))
    ),
    `the claim cell must not truncate: ${claimCell.slice(0, 200)}`
  );
  assert.ok(
    !markup.includes("max-w-md"),
    "the claim's fixed max width should be gone"
  );

  // The scope is a repository path and was capped at 150px, which its own
  // comment admitted "truncates on every row" in any real repository. The
  // separator stays on the first line and the break follows it.
  assert.ok(
    markup.includes("SimulatorLife/<wbr/>AutoDev"),
    "the scope should break after its separator"
  );
  assert.ok(!markup.includes("max-w-[150px]"), "the scope cap should be gone");
});

test("an experience's validation and outcome are named, not left as wire keys", () => {
  // Two call sites were deriving the validation word from the wire key — one
  // through `state.replace("_", " ")`, which rendered `not run` in lowercase,
  // and one which passed `not_run` straight through, so the detail panel's badge
  // showed a raw snake_case token to an operator. A `Record<string, …>` tone map
  // also let a state this build has no word for render as itself instead of
  // failing closed. The Outcome column had the same problem, lowercased.
  const base: ExperienceEnvelope = {
    id: "exp-vocab",
    workspaceId: "SimulatorLife/AutoDev",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    taskId: "task-vocab",
    runId: "run-vocab",
    agentId: "agent-orch",
    startedAt: "2026-10-03T10:00:00Z",
    outcome: "success",
    trajectory: {
      format: "codex-v1",
      uri: "file:///tmp/transcripts/run-vocab.jsonl",
      sourceAdapter: "codex"
    },
    evidence: []
  };

  const renderOne = (over: Partial<ExperienceEnvelope>): string =>
    renderToStaticMarkup(
      React.createElement(MemoryExperiencesView, {
        experiences: [{ ...base, ...over }],
        total: 1,
        listScope: memoryListScope({ tab: "experiences" })
      })
    );

  // Scoped to the badge: asserting a word "somewhere in the page" is how the
  // Memory status guard came to pass while every row read the wrong one.
  const badgeOf = (markup: string): readonly [string, string] | null => {
    const found =
      /data-status="([a-z-]+)"[^>]*>[\s\S]*?<span class="min-w-0 truncate">([^<]*)</u.exec(
        markup
      );
    return found === null ? null : [found[1], found[2]];
  };

  for (const [state, word, tone] of [
    ["passed", "Passed", "valid"],
    ["failed", "Failed", "invalid"],
    ["partial", "Partial", "pending"],
    ["not_run", "Not run", "not-observed"]
  ] as const) {
    const badge = badgeOf(
      renderOne({
        validation: { state, evidence: [] }
      } as Partial<ExperienceEnvelope>)
    );
    assert.ok(badge !== null, `${state} should render a badge`);
    assert.equal(badge[0], tone, `${state} should wear the ${tone} tone`);
    assert.equal(badge[1], word, `${state} should read "${word}"`);
    assert.ok(
      !renderOne({
        validation: { state, evidence: [] }
      } as Partial<ExperienceEnvelope>).includes(`>${state}<`),
      "a raw wire key must not be rendered as a word"
    );
  }

  // An experience the Runtime reported no validation for is `not_run`, not a
  // blank cell and not an invented pass.
  const unvalidated = renderOne({});
  assert.ok(
    unvalidated.includes(">Not run<"),
    "absent validation should read Not run"
  );
  assert.ok(
    unvalidated.includes('data-status="not-observed"'),
    "absent validation must not read as observed"
  );

  for (const [outcome, word] of [
    ["success", "Success"],
    ["partial", "Partial"],
    ["failure", "Failure"],
    ["cancelled", "Cancelled"],
    ["unknown", "Unknown"]
  ] as const) {
    const markup = renderOne({ outcome });
    assert.ok(markup.includes(`>${word}<`), `${outcome} should read "${word}"`);
    const outcomeCell = markup.slice(
      markup.indexOf("font-semibold"),
      markup.indexOf("</td>", markup.indexOf("font-semibold"))
    );
    assert.ok(
      !outcomeCell.includes(`>${outcome}<`),
      `${outcome} must not be shown as a raw key in the outcome cell`
    );
  }
});

test("MemoryExperiencesView renders experiences with task, role, and validation indicators", () => {
  const sampleExp: ExperienceEnvelope = {
    id: "exp-001",
    workspaceId: "SimulatorLife/AutoDev",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    taskId: "task-101",
    runId: "run-505",
    agentId: "agent-orch",
    agentRole: "orchestrator",
    startedAt: "2026-10-03T10:00:00Z",
    outcome: "success",
    memoryMode: "jit",
    trajectory: {
      format: "codex-v1",
      uri: "file:///tmp/transcripts/run-505.jsonl",
      sourceAdapter: "codex"
    },
    evidence: []
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryExperiencesView, {
      experiences: [sampleExp],
      total: 1,
      listScope: memoryListScope({ tab: "experiences" })
    })
  );

  assert.match(markup, /data-memory-experience-id="exp-001"/);
  assert.match(markup, /task-101/);
  assert.match(markup, /run-505/);
  assert.match(markup, /orchestrator/);
  assert.match(markup, /jit/);
  assert.match(markup, /success/);
});

test("MemoryExperiencesView requires a Runtime-accepted reason and explicit confirmation before purging", () => {
  const sampleExp: ExperienceEnvelope = {
    id: "exp-002",
    workspaceId: "SimulatorLife/AutoDev",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    taskId: "task-202",
    runId: "run-606",
    agentId: "agent-orch",
    agentRole: "orchestrator",
    startedAt: "2026-10-03T10:00:00Z",
    outcome: "failure",
    memoryMode: "jit",
    trajectory: {
      format: "codex-v1",
      uri: "file:///tmp/transcripts/run-606.jsonl",
      sourceAdapter: "codex"
    },
    evidence: []
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryExperiencesView, {
      experiences: [sampleExp],
      total: 1,
      selectedExperience: sampleExp,
      listScope: memoryListScope({ tab: "experiences" })
    })
  );

  // Purge targets the experience envelope, not a durable record id.
  assert.match(markup, /name="experienceId" value="exp-002"/);
  assert.match(markup, /name="action" value="purge"/);

  // The Console ships no client JavaScript, so the confirmation is a real form
  // field the route refuses to act without rather than a click handler.
  assert.match(markup, /type="checkbox"[^>]*name="confirm"[^>]*value="purge"/);
  // Only reasons the Runtime accepts may be composed into a request.
  assert.match(markup, /value="privacy_request"/);
  assert.match(markup, /value="retention_expired"/);
  // The checkbox must not start ticked: confirmation is the operator's action.
  assert.doesNotMatch(markup, /type="checkbox"[^>]*name="confirm"[^>]*checked/);

  // The destructive control renders through the shared button vocabulary.
  assert.match(markup, /data-button="purge-experience"/);
});

test("a cohort's outcome is named, and an unreported cell is not given an outcome", () => {
  // The Outcome column printed the wire key and a bare lowercase literal,
  // directly beneath a filter that spells the same five values "Success" and
  // "Partial" — the column contradicting the control that narrows it. The
  // literal also re-spelled "Unreported", which the Reporting Status column
  // beside it already carries as a Tag.
  const cells: MemorySessionOutcomeCohortCell[] = [
    { memoryMode: "jit", outcomeKind: "success", sessionCount: 15 },
    { memoryMode: "jit", outcomeKind: "partial", sessionCount: 4 },
    { memoryMode: "jit", outcomeKind: null, sessionCount: 6 }
  ];
  const markup = renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts: {
        schema: "autodev-memory-session-outcome-cohorts-v1",
        workspaceId: "SimulatorLife/AutoDev",
        repositoryId: "SimulatorLife/AutoDev",
        occurredFrom: "2026-09-01T00:00:00Z",
        occurredUntil: "2026-10-01T00:00:00Z",
        cells,
        sessionCount: 25,
        reportedSessionCount: 19,
        unreportedSessionCount: 6,
        mixedModeSessionCount: 0,
        conflictingOutcomeSessionCount: 0
      },
      useCohorts: null,
      listScope: memoryListScope({ tab: "cohorts" }),
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      occurredFrom: "2026-09-01T00:00:00Z",
      occurredUntil: "2026-10-01T00:00:00Z"
    })
  );

  assert.ok(
    markup.includes(">Success<"),
    "a reported outcome should read Success"
  );
  assert.ok(
    markup.includes(">Partial<"),
    "a partial outcome should read Partial"
  );
  // A cell with no report has no outcome. It must not invent one, and it must
  // not borrow the Reporting Status column's word for it.
  assert.ok(
    markup.includes(`>${NOT_OBSERVED_LABEL}<`),
    "an unreported cell should read the Console's word for missing evidence"
  );
  assert.ok(
    !markup.includes(">unreported<"),
    "a raw lowercase literal must not be rendered"
  );
  assert.ok(
    !markup.includes(">success<"),
    "a raw wire key must not be rendered"
  );
});

test("MemoryCohortsView renders session outcome cohorts preserving explicit unreported cells", () => {
  const sampleCohort: MemorySessionOutcomeCohortPage = {
    schema: "autodev-memory-session-outcome-cohorts-v1",
    workspaceId: "SimulatorLife/AutoDev",
    repositoryId: "SimulatorLife/AutoDev",
    occurredFrom: "2026-09-01T00:00:00Z",
    occurredUntil: "2026-10-01T00:00:00Z",
    cells: [
      { memoryMode: "jit", outcomeKind: "success", sessionCount: 15 },
      { memoryMode: "jit", outcomeKind: null, sessionCount: 6 },
      { memoryMode: "disabled", outcomeKind: "failure", sessionCount: 2 }
    ],
    sessionCount: 23,
    reportedSessionCount: 17,
    unreportedSessionCount: 6,
    mixedModeSessionCount: 2,
    conflictingOutcomeSessionCount: 1
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts: sampleCohort,
      useCohorts: null,
      listScope: memoryListScope({ tab: "cohorts" }),
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      occurredFrom: "2026-09-01T00:00:00Z",
      occurredUntil: "2026-10-01T00:00:00Z"
    })
  );

  assert.match(markup, /data-feature="memory-cohorts"/);
  assert.match(markup, /Observed Sessions/);
  assert.match(markup, /Unreported Sessions/);
  assert.match(markup, /Mixed-Mode Sessions/);
  assert.match(markup, /Conflicting Reports/);
  assert.match(markup, /Reported/);
  assert.match(markup, /Unreported/);
  assert.match(markup, /Non-inferential cohort policy/);
});

test("MemoryCohortsView does not render unavailable session data as an empty cohort", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts: null,
      useCohorts: null,
      listScope: memoryListScope({ tab: "cohorts" }),
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      occurredFrom: "2026-09-01T00:00:00Z",
      occurredUntil: "2026-10-01T00:00:00Z"
    })
  );
  assert.match(markup, /data-memory-session-cohorts-state="unavailable"/);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /data-status="unavailable"/);
  assert.match(markup, /Session outcome cohort data is unavailable/);
  assert.equal(markup.includes("No session outcome cohort data found"), false);
  assert.equal(markup.includes("Observed Sessions"), false);
});

test("MemoryCohortsView distinguishes an observed empty cohort from unavailable data", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts: {
        schema: "autodev-memory-session-outcome-cohorts-v1",
        workspaceId: "SimulatorLife/AutoDev",
        repositoryId: "SimulatorLife/AutoDev",
        occurredFrom: "2026-09-01T00:00:00Z",
        occurredUntil: "2026-10-01T00:00:00Z",
        cells: [],
        sessionCount: 0,
        reportedSessionCount: 0,
        unreportedSessionCount: 0,
        mixedModeSessionCount: 0,
        conflictingOutcomeSessionCount: 0
      },
      useCohorts: null,
      listScope: memoryListScope({ tab: "cohorts" }),
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      occurredFrom: "2026-09-01T00:00:00Z",
      occurredUntil: "2026-10-01T00:00:00Z"
    })
  );
  assert.match(markup, /data-memory-session-cohorts-state="observed"/);
  assert.match(markup, /Observed Sessions/);
  assert.match(markup, /No session outcome cohort data found/);
  assert.doesNotMatch(markup, /Session outcome cohort data is unavailable/);
});

test("MemoryCohortsView answers how much of what was injected was ever judged", () => {
  // The cohort cells are a matrix -- mode x session cardinality x judgement --
  // and neither question an operator actually opens this tab to ask is answered
  // by a single cell. Both are sums, and the summing is where this can go wrong:
  // a total that quietly drops the unassessed exposures, or files `unobservable`
  // under `not_used`, reports a confidence no curator expressed.
  const useCell = (
    memoryMode: string,
    useKind: string | null,
    exposureCount: number
  ): MemoryInjectionUseCohortCell => ({
    memoryMode: memoryMode as MemoryInjectionUseCohortCell["memoryMode"],
    sessionCardinality: "single",
    useKind: useKind as MemoryInjectionUseCohortCell["useKind"],
    exposureCount
  });

  const markup = renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts: null,
      useCohorts: {
        schema: "autodev-memory-injection-use-cohorts-v1",
        workspaceId: "SimulatorLife/AutoDev",
        repositoryId: "SimulatorLife/AutoDev",
        occurredFrom: "2026-09-01T00:00:00Z",
        occurredUntil: "2026-10-01T00:00:00Z",
        exposureCount: 40,
        cells: [
          useCell("jit", "used", 10),
          useCell("jit", "not_used", 5),
          // Nobody could tell. Filing this under "not used" would say memory was
          // ignored when the truth is that nobody watched.
          useCell("jit", "unobservable", 5),
          useCell("jit", null, 10),
          useCell("retrieval-only", "partially_used", 5),
          useCell("retrieval-only", null, 5)
        ]
      },
      listScope: memoryListScope({ tab: "cohorts" }),
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      occurredFrom: "2026-09-01T00:00:00Z",
      occurredUntil: "2026-10-01T00:00:00Z"
    })
  );

  // Every judgement category is its own bar, with the absence of a judgement as
  // a fifth rather than folded into any of the four.
  for (const label of ["Used", "Partially used", "Not used", "Unobservable"]) {
    assert.match(
      markup,
      new RegExp(`>${label}<`),
      `${label} keeps its own bar`
    );
  }
  assert.match(markup, />Not assessed</);

  // The weights are exposure counts, so the judgement bars sum to the eligible
  // total: 10 used, 5 partially used, 5 not used, 5 unobservable, 15 not
  // assessed. Asserted as a multiset because the point is that nothing was
  // merged or dropped, which a per-label assertion would not catch.
  const judgementValues = Array.from(
    markup.matchAll(/text-chart-2[^"]*">(\d[\d,]*)<\/span>/g),
    (match) => match[1]
  );
  assert.deepEqual(
    judgementValues,
    ["10", "5", "5", "5", "15"],
    "every judgement keeps its own weight, and the unassessed remainder is one of them"
  );

  // Coverage is stated as assessed-of-eligible against the mode's own
  // denominator: jit judged 20 of 30, retrieval-only 5 of 10.
  assert.match(markup, /67% assessed \(20 of 30\)/);
  assert.match(markup, /50% assessed \(5 of 10\)/);
  // Never as a use rate. An unassessed exposure is missing data, so a share
  // "used" over the eligible denominator would read missing as negative.
  assert.doesNotMatch(markup, /% used/);
});

test("MemoryCohortsView reports no coverage for a mode with no eligible exposures", () => {
  // A mode observed with zero eligible exposures has no denominator, so there
  // is no rate. Reporting 0% would read as "every exposure we injected was
  // ignored", which is the opposite of what was observed.
  const markup = renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts: null,
      useCohorts: {
        schema: "autodev-memory-injection-use-cohorts-v1",
        workspaceId: "SimulatorLife/AutoDev",
        repositoryId: "SimulatorLife/AutoDev",
        occurredFrom: "2026-09-01T00:00:00Z",
        occurredUntil: "2026-10-01T00:00:00Z",
        exposureCount: 0,
        cells: [
          {
            memoryMode: "jit",
            sessionCardinality: "single",
            useKind: "used",
            exposureCount: 0
          }
        ]
      },
      listScope: memoryListScope({ tab: "cohorts" }),
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      occurredFrom: "2026-09-01T00:00:00Z",
      occurredUntil: "2026-10-01T00:00:00Z"
    })
  );

  assert.match(markup, /No eligible exposures/);
  assert.doesNotMatch(markup, /0% assessed/);
  assert.doesNotMatch(markup, /NaN/);
});

test("MemoryView reports lifecycle counts for the whole collection, not for the page", () => {
  // The defect this closes: Active Claims was counted off the rows on the page,
  // because the response carried no total for it. On a 25-row page it reported
  // at most 25 beside a collection total of 1,204, which reads as a share and is
  // not one — and it was not even a live wrong number, since a page can hold
  // zero active records while the collection holds hundreds.
  const records: MemoryRecord[] = [
    {
      id: "mem-001",
      kind: "procedural",
      status: "active",
      scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
      claim: "Always execute test suites before pushing code to main.",
      validity: { state: "verified", evidence: [] },
      provenance: {
        experienceIds: ["exp-1"],
        evidence: [],
        createdBy: "operator",
        createdAt: "2026-10-01T00:00:00Z"
      },
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z"
    }
  ];
  const render = (statusCounts: MemoryStatusCounts | null): string =>
    renderToStaticMarkup(
      React.createElement(MemoryView, {
        listScope: memoryListScope({ tab: "records" }),
        records,
        totalRecords: 1204,
        recordsStatusCounts: statusCounts,
        experiences: [],
        totalExperiences: 1,
        sessionCohorts: null,
        useCohorts: null,
        repositoryId: "SimulatorLife/AutoDev",
        workspaces: [],
        unapplied: []
      })
    );

  const measured = render({
    proposed: 40,
    active: 900,
    superseded: 120,
    invalidated: 130,
    uncertain: 14
  });
  // 900 active records behind a one-row page. The old implementation could not
  // have printed this number at any page size.
  assert.match(measured, /Verified &amp; in service, all pages/);
  assert.match(measured, />900</);
  assert.match(measured, /Durable records by lifecycle status/);
  // Every lifecycle state is shown, not just the one the card counts.
  for (const label of [
    "Proposed",
    "Active",
    "Uncertain",
    "Superseded",
    "Invalidated"
  ]) {
    assert.match(measured, new RegExp(`>${label}<`));
  }

  // An absent rollup is not a collection with no active claims, and must never
  // render as a zero beside the total.
  const unobserved = render(null);
  assert.match(unobserved, /Not observed/);
  assert.doesNotMatch(unobserved, /Durable records by lifecycle status/);
});

test("a records page without a lifecycle rollup is refused, not rendered as zero", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const read = async (body: unknown): Promise<boolean> => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
    try {
      return (
        (
          await fetchMemoryRecords(
            { workspaceId: "SimulatorLife/AutoDev" },
            config
          )
        ).kind === "ok"
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  };

  const page = {
    schema: "autodev-memory-records-v1",
    items: [],
    total: 0,
    limit: 50,
    offset: 0
  };
  // A Runtime that publishes no rollup leaves the Console with nothing to say
  // about the lifecycle. Accepting it would render zeros for claims it never
  // observed — on the one number no reader can check.
  assert.equal(await read(page), false);
  assert.equal(
    await read({
      ...page,
      statusCounts: { proposed: 0, active: 0, superseded: 0, invalidated: 0 }
    }),
    false,
    "a partial rollup is refused too: an absent status is ambiguous between zero and not observed"
  );
  assert.equal(
    await read({
      ...page,
      statusCounts: {
        proposed: 0,
        active: 2,
        superseded: 0,
        invalidated: 0,
        uncertain: 0
      }
    }),
    true
  );
});

test("an expired validity window is stated, because the Runtime will not inject it", () => {
  // The defect: `isEligibleRecord` refuses a record whose `validTo` has passed,
  // so an active, verified claim whose window closed is never handed to an
  // agent. The detail panel showed the state and the check date and said nothing
  // about the window, so the one question this panel is opened to answer — "is
  // this claim actually in use?" — rendered as a healthy claim.
  const renderWith = (validity: Partial<MemoryRecord["validity"]>): string => {
    const record: MemoryRecord = {
      id: "mem-expired",
      kind: "procedural",
      status: "active",
      scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
      claim: "Run the suite before pushing to main.",
      validity: { state: "verified", evidence: [], ...validity },
      provenance: {
        experienceIds: ["exp-1"],
        evidence: [],
        createdBy: "operator",
        createdAt: "2026-10-01T00:00:00Z"
      },
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z"
    };
    return renderToStaticMarkup(
      React.createElement(MemoryRecordsView, {
        records: [record],
        total: 1,
        // The validity panel is the drawer, not the row, so the panel has to be
        // opened for it to say anything.
        selectedRecord: record,
        listScope: memoryListScope()
      })
    );
  };

  const expired = renderWith({
    validFrom: "2026-09-01T00:00:00Z",
    validTo: "2026-09-15T00:00:00Z"
  });
  assert.match(expired, /Out of validity window/);
  assert.match(
    expired,
    /the Runtime will not inject this claim/,
    "the panel names the consequence, not just the fact"
  );

  // An open window is stated and is not the same claim as a closed one.
  const open = renderWith({
    validFrom: "2026-09-01T00:00:00Z",
    validTo: "2099-01-01T00:00:00Z"
  });
  assert.doesNotMatch(open, /Out of validity window/);
  assert.match(open, /Valid /);

  // An absent bound is the absence of a decision. Rendering a dash would claim
  // either "valid forever" or "expired", and the Runtime injects it.
  const unbounded = renderWith({});
  assert.doesNotMatch(unbounded, /Out of validity window/);
  assert.doesNotMatch(unbounded, /Valid (from|until)/);

  // An unparseable bound is treated as absent, because the Runtime would not
  // parse it either and refusing a claim it will inject is the worse error.
  assert.doesNotMatch(
    renderWith({ validTo: "not-a-date" }),
    /Out of validity window/
  );
});

test("a skill that reached the catalog but reached no agent says so", () => {
  // The memory system's last mile. A procedural memory promoted to a skill lands
  // in the RuleSync catalog with no role assignment; `/control/skills` is
  // read-only and role assignment lives in the execution contract, so nothing in
  // the Console can give it one. The promotion reports success. The State column
  // used to badge every row "Configured" without reading the row, so this skill
  // sat beside "No roles assigned" under a green badge claiming it was fine.
  const renderWith = (eligibility: SkillEligibility[]): string =>
    renderToStaticMarkup(
      React.createElement(SkillsView, {
        skills: [
          {
            name: "release-checklist",
            description: "Steps for cutting a release.",
            path: ".rulesync/skills/release-checklist/SKILL.md"
          }
        ],
        eligibility,
        unresolvedAssignments: [],
        sourceValidity: true,
        validationIssues: [],
        assignmentRoles: ["orchestrator", "worker"],
        executionContractRevision: "c".repeat(64)
      })
    );

  const unassigned = renderWith([{ skill: "release-checklist", roles: [] }]);
  assert.match(unassigned, /Not assigned/);
  assert.match(
    unassigned,
    /so nothing can invoke it/,
    "the badge says what the state costs, not just what it is"
  );
  assert.doesNotMatch(
    unassigned,
    /data-status="configured"/,
    "the row is not badged as though being in the catalog were enough"
  );

  assert.match(
    renderWith([
      { skill: "release-checklist", roles: ["orchestrator", "reviewer"] }
    ]),
    /Assigned/
  );

  // No eligibility entry at all is missing evidence, not an observed absence.
  // Folding it into "Not assigned" would claim we looked and found nothing.
  const unobserved = renderWith([]);
  assert.match(unobserved, /Not observed/);
  assert.doesNotMatch(unobserved, /Not assigned/);
});

test("MemoryView keeps an unavailable experience tab out of its successful-empty state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MemoryView, {
      listScope: memoryListScope({ tab: "experiences" }),
      records: [],
      totalRecords: 0,
      experiences: [],
      totalExperiences: null,
      sessionCohorts: null,
      useCohorts: null,
      repositoryId: "SimulatorLife/AutoDev",
      workspaces: [],
      unapplied: []
    })
  );
  assert.match(markup, /data-memory-experiences-observed="false"/);
  assert.match(markup, /data-status="unavailable"/);
  assert.match(markup, /Memory experiences are unavailable/);
  assert.equal(markup.includes("No captured memory experiences found"), false);
  assert.equal(markup.includes('data-feature="memory-experiences"'), false);
});

test("MemoryView renders top-level tabs, stat counts, and a URL-driven workspace filter", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MemoryView, {
      listScope: memoryListScope({
        query: "fallback",
        kind: "procedure",
        status: "active",
        from: "2026-09-01T00:00:00Z",
        until: "2026-10-01T00:00:00Z"
      }),
      records: [],
      totalRecords: 0,
      experiences: [],
      totalExperiences: null,
      sessionCohorts: null,
      useCohorts: null,
      repositoryId: "SimulatorLife/AutoDev",
      workspaces: [
        {
          id: "SimulatorLife/AutoDev",
          baseBranch: "main",
          enabled: true,
          agentRoles: null
        },
        {
          id: "SimulatorLife/Other",
          baseBranch: "main",
          enabled: true,
          agentRoles: null
        }
      ]
    })
  );

  assert.match(markup, /data-feature="memory"/);
  assert.match(markup, /data-memory-experiences-observed="false"/);
  assert.match(markup, /data-memory-session-cohorts-observed="false"/);
  const experiencesLabel = markup.indexOf(">Experiences</span>");
  const cohortSessionsLabel = markup.indexOf(">Cohort Sessions</span>");
  const tabsStart = markup.indexOf("<nav", cohortSessionsLabel);
  assert.notEqual(experiencesLabel, -1);
  assert.ok(cohortSessionsLabel > experiencesLabel);
  assert.ok(tabsStart > cohortSessionsLabel);
  assert.match(
    markup.slice(experiencesLabel, cohortSessionsLabel),
    />Not observed<\/span>/
  );
  assert.match(
    markup.slice(cohortSessionsLabel, tabsStart),
    />Not observed<\/span>/
  );
  assert.match(markup, /data-tab-item="records"/);
  assert.match(markup, /data-tab-item="experiences"/);
  assert.match(markup, /data-tab-item="cohorts"/);
  // The Console is the sole Memory operator surface: the transitional external
  // Memory portal is gone, so no tab or link may lead out of it.
  assert.doesNotMatch(markup, /data-tab-item="portal"/);
  assert.doesNotMatch(markup, /External Memory UI/);
  assert.equal(markup.includes("OpenLIT Portal"), false);
  assert.match(markup, /aria-label="Memory sections"/);
  assert.match(markup, /aria-current="page"[^>]*data-tab-item="records"/);
  const experiencesLink = markup
    .split("<a")
    .find((anchor) => anchor.includes('data-tab-item="experiences"'));
  assert.ok(experiencesLink);
  const href = experiencesLink.match(/href="([^"]+)"/u)?.[1];
  assert.ok(href);
  const tabUrl = new URL(href.replaceAll("&amp;", "&"), "http://console.test");
  assert.equal(tabUrl.pathname, "/memory");
  assert.deepEqual(Array.from(tabUrl.searchParams.entries()), [
    ["tab", "experiences"],
    ["workspaceId", "SimulatorLife/AutoDev"],
    ["from", "2026-09-01T00:00:00Z"],
    ["until", "2026-10-01T00:00:00Z"],
    // The page size travels with the tab so an operator who chose 25 rows does
    // not get 50 on the tab they switch to.
    ["limit", "50"],
    ["query", "fallback"],
    ["kind", "procedure"],
    ["status", "active"]
  ]);
  // Switching tab is a new list, so it returns to the first page rather than
  // carrying the previous tab's position into a differently-sized collection.
  assert.equal(tabUrl.searchParams.has("offset"), false);
  assert.match(markup, /Durable Records/);
  assert.match(markup, /Active Claims/);
  // The active count comes from the Runtime's lifecycle rollup over the filtered
  // collection, so it is about every record rather than the rows on this page.
  // While it was counted off the page, a 25-row page reported at most 25 beside
  // a total of 1,204 and read as a share of it.
  assert.match(markup, /Verified &amp; in service, all pages/);

  const selectorStart = markup.indexOf('data-memory-workspace-form="true"');
  const formStart = markup.lastIndexOf("<form", selectorStart);
  const formEnd = markup.indexOf("</form>", formStart);
  assert.notEqual(selectorStart, -1);
  assert.notEqual(formStart, -1);
  assert.ok(formEnd > formStart);
  const workspaceForm = markup.slice(formStart, formEnd);
  assert.match(workspaceForm, /method="GET"/);
  assert.match(workspaceForm, /action="\/memory"/);
  assert.match(workspaceForm, /name="workspaceId"/);
  assert.match(workspaceForm, /name="tab" value="records"/);
  assert.match(workspaceForm, /name="query" value="fallback"/);
  assert.match(workspaceForm, /name="kind" value="procedure"/);
  assert.match(workspaceForm, /name="status" value="active"/);
  assert.match(workspaceForm, /name="from" value="2026-09-01T00:00:00Z"/);
  assert.match(workspaceForm, /name="until" value="2026-10-01T00:00:00Z"/);
  assert.match(workspaceForm, /name="limit" value="50"/);
  // Changing the scope selects a different collection, so it starts at that
  // collection's first page.
  assert.doesNotMatch(workspaceForm, /name="offset"/);
  assert.match(workspaceForm, /SimulatorLife\/Other/);
  assert.doesNotMatch(workspaceForm, /name="recordId"|name="experienceId"/);
});

// The Memory target names browse/search/pagination over the indexed records,
// and the Runtime already pages both collections and returns the total behind
// the page. These cover the two halves that were missing: asking the Runtime
// for the page the URL names, and offering a way to reach the next one.

test("resolveMemoryPage applies the Runtime's accepted page sizes and bounds the offset", () => {
  assert.deepEqual(resolveMemoryPage(undefined, undefined), {
    page: { limit: DEFAULT_MEMORY_PAGE_SIZE, offset: 0 },
    unapplied: []
  });
  assert.deepEqual(resolveMemoryPage("25", "75"), {
    page: { limit: 25, offset: 75 },
    unapplied: []
  });
  assert.deepEqual(resolveMemoryPage("100", String(MAX_MEMORY_OFFSET)), {
    page: { limit: 100, offset: MAX_MEMORY_OFFSET },
    unapplied: []
  });

  // A page size the Runtime would reject with a TypeError is named, not
  // forwarded. `?limit=9999` must not become a 500.
  const tooLarge = resolveMemoryPage("9999", "");
  assert.equal(tooLarge.page.limit, DEFAULT_MEMORY_PAGE_SIZE);
  assert.deepEqual(tooLarge.unapplied, [{ name: "limit", value: "9999" }]);

  for (const bad of ["-1", "100001", "abc", "1.5"]) {
    const rejected = resolveMemoryPage("50", bad);
    assert.deepEqual(rejected.page, { limit: 50, offset: 0 });
    assert.deepEqual(
      rejected.unapplied.map((f) => f.name),
      ["offset"],
      `offset=${bad} should be reported as unapplied`
    );
  }

  // A blank parameter is silence, not a bad request — the same contract every
  // other bounded filter follows.
  assert.deepEqual(resolveMemoryPage("50", "   "), {
    page: { limit: 50, offset: 0 },
    unapplied: []
  });

  // Previous and Next build exact multiples of the page size, so an offset that
  // is not one can only be hand-edited. Reading it as written would report a
  // range that Previous cannot navigate back from.
  const offGrid = resolveMemoryPage("50", "77");
  assert.deepEqual(offGrid.page, { limit: 50, offset: 50 });
  assert.deepEqual(offGrid.unapplied, [{ name: "offset", value: "77" }]);
  // Snapping is against the *resolved* page size, not the requested one.
  assert.deepEqual(resolveMemoryPage("100", "77").page, {
    limit: 100,
    offset: 0
  });
});

test("a Memory list's links keep the filters and position that produced the list", () => {
  const scope = memoryListScope({
    query: "guard",
    kind: "procedural",
    status: "active",
    from: "2026-09-01T00:00:00Z",
    until: "2026-10-01T00:00:00Z",
    limit: 25,
    offset: 50
  });

  // The detail link used to carry only tab/workspace/recordId, so opening a
  // record and closing it again returned an unfiltered, 30-day list.
  const detail = new URL(
    memoryDetailHref(scope, "recordId", "mem 1"),
    "http://console.test"
  );
  assert.equal(detail.pathname, "/memory");
  assert.equal(detail.searchParams.get("recordId"), "mem 1");
  for (const [key, value] of [
    ["query", "guard"],
    ["kind", "procedural"],
    ["status", "active"],
    ["from", "2026-09-01T00:00:00Z"],
    ["until", "2026-10-01T00:00:00Z"],
    ["limit", "25"],
    ["offset", "50"]
  ] as const) {
    assert.equal(detail.searchParams.get(key), value, `${key} must survive`);
  }

  const list = new URL(memoryListHref(scope), "http://console.test");
  assert.equal(list.searchParams.has("recordId"), false);
  assert.equal(list.searchParams.get("offset"), "50");

  // Paging moves position and keeps everything else.
  const next = new URL(memoryPageHref(scope, 75), "http://console.test");
  assert.equal(next.searchParams.get("offset"), "75");
  assert.equal(next.searchParams.get("query"), "guard");

  // Submitting the filters is a different list, so it starts at page one.
  const refiltered = new URL(memoryFilterHref(scope), "http://console.test");
  assert.equal(refiltered.searchParams.has("offset"), false);
  assert.equal(refiltered.searchParams.get("query"), "guard");
  assert.equal(refiltered.searchParams.get("until"), "2026-10-01T00:00:00Z");

  // `all` is a real answer to `?kind=all`, so it is not written back out.
  const unfiltered = memoryListHref(
    memoryListScope({ kind: "all", status: "all", offset: 0 })
  );
  assert.equal(unfiltered.includes("kind="), false);
  assert.equal(unfiltered.includes("status="), false);
  assert.equal(unfiltered.includes("offset="), false);
});

test("Pagination reports the rows on the page and offers only the directions that exist", () => {
  const at = (
    offset: number,
    limit: number,
    total: number
  ): React.JSX.Element | null =>
    Pagination({
      label: "Records",
      offset,
      limit,
      total,
      hrefForOffset: (next: number) => `/memory?offset=${next}`
    }) as React.JSX.Element | null;

  assert.equal(pageRangeLabel({ offset: 0, limit: 50, total: 0 }), "No rows");
  assert.equal(
    pageRangeLabel({ offset: 0, limit: 50, total: 120 }),
    "1–50 of 120"
  );
  // A short final page stops at the total rather than reading past it.
  assert.equal(
    pageRangeLabel({ offset: 100, limit: 50, total: 120 }),
    "101–120 of 120"
  );
  // A stale bookmark past the end says so instead of claiming a range that
  // starts beyond the collection.
  assert.equal(
    pageRangeLabel({ offset: 500, limit: 50, total: 120 }),
    "No rows on this page"
  );

  // A collection that fits in one page needs no bar at all.
  assert.equal(at(0, 50, 12), null);
  assert.equal(at(0, 50, 50), null);

  const middle = renderToStaticMarkup(at(50, 50, 120)) ?? "";
  assert.match(middle, /aria-label="Records pagination"/);
  assert.match(middle, /51–100 of 120/);
  assert.match(middle, /href="\/memory\?offset=0"[^>]*rel="prev"/);
  assert.match(middle, /href="\/memory\?offset=100"[^>]*rel="next"/);

  // The unavailable direction is inert text, not a dead link a keyboard
  // operator could focus and find did nothing.
  const first = renderToStaticMarkup(at(0, 50, 120)) ?? "";
  assert.match(first, /<span aria-disabled="true"[^>]*>Previous<\/span>/);
  assert.match(first, /href="\/memory\?offset=50"[^>]*rel="next"/);

  const last = renderToStaticMarkup(at(100, 50, 120)) ?? "";
  assert.match(last, /<span aria-disabled="true"[^>]*>Next<\/span>/);
  assert.match(last, /href="\/memory\?offset=50"[^>]*rel="prev"/);

  // Past the end of a collection too small to paginate, the bar survives to
  // carry the way back.
  const pastEnd = renderToStaticMarkup(at(100, 50, 12)) ?? "";
  assert.match(pastEnd, /No rows on this page/);
  assert.match(pastEnd, /href="\/memory\?offset=50"[^>]*rel="prev"/);
});

test("MemoryRecordsView and MemoryExperiencesView page a collection larger than one page", () => {
  const record: MemoryRecord = {
    id: "mem-paged",
    kind: "semantic",
    status: "active",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "A claim.",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  };

  const recordsMarkup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [record],
      // 50 of 1,204 is the state the view used to render with nothing to act
      // on.
      total: 1204,
      listScope: memoryListScope({ limit: 50, offset: 50, kind: "semantic" })
    })
  );
  assert.match(recordsMarkup, /data-pagination="memory-records-pagination"/);
  const nextLink = recordsMarkup
    .split("<a")
    .find((anchor) => anchor.includes('rel="next"'));
  assert.ok(nextLink);
  const href = nextLink.match(/href="([^"]+)"/u)?.[1];
  assert.ok(href);
  const nextUrl = new URL(href.replaceAll("&amp;", "&"), "http://console.test");
  assert.equal(nextUrl.searchParams.get("offset"), "100");
  assert.equal(nextUrl.searchParams.get("kind"), "semantic");

  const experience: ExperienceEnvelope = {
    id: "exp-paged",
    taskId: "task-1",
    runId: "run-1",
    capturedAt: "2026-10-01T00:00:00Z",
    workspaceId: "SimulatorLife/AutoDev",
    role: "orchestrator",
    agentRole: "orchestrator",
    summary: "Did the thing.",
    trajectoryRef: "traj/1",
    validation: { state: "passed", evidence: [] }
  } as unknown as ExperienceEnvelope;

  const experiencesMarkup = renderToStaticMarkup(
    React.createElement(MemoryExperiencesView, {
      experiences: [experience],
      total: 120,
      listScope: memoryListScope({
        tab: "experiences",
        limit: 50,
        offset: 0,
        query: "task-1"
      })
    })
  );
  assert.match(
    experiencesMarkup,
    /data-pagination="memory-experiences-pagination"/
  );
  const experiencesNext = experiencesMarkup
    .split("<a")
    .find((anchor) => anchor.includes('rel="next"'));
  assert.ok(experiencesNext);
  const experiencesHref = experiencesNext.match(/href="([^"]+)"/u)?.[1];
  assert.ok(experiencesHref);
  const experiencesUrl = new URL(
    experiencesHref.replaceAll("&amp;", "&"),
    "http://console.test"
  );
  assert.equal(experiencesUrl.searchParams.get("offset"), "50");
  assert.equal(experiencesUrl.searchParams.get("query"), "task-1");
});

test("a Memory detail panel closes back to the list it was opened from", () => {
  const record: MemoryRecord = {
    id: "mem-return",
    kind: "semantic",
    status: "active",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "A claim.",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [record],
      total: 1204,
      selectedRecord: record,
      listScope: memoryListScope({
        query: "guard",
        status: "active",
        limit: 25,
        offset: 50
      })
    })
  );

  const closeAnchor = markup
    .split("<a")
    .find((anchor) => anchor.includes("Close</a>"));
  assert.ok(closeAnchor, "the drawer must render a close link");
  const closeHref = closeAnchor.match(/href="([^"]+)"/u)?.[1];
  assert.ok(closeHref);
  const url = new URL(
    closeHref.replaceAll("&amp;", "&"),
    "http://console.test"
  );
  assert.equal(url.pathname, "/memory");
  assert.equal(url.searchParams.get("query"), "guard");
  assert.equal(url.searchParams.get("status"), "active");
  assert.equal(url.searchParams.get("limit"), "25");
  assert.equal(url.searchParams.get("offset"), "50");
  assert.equal(url.searchParams.has("recordId"), false);
});

test("fetchMemoryRecords issues authenticated GET to /control/memory/records with workspace scope", async () => {
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "test-token-memory"
  };
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(
      input,
      "http://127.0.0.1:4101/control/memory/records?workspaceId=SimulatorLife%2FAutoDev&query=rule"
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-token-memory");
    assert.equal(headers.get("x-autodev-actor"), LOCAL_CONTROL_API_ACTOR);
    return Response.json({
      schema: "autodev-memory-records-v1",
      items: [],
      total: 0,
      limit: 50,
      statusCounts: {
        proposed: 0,
        active: 0,
        superseded: 0,
        invalidated: 0,
        uncertain: 0
      },
      offset: 0,
      hasMore: false
    });
  };

  const result = await fetchMemoryRecords(
    {
      workspaceId: "SimulatorLife/AutoDev",
      query: "rule"
    },
    config,
    { fetchImpl: mockFetch }
  );

  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.data.schema, "autodev-memory-records-v1");
    assert.deepEqual(result.data.items, []);
  }
});

test("Memory collection tabs fail closed on an unreadable response", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const scope = {
    workspaceId: "SimulatorLife/AutoDev",
    repositoryId: "SimulatorLife/AutoDev",
    occurredFrom: "2026-10-01T00:00:00.000Z",
    occurredUntil: "2026-10-06T00:00:00.000Z"
  };
  const serve = (body: unknown) => ({
    fetchImpl: async () => Response.json(body)
  });

  // An unreadable page must not render as an empty list: "no records" is a
  // claim about the store, and a shape the Console cannot read supports none.
  for (const broken of [
    { schema: "autodev-memory-records-v0", items: [], total: 0 },
    { schema: "autodev-memory-records-v1", total: 0 },
    { schema: "autodev-memory-records-v1", items: [], total: "0" },
    { schema: "autodev-memory-records-v1", items: {} },
    null
  ]) {
    const records = await fetchMemoryRecords(
      { workspaceId: scope.workspaceId },
      config,
      serve(broken)
    );
    assert.equal(records.kind, "invalid-response", JSON.stringify(broken));
    const experiences = await fetchMemoryExperiences(
      { workspaceId: scope.workspaceId },
      config,
      serve(broken)
    );
    assert.equal(experiences.kind, "invalid-response", JSON.stringify(broken));
  }

  // The cohort page is not paged; missing cells or counts must fail closed
  // rather than collapse into an empty outcome table.
  for (const broken of [
    { schema: "autodev-memory-session-outcome-cohorts-v1", cells: [] },
    {
      schema: "autodev-memory-session-outcome-cohorts-v1",
      cells: [],
      sessionCount: 0
    }
  ]) {
    const cohorts = await fetchMemoryCohorts(scope, config, serve(broken));
    assert.equal(cohorts.kind, "invalid-response", JSON.stringify(broken));
  }

  // A well-formed empty page is still a legitimate observed empty state.
  const empty = await fetchMemoryRecords(
    { workspaceId: scope.workspaceId },
    config,
    serve({
      schema: "autodev-memory-records-v1",
      items: [],
      total: 0,
      limit: 50,
      statusCounts: {
        proposed: 0,
        active: 0,
        superseded: 0,
        invalidated: 0,
        uncertain: 0
      },
      offset: 0
    })
  );
  assert.equal(empty.kind, "ok");
});

test("Agents responses fail closed rather than render an empty Configure surface", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const serve = (body: unknown) => ({
    fetchImpl: async () => Response.json(body)
  });
  const agent = {
    id: "orchestrator",
    role: "orchestrator",
    kind: "orchestrator",
    readOnly: false,
    configured: true,
    valid: null,
    status: "configured",
    convergence: "not-observed",
    primaryModel: "autodev/orchestrator",
    allowedProviders: ["claude"],
    mcps: [],
    skills: [],
    hasPrompt: true
  };
  const page = {
    schema: "autodev-control-agents-v1",
    source: "config/execution-contract.json",
    readOnly: true,
    totalAgents: 1,
    agents: [agent]
  };

  assert.equal((await fetchAgents(config, serve(page))).kind, "ok");

  // Agents had no guard, so a drifted payload rendered an empty Configure
  // surface that reads as "no agents are configured".
  for (const broken of [
    { ...page, schema: "autodev-control-agents-v0" },
    { ...page, totalAgents: "1" },
    { ...page, agents: {} },
    { ...page, agents: [{ ...agent, convergence: "healthy" }] },
    { ...page, agents: [{ ...agent, mcps: "lsp" }] },
    { ...page, agents: [{ ...agent, hasPrompt: "yes" }] },
    { ...page, agents: [{ ...agent, primaryModel: 7 }] },
    null
  ]) {
    assert.equal(
      (await fetchAgents(config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }

  const detail = {
    ...agent,
    schema: "autodev-control-agent-detail-v2",
    promptPath: "agents/prompts/roles/orchestrator.md",
    systemPrompt: "You are the orchestrator.",
    reconciliation: {
      status: {
        convergence: "not-observed",
        desiredGeneration: "a".repeat(64),
        observedGeneration: null,
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: "The runtime has not yet reported observed state."
      },
      history: []
    }
  };
  assert.equal(
    (await fetchAgentDetail("orchestrator", config, serve(detail))).kind,
    "ok"
  );

  for (const broken of [
    { ...detail, schema: "autodev-control-agent-detail-v1" },
    { ...detail, systemPrompt: null },
    { ...detail, promptPath: 5 },
    // The detail page composes configuration, runtime state, and reconciliation,
    // so a payload missing the reconciliation bundle must not render at all.
    { ...detail, reconciliation: undefined },
    {
      ...detail,
      reconciliation: {
        status: { convergence: "fine", explanation: "" },
        history: []
      }
    }
  ]) {
    assert.equal(
      (await fetchAgentDetail("orchestrator", config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }
});

test("Catalog collections fail closed on unreadable responses", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const serve = (body: unknown) => ({
    fetchImpl: async () => Response.json(body)
  });

  // An unreadable catalog reaching a view is an empty collection, and an empty
  // collection is a claim ("no MCP servers are configured") that a shape the
  // Console cannot read does not support.
  //
  // Each accepted fixture below is a *complete* row. That is load-bearing: a row
  // missing only the identifier used to pass here, which is how an incomplete
  // payload reached the view and threw instead of failing closed. See "a catalog
  // row missing the fields its view reads fails closed instead of throwing".
  const mcps = {
    schema: "autodev-control-mcps-v1",
    source: ".rulesync/mcp.jsonc",
    readOnly: true,
    valid: true,
    issues: [],
    servers: [
      {
        name: "lsp",
        enabled: true,
        transport: "stdio",
        targetOverrides: [],
        declared: true,
        roles: []
      }
    ]
  };
  assert.equal((await fetchMcps(config, serve(mcps))).kind, "ok");
  for (const broken of [
    { ...mcps, schema: "autodev-control-mcps-v0" },
    { ...mcps, servers: {} },
    { ...mcps, servers: [{ enabled: true }] },
    { ...mcps, valid: "yes" },
    { ...mcps, valid: false, issues: [{ location: "mcpServers.lsp" }] },
    { ...mcps, valid: false, issues: [{ location: "a", message: 7 }] }
  ]) {
    assert.equal(
      (await fetchMcps(config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }
  // A Runtime that omits the reasons entirely fails closed too. Without this
  // the field could be dropped at the source and every page would still render,
  // reporting "no servers" with no way to tell that from "the servers could not
  // be applied".
  const { issues: _omittedIssues, ...mcpsWithoutIssues } = mcps;
  assert.equal(
    (await fetchMcps(config, serve({ ...mcpsWithoutIssues, valid: false })))
      .kind,
    "invalid-response"
  );

  const tools = {
    schema: "autodev-control-tools-v2",
    source: "catalog",
    readOnly: true,
    coverage: "complete",
    validity: "valid",
    totalTools: 1,
    usageLink: "/usage",
    tools: [
      {
        name: "web_search",
        source: "native",
        sourceAuthority: "codex-native",
        exposedRoles: [],
        availability: "configured"
      }
    ]
  };
  assert.equal((await fetchTools(config, serve(tools))).kind, "ok");
  for (const broken of [
    // Coverage and validity are the page's whole honesty budget; a drifted
    // vocabulary must not silently become "unknown"/"not-observed".
    { ...tools, coverage: "full" },
    { ...tools, validity: "ok" },
    { ...tools, tools: {} },
    { ...tools, totalTools: "1" }
  ]) {
    assert.equal(
      (await fetchTools(config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }

  const hooks = {
    schema: "autodev-control-hooks-v1",
    source: ".rulesync/hooks.jsonc",
    readOnly: true,
    valid: null,
    issues: [],
    hooks: { pre_tool_use: [] }
  };
  assert.equal((await fetchHooks(config, serve(hooks))).kind, "ok");
  assert.equal(
    (await fetchHooks(config, serve({ ...hooks, hooks: [] }))).kind,
    "invalid-response"
  );
  // A response that reports the source invalid but carries no reasons at all is
  // the shape this field exists to end, so it fails closed with the rest.
  const { issues: _absentIssues, ...hooksWithoutIssues } = hooks;
  assert.equal(
    (await fetchHooks(config, serve({ ...hooksWithoutIssues, valid: false })))
      .kind,
    "invalid-response"
  );
  assert.equal(
    (
      await fetchHooks(
        config,
        serve({ ...hooks, issues: [{ location: "line 3" }] })
      )
    ).kind,
    "invalid-response"
  );

  const evaluations = {
    schema: "autodev-control-evaluations-v1",
    source: "evaluations",
    readOnly: true,
    totalEvaluations: 0,
    evaluations: []
  };
  assert.equal((await fetchEvaluations(config, serve(evaluations))).kind, "ok");
  for (const broken of [
    { ...evaluations, schema: "autodev-control-evaluations-v0" },
    { ...evaluations, evaluations: {} },
    { ...evaluations, evaluations: [{ model: "x" }] }
  ]) {
    assert.equal(
      (await fetchEvaluations(config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }

  // A well-formed but empty catalog is still an observed empty state and must
  // keep rendering as empty rather than turning into an error.
  assert.equal(
    (await fetchMcps(config, serve({ ...mcps, servers: [] }))).kind,
    "ok"
  );
});

test("a paged Memory collection fails closed on an unreadable row", async () => {
  // The paged guard checked the envelope and never the items, so a record with
  // no `scope` arrived as `ok` and `formatScopeString` threw on `scope.kind` --
  // a 500 with no `<h1>` on /memory. `MemoryScope` is a union discriminated on
  // `kind`, so each arm has to carry the members its own arm declares;
  // checking only that `kind` is a string lets `kind: "workspace"` with no
  // `workspaceId` render `undefined` as a scope.
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const serve = (body: unknown) => ({
    fetchImpl: async () => Response.json(body)
  });
  const workspaceId = "SimulatorLife/AutoDev";

  const record = {
    id: "r1",
    kind: "claim",
    scope: { kind: "workspace", workspaceId },
    claim: "A durable claim.",
    status: "active",
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "x",
      createdAt: "t"
    },
    validity: { state: "verified", evidence: [] },
    createdAt: "t",
    updatedAt: "t"
  };
  const page = (items: unknown[]) => ({
    schema: "autodev-memory-records-v1",
    items,
    total: items.length,
    limit: 25,
    statusCounts: {
      proposed: 0,
      active: 0,
      superseded: 0,
      invalidated: 0,
      uncertain: 0
    },
    offset: 0
  });
  const list = (body: unknown) =>
    fetchMemoryRecords({ workspaceId }, config, serve(body));

  assert.equal((await list(page([record]))).kind, "ok");
  for (const dropped of [
    "kind",
    "scope",
    "claim",
    "status",
    "provenance",
    "validity",
    "createdAt",
    "updatedAt"
  ]) {
    const incomplete = await list(page([{ ...record, [dropped]: undefined }]));
    assert.equal(
      incomplete.kind,
      "invalid-response",
      `a record without "${dropped}" must not reach the view`
    );
  }

  // Each scope arm carries its own members.
  for (const badScope of [
    { kind: "workspace" },
    { kind: "repository", workspaceId },
    { kind: "role", workspaceId },
    { kind: "task", workspaceId, taskId: "t1" },
    { kind: "agent", workspaceId, taskId: "t1", runId: "r" },
    { kind: "somewhere-new" }
  ]) {
    const result = await list(page([{ ...record, scope: badScope }]));
    assert.equal(
      result.kind,
      "invalid-response",
      `scope ${JSON.stringify(badScope)} must fail closed`
    );
  }
  for (const goodScope of [
    { kind: "global" },
    { kind: "workspace", workspaceId },
    { kind: "repository", workspaceId, repositoryId: "AutoDev" },
    { kind: "role", workspaceId, role: "orchestrator" },
    { kind: "task", workspaceId, taskId: "t1", runId: "r1" },
    { kind: "agent", workspaceId, taskId: "t1", runId: "r1", agentId: "a1" }
  ]) {
    const result = await list(page([{ ...record, scope: goodScope }]));
    assert.equal(
      result.kind,
      "ok",
      `scope ${JSON.stringify(goodScope)} must be accepted`
    );
  }

  // An empty page is still an observed empty state.
  assert.equal((await list(page([]))).kind, "ok");
});

test("Memory detail and the workspace catalog fail closed on unreadable responses", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const serve = (body: unknown) => ({
    fetchImpl: async () => Response.json(body)
  });
  const workspaceId = "SimulatorLife/AutoDev";

  // A *complete* record. This fixture used to be `{ memory: { id: "r1" } }`
  // asserted `ok`, which is the identifier-only payload the row guards were
  // originally written around: it passed, and then the detail view dereferenced
  // `memory.provenance.experienceIds` on nothing. An assertion that encodes the
  // bug is how the bug survives, so the fixture now carries what the view reads.
  const memory = {
    id: "r1",
    kind: "semantic",
    scope: { kind: "workspace", workspaceId },
    claim: "A durable claim.",
    status: "active",
    provenance: {
      experienceIds: ["e1"],
      evidence: [],
      createdBy: "x",
      createdAt: "t"
    },
    validity: { state: "verified", evidence: [] },
    createdAt: "t",
    updatedAt: "t"
  };
  const record = { schema: "autodev-memory-record-v1", memory };
  assert.equal(
    (await fetchMemoryRecord("r1", workspaceId, config, serve(record))).kind,
    "ok"
  );
  // The shape that used to pass and then throw on the detail page.
  assert.notEqual(
    (
      await fetchMemoryRecord(
        "r1",
        workspaceId,
        config,
        serve({ schema: "autodev-memory-record-v1", memory: { id: "r1" } })
      )
    ).kind,
    "ok",
    "an identifier-only record must not reach the detail view"
  );
  for (const broken of [
    { schema: "autodev-memory-record-v0", memory: { id: "r1" } },
    { schema: "autodev-memory-record-v1" },
    { schema: "autodev-memory-record-v1", memory: "r1" }
  ]) {
    assert.equal(
      (await fetchMemoryRecord("r1", workspaceId, config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }

  // A missing `transitions` list is not an empty history; it is an unreadable
  // response, and rendering it as "no history" would be a false claim about a
  // governed durable record.
  const history = {
    schema: "autodev-memory-history-v1",
    // The same complete record: the history panel renders the record's
    // provenance and validity beside its transitions, so an identifier-only
    // `memory` here was a payload that passed and then threw.
    memory,
    relatedMemories: [],
    transitions: []
  };
  assert.equal(
    (await fetchMemoryHistory("r1", workspaceId, config, serve(history))).kind,
    "ok"
  );
  for (const broken of [
    {
      schema: "autodev-memory-history-v1",
      memory: { id: "r1" },
      transitions: []
    },
    { ...history, transitions: {} },
    { ...history, memory: null },
    // A list the panel cannot render is not a history. These rows each drop one
    // field the panel reads, which used to pass the guard and throw during
    // render instead of reporting an unreadable response.
    { ...history, transitions: [{ toStatus: "proposed" }] },
    {
      ...history,
      transitions: [
        {
          toStatus: "proposed",
          action: "proposed",
          actorId: "operator-1",
          reasonCode: "candidate_submitted",
          occurredAt: "2026-10-02T00:00:00Z",
          // A status the Runtime never defined. The badge renders the name
          // verbatim, so accepting it would show a lifecycle state that does
          // not exist.
          fromStatus: "retired"
        }
      ]
    },
    {
      ...history,
      transitions: [
        {
          toStatus: "proposed",
          action: "proposed",
          actorId: "operator-1",
          reasonCode: "candidate_submitted"
        }
      ]
    },
    {
      ...history,
      transitions: [
        {
          toStatus: "retired",
          action: "proposed",
          actorId: "operator-1",
          reasonCode: "candidate_submitted",
          occurredAt: "2026-10-02T00:00:00Z"
        }
      ]
    }
  ]) {
    assert.equal(
      (await fetchMemoryHistory("r1", workspaceId, config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }

  // The catalog scopes every Memory read, so an unreadable catalog must not
  // reach the selector as "no workspaces are configured".
  const catalog = {
    schema: "autodev-control-workspaces-v1",
    source: "config/workspaces.json",
    readOnly: true,
    catalogStatus: "valid",
    totalWorkspaces: 1,
    workspaces: [
      { id: workspaceId, baseBranch: "main", enabled: true, agentRoles: null }
    ]
  };
  assert.equal((await fetchWorkspaces(config, serve(catalog))).kind, "ok");
  for (const broken of [
    { ...catalog, schema: "autodev-control-workspaces-v0" },
    { ...catalog, catalogStatus: "unknown" },
    { ...catalog, workspaces: {} },
    { ...catalog, workspaces: [{ id: workspaceId }] },
    { ...catalog, workspaces: [{ ...catalog.workspaces[0], enabled: "yes" }] },
    { ...catalog, workspaces: [{ ...catalog.workspaces[0], agentRoles: [1] }] }
  ]) {
    assert.equal(
      (await fetchWorkspaces(config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }

  // An unavailable catalog is a legitimate observed state and must keep its
  // own status rather than being flattened into an invalid response.
  const unavailable = await fetchWorkspaces(
    config,
    serve({ ...catalog, catalogStatus: "unavailable", totalWorkspaces: null })
  );
  assert.equal(unavailable.kind, "ok");
});

test("ProvidersView renders the four configuration columns with per-role controls", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: PROVIDERS_FIXTURE,
      models: { status: "available", data: MODELS_FIXTURE }
    })
  );
  assert.match(markup, /data-feature="providers"/);
  assert.match(markup, /<nav aria-label="Providers views"/);
  assert.match(
    markup,
    /data-tab-item="providers"[^>]*>|aria-current="page"[^>]*data-tab-item="providers"/
  );
  assert.match(markup, /data-tab-panel="providers"/);

  // Exactly the four columns the contract names, in its order. Read the label
  // element: two of them carry a help affordance beside the label, and that
  // affordance is not part of the column's name.
  const headers = Array.from(
    markup.matchAll(
      /<th[^>]*>(?:<span data-column-label="[^"]*">([\s\S]*?)<\/span>|([\s\S]*?)<\/th>)/gu
    ),
    (match) => (match[1] ?? match[2] ?? "").replaceAll(/<[^>]*>/g, "").trim()
  );
  assert.deepEqual(headers, ["Provider", "Status", "Roles", "Agent Limits"]);

  // The contract asks for a help affordance on the Roles and Agent Limits
  // headers, and on those two only.
  const helped = Array.from(
    markup.matchAll(/data-column-help="([^"]*)"/gu),
    (match) => match[1]
  );
  assert.deepEqual(helped, ["roles", "agentLimits"]);
  for (const id of helped) {
    // The help text must be on the affordance itself, and long enough to
    // explain something. Attribute order is React's, not ours, so match the
    // element and inspect it rather than assuming a sequence.
    const glyph = new RegExp(
      `<span[^>]*data-column-help="${id}"[^>]*>|<span[^>]*title="([^"]*)"[^>]*data-column-help="${id}"[^>]*>`,
      "u"
    ).exec(markup);
    assert.ok(glyph, `${id} must render a help affordance`);
    const title = /title="([^"]*)"/u.exec(glyph[0])?.[1] ?? "";
    assert.ok(
      title.length >= 40,
      `${id} must carry real help text, not a bare glyph: ${JSON.stringify(title)}`
    );
    assert.match(
      markup,
      new RegExp(
        `aria-label="[^"]*${id === "roles" ? "Roles" : "Agent Limits"}:`,
        "u"
      ),
      `${id} must name itself to a screen reader, not announce a bare "?"`
    );
  }
  for (const removed of [
    "Role enablement",
    "Health",
    "Credential",
    "Models",
    "Tier priority"
  ]) {
    assert.ok(
      !headers.includes(removed),
      `the ${removed} column must not come back`
    );
  }

  // Every one of the four roles gets its own form on every provider row,
  // carrying both the priority and the model it would set.
  const forms = formTags(markup);
  for (const provider of ["claude", "codex"]) {
    for (const role of ["default", "smart", "orchestrator", "subagent"]) {
      const form = forms.find((tag) =>
        tag.includes(`action="/api/providers/${provider}/roles/${role}"`)
      );
      assert.ok(form, `${provider} ${role} controls must be in its row`);
      assert.equal(hiddenValue(markup, form, "returnTo"), "/providers");
      assert.equal(hiddenValue(markup, form, "provider"), provider);
      assert.equal(hiddenValue(markup, form, "role"), role);
    }
  }

  // The read-only codex provider keeps all four roles' controls in place,
  // disabled, with the reason. Its configuration is preserved, not hidden.
  assert.match(
    markup,
    /data-role-form="codex-subagent"[\s\S]*?data-role-priority="subagent"/
  );
  assert.match(
    markup,
    /This provider is disabled\. Enable it to change its roles\./
  );
  // A disabled role's model control stays visible so the chosen model remains
  // recoverable, and is disabled so it cannot become an active selection. The
  // fixture's disabled role is codex's orchestrator.
  assert.match(markup, /data-role-model="orchestrator"[^>]*data-dimmed="true"/);
  assert.match(
    markup,
    /class="[^"]*warning[^"]*"[^>]*data-role-priority="orchestrator"/
  );

  // Each role control carries a distinct id: four role forms submit `priority`
  // from one page, so a shared id would leave every label ambiguous.
  const ids = Array.from(markup.matchAll(/id="(select-[^"]+)"/gu), (m) => m[1]);
  assert.equal(
    new Set(ids).size,
    ids.length,
    `duplicate select ids make labels ambiguous: ${ids.join(", ")}`
  );

  // Status is one verdict per provider, not a summary of parts. claude is both
  // cooling down and missing its credential, and the verdict names the
  // credential: that is the blocker the operator has to fix first, and a
  // verdict that also mentioned the cooldown would be two answers to one
  // question. Exactly one status badge per row.
  assert.match(markup, /Missing LITELLM_API_KEY/);
  assert.match(markup, />Disabled</);
  const badges = markup.match(/data-status="/gu) ?? [];
  // Two providers, two verdicts: the StatCards do not render badges.
  assert.equal(badges.length, 2);

  // Agent Limits: both axes per provider, plus the provider-wide disable.
  for (const provider of ["claude", "codex"]) {
    const form = forms.find((tag) =>
      tag.includes(`action="/api/providers/${provider}/limits"`)
    );
    assert.ok(form, `${provider} agent limits must be in its row`);
    assert.equal(hiddenValue(markup, form, "provider"), provider);
    assert.match(
      markup,
      new RegExp(`data-limit-value="${provider}-perSession"`)
    );
    assert.match(
      markup,
      new RegExp(`data-limit-value="${provider}-acrossSessions"`)
    );
  }
  assert.match(
    markup,
    /action="\/api\/providers\/claude"[\s\S]*?data-provider-disabled="claude"/
  );

  assert.match(markup, /data-section="routing-priority"/);
  assert.match(markup, /orchestrator \(root\)/);
  assert.equal(markup.includes('data-enablement-form="model"'), false);
});

test("a Disabled role's rendered form still submits the five fields its route requires", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: PROVIDERS_FIXTURE,
      models: { status: "available", data: MODELS_FIXTURE }
    })
  );
  const formTag = formTags(markup).find((tag) =>
    /data-role-form="codex-orchestrator"/u.test(tag)
  );
  assert.ok(formTag, "the Disabled role's form must be present");
  // `formTags` yields the opening tag only, so slice the element body out of
  // the markup to inspect what the form actually contains.
  const start = markup.indexOf(formTag);
  const body = markup.slice(start, markup.indexOf("</form>", start));

  // Reproduce what a browser actually submits rather than what the markup
  // contains: a `disabled` control contributes nothing, and a control with no
  // name contributes nothing. The role route rejects anything that is not
  // exactly these five fields, so this is the list that decides whether
  // re-enabling the role works at all.
  //
  // The attribute test must not match Tailwind's `disabled:` variant, which
  // sits in every SelectField's class list: `\bdisabled\b` matches that text
  // and reports every select on the page as disabled.
  const DISABLED_ATTRIBUTE = /(?:^|\s)disabled(?=[\s/>=]|$)/u;
  const submitted: string[] = [];
  for (const control of body.matchAll(/<(input|select)\b([^>]*)>/gu)) {
    const attrs = control[2] ?? "";
    if (DISABLED_ATTRIBUTE.test(attrs)) continue;
    const name = /\bname="([^"]*)"/u.exec(attrs)?.[1];
    if (!name) continue;
    submitted.push(name);
  }
  assert.deepEqual(
    [...submitted].sort(),
    ["model", "priority", "provider", "returnTo", "role"],
    "the Disabled role's form must submit every field the route demands"
  );

  // The model is dimmed and non-interactive, so the value has to arrive from
  // the hidden carry. Drop that carry and this assertion is what fails.
  const selectIsDisabled = /<select[^>]*(?:^|\s)disabled(?:[\s/>=]|>)/u.test(
    body
  );
  assert.ok(
    selectIsDisabled,
    "the role's model select must be disabled while the role is Disabled"
  );
  assert.equal(hiddenValue(markup, formTag, "model"), "");

  // A globally disabled provider disables the priority select as well, so its
  // Apply button could only ever produce a submission the route refuses. It
  // renders disabled with the reason rather than looking actionable.
  const immutableTag = formTags(markup).find((tag) =>
    /data-role-form="codex-subagent"/u.test(tag)
  );
  assert.ok(immutableTag, "the immutable role's form must be present");
  const immutableStart = markup.indexOf(immutableTag);
  const immutableBody = markup.slice(
    immutableStart,
    markup.indexOf("</form>", immutableStart)
  );
  assert.match(immutableBody, /data-apply-role="codex-subagent"/u);
  // Inspect the button's own tag, with the class attribute removed first:
  // Tailwind's `disabled:` variant sits in every Button's class list, so a
  // `disabled` search over the raw tag matches the stylesheet rather than the
  // attribute and would pass with the control left enabled.
  const applyTag = /<button\b[^>]*data-apply-role="codex-subagent"[^>]*>/u.exec(
    immutableBody
  )?.[0];
  assert.ok(applyTag, "the Apply control must still be present");
  const applyAttributes = applyTag.replaceAll(/\sclass="[^"]*"/gu, "");
  assert.match(
    applyAttributes,
    /(?:^|\s)disabled(?=[\s/>=]|>)/u,
    "Apply must render disabled for a globally disabled provider"
  );
  assert.match(
    applyTag,
    /title="This provider is disabled\. Enable it to change its roles\."/u,
    "the disabled Apply must carry its own reason, not borrow the select's"
  );
});

test("a Disabled role whose model is no longer configured still submits a re-enable the Runtime accepts", () => {
  // The Runtime rejects a role body that names a model its provider is not
  // configured for, and it rejects the whole body rather than the model. A carry
  // that forwarded such a model would make the role permanently un-re-enableable:
  // the one control the row exists for would fail every time. The model also has
  // no <option> to render into, so the operator can neither see nor change it.
  const base = PROVIDERS_FIXTURE.providers[0]!;
  const markup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: {
        ...PROVIDERS_FIXTURE,
        providers: [
          {
            ...base,
            id: "antigravity",
            disabled: false,
            // Keep the fixture shapes and change only what this case needs:
            // the provider offers exactly one model, and Default is Disabled
            // while holding a model that is not among them.
            models: [
              {
                model: "gemini-3.8-flash-high",
                tier: base.models[0]?.tier ?? "default"
              }
            ],
            roles: {
              ...base.roles,
              default: {
                ...base.roles.default,
                priority: "disabled",
                model: "a-removed-model"
              }
            }
          }
        ]
      },
      models: { status: "available", data: MODELS_FIXTURE }
    })
  );
  const formTag = formTags(markup).find((tag) =>
    /data-role-form="antigravity-default"/u.test(tag)
  );
  assert.ok(formTag, "the Disabled role form must be present");
  assert.equal(
    hiddenValue(markup, formTag, "model"),
    "",
    "a model this provider no longer offers must not be carried forward"
  );
  const start = markup.indexOf(formTag);
  const body = markup.slice(start, markup.indexOf("</form>", start));
  const submitted = [];
  for (const control of body.matchAll(/<(input|select)\b([^>]*)>/gu)) {
    const attrs = control[2] ?? "";
    if (/(?:^|\s)disabled(?=[\s/>=]|$)/u.test(attrs)) continue;
    const name = /\bname="([^"]*)"/u.exec(attrs)?.[1];
    if (!name) continue;
    submitted.push(name);
  }
  assert.deepEqual(
    [...submitted].sort(),
    ["model", "priority", "provider", "returnTo", "role"],
    "the role must still submit every field the route demands"
  );
});

test("ProvidersView Models tab puts each model's toggle next to the model", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: PROVIDERS_FIXTURE,
      models: { status: "available", data: MODELS_FIXTURE },
      activeTab: "models"
    })
  );
  assert.match(markup, /data-tab-panel="models"/);
  const forms = formTags(markup);
  assert.equal(forms.length, 3);
  for (const model of MODELS_FIXTURE.models) {
    const form = forms.find((tag) =>
      tag.includes(`action="/api/models/${model.id}"`)
    );
    assert.ok(form, `${model.id} toggle must be next to the model`);
    assert.equal(hiddenValue(markup, form, "model"), model.id);
    assert.equal(
      hiddenValue(markup, form, "returnTo"),
      "/providers?tab=models"
    );
    assert.equal(
      hiddenValue(markup, form, "enabled"),
      String(!model.enablement.enabled)
    );
  }
  assert.match(markup, /Claude Sonnet subscription/);
  assert.match(markup, /href="\/providers\/codex\/models\/gpt-6-luna"/);
  assert.equal(markup.includes('data-enablement-form="provider-role"'), false);

  const unavailable = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: PROVIDERS_FIXTURE,
      models: { status: "unavailable", message: "Runtime unreachable" },
      activeTab: "models"
    })
  );
  assert.match(unavailable, /data-status="unavailable"/);
  assert.match(unavailable, /Runtime unreachable/);
  assert.equal(unavailable.includes("<form"), false);
});

test("ProviderDetailView keeps the provider's role and model toggles on its page", () => {
  const claude = PROVIDERS_FIXTURE.providers[0]!;
  const markup = renderToStaticMarkup(
    React.createElement(ProviderDetailView, {
      provider: claude,
      tiers: PROVIDERS_FIXTURE.tiers,
      orchestratorTier: PROVIDERS_FIXTURE.orchestratorTier,
      models: MODELS_FIXTURE.models.filter(
        (model) => model.provider === "claude"
      )
    })
  );
  assert.match(markup, /data-feature="provider-detail"/);
  assert.match(markup, /<a href="\/providers"[^>]*>Providers<\/a>/);
  assert.match(markup, /aria-current="page"[^>]*>claude</);

  const forms = formTags(markup);
  // All four roles get the same controls the Providers row offers, because the
  // contextual-controls rule puts an item's controls on its row *and* in its
  // detail view. They used to drift: this panel used to list two roles.
  const roleForms = forms.filter((form) => form.includes("data-role-form="));
  const modelForms = forms.filter((form) =>
    form.includes('data-enablement-form="model"')
  );
  assert.equal(roleForms.length, 4);
  for (const role of ["default", "smart", "orchestrator", "subagent"]) {
    assert.ok(
      roleForms.some((form) =>
        form.includes(`action="/api/providers/claude/roles/${role}"`)
      ),
      `${role} controls must be on the provider detail page`
    );
  }
  assert.equal(modelForms.length, 2);
  for (const form of forms) {
    assert.equal(hiddenValue(markup, form, "returnTo"), "/providers/claude");
  }
  assert.ok(
    modelForms.some((form) => form.includes('action="/api/models/sonnet"'))
  );

  assert.match(markup, /data-section="provider-health"/);
  assert.match(markup, /2026-10-05T16:00:00.000Z/);
  assert.match(markup, /session_limit · HTTP 429/);
  assert.match(markup, /href="\/usage\?provider=claude"/);
  assert.match(markup, /Orchestrator reasoning effort/);
  assert.match(markup, /Missing LITELLM_API_KEY/);
  assert.equal(markup.includes("gpt-6-luna"), false);

  const withoutModels = renderToStaticMarkup(
    React.createElement(ProviderDetailView, {
      provider: PROVIDERS_FIXTURE.providers[1]!,
      tiers: PROVIDERS_FIXTURE.tiers,
      orchestratorTier: PROVIDERS_FIXTURE.orchestratorTier,
      models: null
    })
  );
  assert.equal(withoutModels.includes('data-enablement-form="model"'), false);
  assert.match(withoutModels, /Model enablement could not be loaded/);
  assert.match(withoutModels, /has not reported live evidence/);
});

test("ProviderDetailView reads an absent provider route without throwing", async () => {
  // `route` is nullable, but "nullable" means the Runtime sent an explicit
  // `null`. A payload that omits the key arrives as `undefined`, which is not
  // `null` -- so a `=== null` guard falls straight through to `.healthUrl` and
  // throws `TypeError: Cannot read properties of undefined`. Nothing in the v2
  // contract requires `route`, and the response guard does not check it, so an
  // omitted route reaches this view rather than being rejected as incompatible.
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const omittedRoute = {
    ...PROVIDERS_FIXTURE,
    providers: PROVIDERS_FIXTURE.providers.map((entry) => {
      const clone: Record<string, unknown> = { ...entry };
      delete clone.route;
      return clone;
    })
  };

  const accepted = await fetchProviders(config, {
    fetchImpl: async () => Response.json(omittedRoute)
  });
  assert.equal(accepted.kind, "ok", "an omitted route is not a v2 violation");
  assert.equal(
    accepted.kind === "ok" && "route" in accepted.data.providers[0]!,
    false,
    "the accepted record really has no route key"
  );

  const render = (provider: ControlApiProviderRecord): string =>
    renderToStaticMarkup(
      React.createElement(ProviderDetailView, {
        provider,
        tiers: PROVIDERS_FIXTURE.tiers,
        orchestratorTier: PROVIDERS_FIXTURE.orchestratorTier,
        models: null
      })
    );

  const omitted = render(
    omittedRoute.providers[0]! as unknown as ControlApiProviderRecord
  );
  assert.match(omitted, /data-feature="provider-detail"/);
  assert.match(omitted, new RegExp(NOT_OBSERVED_LABEL));

  // An explicit null route keeps saying the same thing it always did: the two
  // states stay distinguishable rather than collapsing into one label.
  const explicitNull = render({
    ...PROVIDERS_FIXTURE.providers[0]!,
    route: null
  });
  assert.match(explicitNull, new RegExp(NOT_OBSERVED_LABEL));

  // A present route with no health URL is still "None configured", not
  // "not observed": the fix must not widen the observed case away.
  const noHealthUrl = render({
    ...PROVIDERS_FIXTURE.providers[0]!,
    route: {
      pattern: "^sonnet$",
      baseUrl: "http://127.0.0.1:4000/v1",
      healthUrl: null
    }
  });
  assert.match(noHealthUrl, /None configured/);
  assert.equal(noHealthUrl.includes(NOT_OBSERVED_LABEL), false);
});

test("ModelDetailView renders the model toggle under its provider's breadcrumbs", () => {
  const sonnet = MODELS_FIXTURE.models[1]!;
  const markup = renderToStaticMarkup(
    React.createElement(ModelDetailView, {
      model: sonnet,
      provider: PROVIDERS_FIXTURE.providers[0]!
    })
  );
  assert.match(markup, /data-feature="model-detail"/);
  assert.match(markup, /<a href="\/providers\/claude"[^>]*>claude<\/a>/);
  assert.match(markup, /aria-current="page"[^>]*>sonnet</);
  const forms = formTags(markup);
  assert.equal(forms.length, 1);
  assert.match(forms[0]!, /action="\/api\/models\/sonnet"/);
  assert.equal(
    hiddenValue(markup, forms[0]!, "returnTo"),
    "/providers/claude/models/sonnet"
  );
  assert.equal(hiddenValue(markup, forms[0]!, "enabled"), "true");
  // Every fixed role is listed read-only, with its priority rather than the
  // removed enabled boolean.
  for (const role of ["default", "smart", "orchestrator", "subagent"]) {
    assert.match(markup, new RegExp(`${role}: (P[123]|Disabled)`));
  }
  assert.match(markup, /href="\/usage\?model=sonnet"/);
});

test("ModelDetailView surfaces model convergence as its own verdict beside the toggle", () => {
  const cases = [
    { id: "claude-opus-5-5", status: "converged", generation: "enabled=true" },
    { id: "sonnet", status: "not-observed", generation: "enabled=false" },
    { id: "gpt-6-luna", status: "pending", generation: "enabled=true" }
  ];
  for (const { id, status, generation } of cases) {
    const model = MODELS_FIXTURE.models.find((entry) => entry.id === id)!;
    const markup = renderToStaticMarkup(
      React.createElement(ModelDetailView, {
        model,
        provider: PROVIDERS_FIXTURE.providers[0]!
      })
    );
    // The toggle states the desired change and the convergence verdict states
    // whether the runtime has observed it. Collapsing them would report a
    // model as settled purely because it is switched on.
    assert.match(
      markup,
      new RegExp(
        String.raw`data-section="model-enablement"[\s\S]*?data-status="${status}"`,
        "u"
      ),
      `${id} must render its ${status} verdict`
    );
    assert.match(
      markup,
      new RegExp(`Desired: ${generation}`, "u"),
      `${id} must keep its desired generation reachable`
    );
  }
});

test("Providers surfaces report unconfirmed changes without optimistic state", () => {
  for (const element of [
    React.createElement(ProvidersView, {
      providers: PROVIDERS_FIXTURE,
      models: { status: "available", data: MODELS_FIXTURE },
      controlFailed: true
    }),
    React.createElement(ProviderDetailView, {
      provider: PROVIDERS_FIXTURE.providers[0]!,
      tiers: PROVIDERS_FIXTURE.tiers,
      orchestratorTier: PROVIDERS_FIXTURE.orchestratorTier,
      models: null,
      controlFailed: true
    }),
    React.createElement(ModelDetailView, {
      model: MODELS_FIXTURE.models[0]!,
      provider: null,
      controlFailed: true
    })
  ]) {
    const markup = renderToStaticMarkup(element);
    assert.match(markup, /data-control-outcome="failed"/);
    assert.match(markup, /could not be confirmed/);
  }
});

test("Providers toggles may only return to Providers pages", () => {
  for (const path of [
    "/providers",
    "/providers?tab=providers",
    "/providers?tab=models",
    "/providers/claude",
    "/providers/antigravity/models/gemini-3.8-flash-high"
  ]) {
    assert.equal(isProvidersReturnPath(path), true, path);
  }
  for (const path of [
    null,
    "",
    "/agents",
    "//attacker.test/providers",
    "https://attacker.test/providers",
    "/providers?tab=evil",
    "/providers/../agents",
    "/providers/claude/roles/orchestrator"
  ]) {
    assert.equal(isProvidersReturnPath(path), false, String(path));
  }
  assert.equal(
    withControlFailure("/providers?tab=models"),
    "/providers?tab=models&control=failed"
  );
  assert.equal(
    withControlFailure("/providers/claude"),
    "/providers/claude?control=failed"
  );
});

test("Prompt edit form submits only source content and its revision through the typed Control API", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBaseUrl = process.env.AUTODEV_CONTROL_API_BASE_URL;
  const token = "prompt-route-server-token";
  const content =
    '---\ntargets: ["*"]\ndescription: Updated command.\n---\n\n# Updated\n\nSave canonical text.\n';
  const requests: Array<{
    readonly url: string;
    readonly method: string | undefined;
    readonly headers: Headers;
    readonly body: string;
  }> = [];
  process.env.AUTODEV_CONTROL_API_TOKEN = token;
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: String(init?.body ?? "")
    });
    return Response.json({
      schema: "autodev-control-prompt-command-patch-v2",
      name: "dry",
      revision: "b".repeat(64),
      changed: true,
      diff: {
        summary: "Canonical source updated.",
        identifier: "c".repeat(64)
      },
      reconciliation: {
        status: {
          convergence: "converged",
          desiredGeneration: "c".repeat(64),
          observedGeneration: "c".repeat(64),
          lastApplyAt: "2026-01-01T00:00:00.000Z",
          lastObservationAt: "2026-01-01T00:00:00.000Z",
          lastError: null,
          explanation: "Converged."
        },
        history: []
      }
    });
  };

  try {
    const request = new NextRequest("http://console.test/api/prompts/dry", {
      method: "POST",
      headers: {
        origin: "http://console.test",
        host: "console.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        expectedRevision: "a".repeat(64),
        content
      }).toString()
    });
    const response = await promptMutationRoute.POST(request, {
      params: Promise.resolve({ name: "dry" })
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/prompts/dry");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "http://127.0.0.1:4101/control/prompts/dry");
    assert.equal(requests[0]?.method, "PATCH");
    assert.equal(requests[0]?.headers.get("authorization"), `Bearer ${token}`);
    assert.equal(
      requests[0]?.headers.get("x-autodev-actor"),
      LOCAL_CONTROL_API_ACTOR
    );
    assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
      expectedRevision: "a".repeat(64),
      content
    });
    assert.equal(response.headers.get("location")?.includes(token), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousBaseUrl === undefined)
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    else process.env.AUTODEV_CONTROL_API_BASE_URL = previousBaseUrl;
  }
});

test("Prompt edit route returns an explicit apply-failed state without a success claim", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "prompt-apply-failure-token";
  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          code: "autodev_control_prompt_apply_failed",
          message: "The canonical source was saved, but apply failed."
        }
      },
      { status: 503 }
    );
  try {
    const request = new NextRequest("http://console.test/api/prompts/dry", {
      method: "POST",
      headers: {
        origin: "http://console.test",
        host: "console.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        expectedRevision: "a".repeat(64),
        content: '---\ntargets: ["*"]\ndescription: Save me.\n---\n\nBody\n'
      }).toString()
    });
    const response = await promptMutationRoute.POST(request, {
      params: Promise.resolve({ name: "dry" })
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "/prompts/dry?save=apply-failed"
    );
    assert.equal(
      response.headers.get("location")?.includes("prompt-apply-failure-token"),
      false
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
  }
});

test("Prompt edit route rejects CSRF, malformed forms, and exposes no mutation methods", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "prompt-route-no-fetch-token";
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({ error: "unexpected mutation" }, { status: 500 });
  };

  const validForm = new URLSearchParams({
    expectedRevision: "a".repeat(64),
    content: '---\ntargets: ["*"]\ndescription: Valid.\n---\n\nPrompt\n'
  }).toString();
  const cases = [
    {
      name: "cross-origin origin",
      origin: "http://attacker.test",
      fetchSite: "cross-site",
      contentType: "application/x-www-form-urlencoded",
      body: validForm
    },
    {
      name: "non-same-origin fetch",
      origin: "http://console.test",
      fetchSite: "same-site",
      contentType: "application/x-www-form-urlencoded",
      body: validForm
    },
    {
      name: "extra form field",
      origin: "http://console.test",
      fetchSite: "same-origin",
      contentType: "application/x-www-form-urlencoded",
      body: `${validForm}&extra=value`
    },
    {
      name: "oversized body",
      origin: "http://console.test",
      fetchSite: "same-origin",
      contentType: "application/x-www-form-urlencoded",
      body: "x".repeat(160_001)
    }
  ];

  try {
    for (const testCase of cases) {
      const request = new NextRequest("http://console.test/api/prompts/dry", {
        method: "POST",
        headers: {
          origin: testCase.origin,
          host: "console.test",
          "sec-fetch-site": testCase.fetchSite,
          "content-type": testCase.contentType
        },
        body: testCase.body
      });
      const response = await promptMutationRoute.POST(request, {
        params: Promise.resolve({ name: "dry" })
      });
      assert.equal(response.status, 303, testCase.name);
      assert.equal(
        response.headers.get("location"),
        "/prompts/dry?save=failed",
        testCase.name
      );
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
  }

  assert.equal("GET" in promptMutationRoute, false);
  assert.equal("PATCH" in promptMutationRoute, false);
  assert.equal("PUT" in promptMutationRoute, false);
  assert.equal("DELETE" in promptMutationRoute, false);
});

const CONTROL_ROUTE_ENV_KEYS = [
  "AUTODEV_CONTROL_API_TOKEN",
  "AUTODEV_CONTROL_API_BASE_URL"
] as const;

async function withControlRouteEnvironment(
  token: string,
  fetchImpl: typeof fetch,
  run: () => Promise<void>
): Promise<void> {
  const previousFetch = globalThis.fetch;
  const saved = Object.fromEntries(
    CONTROL_ROUTE_ENV_KEYS.map((key) => [key, process.env[key]])
  );
  process.env.AUTODEV_CONTROL_API_TOKEN = token;
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of CONTROL_ROUTE_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function sameOriginFormRequest(
  path: string,
  body: string,
  overrides: {
    readonly origin?: string;
    readonly fetchSite?: string;
    readonly contentType?: string;
  } = {}
): NextRequest {
  return new NextRequest("http://console.test" + path, {
    method: "POST",
    headers: {
      origin: overrides.origin ?? "http://console.test",
      host: "console.test",
      "sec-fetch-site": overrides.fetchSite ?? "same-origin",
      "content-type":
        overrides.contentType ?? "application/x-www-form-urlencoded"
    },
    body
  });
}

test("every provider mutation addresses its canonical Control API path", async () => {
  // The limits path was built as `/control/providers/claudelimits` — the suffix
  // carried no separator. `claudelimits` is a legal provider id, so the request
  // matched the single-provider route instead and came back as an unknown
  // provider: every agent-limits mutation failed while the controls rendered
  // correctly and every test still passed, because each one stubbed the fetch
  // and asserted the body without ever asserting the URL.
  const token = "provider-path-route-server-token";
  const requested: string[] = [];
  await withControlRouteEnvironment(
    token,
    async (input) => {
      requested.push(String(input));
      return Response.json({
        schema: "autodev-control-provider-limits-v1",
        provider: "claude",
        agentLimits: { perSession: 3, acrossSessions: null },
        previous: null,
        actor: LOCAL_CONTROL_API_ACTOR,
        reconciliation: { status: {}, history: [] }
      });
    },
    async () => {
      const limits = await providerLimitsRoute.POST(
        sameOriginFormRequest(
          "/api/providers/claude/limits",
          new URLSearchParams({
            provider: "claude",
            returnTo: "/providers",
            perSession: "unlimited",
            acrossSessions: "unlimited",
            setPerSession: "3"
          }).toString()
        ),
        { params: Promise.resolve({ provider: "claude" }) }
      );
      assert.equal(limits.status, 303);
      assert.equal(limits.headers.get("location"), "/providers");
    }
  );

  // Compare the path, not the origin: the harness allocates a port per
  // environment, and the port is not what this test is about.
  assert.deepEqual(
    requested.map((url) => new URL(url).pathname),
    ["/control/providers/claude/limits"]
  );
  // The same separator rule governs the single-provider mutation, which has no
  // suffix at all and must not grow a trailing slash.
  assert.equal(
    requested.every((url) => !url.includes("claudelimits")),
    true,
    "a provider id and a path segment must never be concatenated"
  );
});

test("provider-role Console route sends only a same-origin typed PATCH and returns to the toggle's page", async () => {
  const token = "provider-role-route-server-token";
  const requests: Array<{
    readonly url: string;
    readonly method: string | undefined;
    readonly headers: Headers;
    readonly body: string;
  }> = [];
  await withControlRouteEnvironment(
    token,
    async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: String(init?.body ?? "")
      });
      return Response.json({
        schema: "autodev-control-provider-role-v3",
        provider: "codex",
        role: "orchestrator",
        priority: "disabled",
        model: null,
        previous: null,
        actor: LOCAL_CONTROL_API_ACTOR
      });
    },
    async () => {
      const response = await providerRoleRoute.POST(
        sameOriginFormRequest(
          "/api/providers/codex/roles/orchestrator",
          new URLSearchParams({
            provider: "codex",
            role: "orchestrator",
            priority: "disabled",
            model: "",
            returnTo: "/providers/codex"
          }).toString()
        ),
        { params: Promise.resolve({ provider: "codex", role: "orchestrator" }) }
      );

      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/providers/codex");
      assert.equal(requests.length, 1);
      assert.equal(
        requests[0]?.url,
        "http://127.0.0.1:4101/control/providers/codex/roles/orchestrator"
      );
      assert.equal(requests[0]?.method, "PATCH");
      assert.equal(
        requests[0]?.headers.get("authorization"),
        "Bearer " + token
      );
      assert.equal(
        requests[0]?.headers.get("x-autodev-actor"),
        LOCAL_CONTROL_API_ACTOR
      );
      assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
        priority: "disabled",
        model: null
      });
    }
  );
});

test("provider-role Console route fails closed for CSRF, foreign return paths, and malformed or oversized forms", async () => {
  let fetchCalls = 0;
  const validFields = {
    provider: "codex",
    role: "orchestrator",
    priority: "1",
    model: "gpt-6-luna",
    returnTo: "/providers/codex"
  };
  const validBody = new URLSearchParams(validFields).toString();
  const DEFAULT_FAILURE = "/providers?control=failed";
  const PAGE_FAILURE = "/providers/codex?control=failed";
  const cases = [
    {
      name: "cross-origin Origin",
      origin: "http://attacker.test",
      fetchSite: "cross-site",
      expected: DEFAULT_FAILURE
    },
    {
      name: "same-site but not same-origin fetch",
      fetchSite: "same-site",
      expected: DEFAULT_FAILURE
    },
    {
      name: "malformed Origin with a path",
      origin: "http://console.test/attacker",
      expected: DEFAULT_FAILURE
    },
    {
      name: "content type prefix spoof",
      contentType: "application/x-www-form-urlencoded-evil",
      expected: DEFAULT_FAILURE
    },
    {
      name: "path traversal provider",
      provider: "..",
      expected: DEFAULT_FAILURE
    },
    {
      name: "oversized body",
      body: "x".repeat(4097),
      expected: DEFAULT_FAILURE
    },
    {
      name: "foreign return path",
      body: new URLSearchParams({
        ...validFields,
        returnTo: "https://attacker.test/"
      }).toString(),
      expected: DEFAULT_FAILURE
    },
    {
      name: "non-Providers return path",
      body: new URLSearchParams({
        ...validFields,
        returnTo: "/agents"
      }).toString(),
      expected: DEFAULT_FAILURE
    },
    {
      name: "extra form field",
      body: validBody + "&extra=value",
      expected: PAGE_FAILURE
    },
    {
      name: "provider and role mismatch",
      role: "subagent",
      expected: PAGE_FAILURE
    },
    {
      name: "priority the operator never chose",
      body: new URLSearchParams({
        ...validFields,
        priority: ""
      }).toString(),
      expected: PAGE_FAILURE
    },
    {
      name: "priority outside P1/P2/P3/Disabled",
      body: new URLSearchParams({
        ...validFields,
        priority: "P1"
      }).toString(),
      expected: PAGE_FAILURE
    }
  ];

  await withControlRouteEnvironment(
    "provider-role-no-fetch-token",
    async () => {
      fetchCalls += 1;
      return Response.json({ error: "unexpected mutation" }, { status: 500 });
    },
    async () => {
      for (const testCase of cases) {
        const provider = testCase.provider ?? "codex";
        const role = testCase.role ?? "orchestrator";
        const response = await providerRoleRoute.POST(
          sameOriginFormRequest(
            `/api/providers/${provider}/roles/${role}`,
            testCase.body ?? validBody,
            testCase
          ),
          { params: Promise.resolve({ provider, role }) }
        );
        assert.equal(response.status, 303, testCase.name);
        assert.equal(
          response.headers.get("location"),
          testCase.expected,
          testCase.name
        );
      }
      assert.equal(fetchCalls, 0);
    }
  );
});

test("Providers mutation routes export only POST", () => {
  for (const route of [
    providerRoleRoute,
    providerRoute,
    providerLimitsRoute,
    modelRoute
  ]) {
    assert.equal(typeof route.POST, "function");
    assert.equal("GET" in route, false);
    assert.equal("PATCH" in route, false);
    assert.equal("PUT" in route, false);
    assert.equal("DELETE" in route, false);
  }
});

test("provider-role Console route returns an unconfirmed failure when Runtime rejects the PATCH", async () => {
  await withControlRouteEnvironment(
    "provider-role-rejected-token",
    async () =>
      Response.json(
        {
          error: {
            code: "autodev_control_api_operator_required",
            message: "An operator actor is required.",
            status: 403
          }
        },
        { status: 403 }
      ),
    async () => {
      const response = await providerRoleRoute.POST(
        sameOriginFormRequest(
          "/api/providers/codex/roles/orchestrator",
          new URLSearchParams({
            provider: "codex",
            role: "orchestrator",
            enabled: "false",
            returnTo: "/providers?tab=providers"
          }).toString()
        ),
        { params: Promise.resolve({ provider: "codex", role: "orchestrator" }) }
      );
      assert.equal(response.status, 303);
      assert.equal(
        response.headers.get("location"),
        "/providers?tab=providers&control=failed"
      );
      assert.equal(
        response.headers.get("location")?.includes("rejected-token"),
        false
      );
    }
  );
});

test("model Console route sends a typed model PATCH and returns to the toggle's page", async () => {
  const token = "model-route-server-token";
  const requests: Array<{
    readonly url: string;
    readonly method: string | undefined;
    readonly headers: Headers;
    readonly body: string;
  }> = [];
  await withControlRouteEnvironment(
    token,
    async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: String(init?.body ?? "")
      });
      return Response.json({
        schema: "autodev-control-model-v1",
        model: "gemini-3.8-flash-high",
        enabled: false,
        previous: true,
        actor: LOCAL_CONTROL_API_ACTOR
      });
    },
    async () => {
      const response = await modelRoute.POST(
        sameOriginFormRequest(
          "/api/models/gemini-3.8-flash-high",
          new URLSearchParams({
            model: "gemini-3.8-flash-high",
            enabled: "false",
            returnTo: "/providers?tab=models"
          }).toString()
        ),
        { params: Promise.resolve({ model: "gemini-3.8-flash-high" }) }
      );
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/providers?tab=models");
      assert.equal(requests.length, 1);
      assert.equal(
        requests[0]?.url,
        "http://127.0.0.1:4101/control/models/gemini-3.8-flash-high"
      );
      assert.equal(requests[0]?.method, "PATCH");
      assert.equal(
        requests[0]?.headers.get("authorization"),
        "Bearer " + token
      );
      assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
        enabled: false
      });
    }
  );
});

test("model Console route fails closed and reports Runtime rejections without a success claim", async () => {
  let fetchCalls = 0;
  const fields = {
    model: "sonnet",
    enabled: "true",
    returnTo: "/providers/claude/models/sonnet"
  };
  const cases = [
    {
      name: "cross-origin Origin",
      origin: "http://attacker.test",
      fetchSite: "cross-site",
      expected: "/providers?tab=models&control=failed"
    },
    {
      name: "invalid model segment",
      model: "../agents",
      expected: "/providers?tab=models&control=failed"
    },
    {
      name: "foreign return path",
      body: new URLSearchParams({
        ...fields,
        returnTo: "//attacker.test"
      }).toString(),
      expected: "/providers?tab=models&control=failed"
    },
    {
      name: "model mismatch",
      model: "claude-opus-5-5",
      expected: "/providers/claude/models/sonnet?control=failed"
    },
    {
      name: "non-boolean enabled",
      body: new URLSearchParams({ ...fields, enabled: "yes" }).toString(),
      expected: "/providers/claude/models/sonnet?control=failed"
    }
  ];
  await withControlRouteEnvironment(
    "model-route-no-fetch-token",
    async () => {
      fetchCalls += 1;
      return Response.json({ error: "unexpected mutation" }, { status: 500 });
    },
    async () => {
      for (const testCase of cases) {
        const model = testCase.model ?? "sonnet";
        const response = await modelRoute.POST(
          sameOriginFormRequest(
            `/api/models/${model}`,
            testCase.body ?? new URLSearchParams(fields).toString(),
            testCase
          ),
          { params: Promise.resolve({ model }) }
        );
        assert.equal(response.status, 303, testCase.name);
        assert.equal(
          response.headers.get("location"),
          testCase.expected,
          testCase.name
        );
      }
      assert.equal(fetchCalls, 0);
    }
  );

  await withControlRouteEnvironment(
    "model-route-rejected-token",
    async () =>
      Response.json(
        {
          error: {
            code: "autodev_control_api_unknown_model",
            message: "Unknown model.",
            status: 404
          }
        },
        { status: 404 }
      ),
    async () => {
      const response = await modelRoute.POST(
        sameOriginFormRequest(
          "/api/models/sonnet",
          new URLSearchParams(fields).toString()
        ),
        { params: Promise.resolve({ model: "sonnet" }) }
      );
      assert.equal(
        response.headers.get("location"),
        "/providers/claude/models/sonnet?control=failed"
      );
    }
  );
});

test("Console rejects provider and model responses that do not match the v2 contracts", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const providersV1 = await fetchProviders(config, {
    fetchImpl: async () =>
      Response.json({
        schema: "autodev-control-providers-v1",
        providers: [],
        disabledOrchestratorProviders: [],
        disabledSubagentProviders: []
      })
  });
  assert.equal(providersV1.kind, "invalid-response");
  const modelsV1 = await fetchModels(config, {
    fetchImpl: async () =>
      Response.json({
        schema: "autodev-control-models-v1",
        source: "codex-model-catalog.json",
        readOnly: true,
        totalModels: 0,
        models: []
      })
  });
  assert.equal(modelsV1.kind, "invalid-response");

  const providers = await fetchProviders(config, {
    fetchImpl: async () => Response.json(PROVIDERS_FIXTURE)
  });
  assert.equal(providers.kind, "ok");
  const models = await fetchModels(config, {
    fetchImpl: async () => Response.json(MODELS_FIXTURE)
  });
  assert.equal(models.kind, "ok");
});

test("Console rejects a runtime response that does not match the v1 contract", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const valid = {
    schema: "autodev-control-runtime-v1",
    routerInstanceId: "router-uuid-test",
    lifecycle: {
      state: "ready",
      draining: false,
      changedAt: "2026-10-05T15:00:00.000Z",
      activeResponseRequests: 1
    },
    concurrency: { effectivePerSessionLimit: 2, activeSubagentThreads: 1 },
    inFlightRequestCount: 1
  };
  assert.equal(
    (
      await fetchRuntime(config, {
        fetchImpl: async () => Response.json(valid)
      })
    ).kind,
    "ok"
  );
  const withDenial = await fetchRuntime(config, {
    fetchImpl: async () =>
      Response.json({
        ...valid,
        concurrency: {
          effectivePerSessionLimit: 8,
          denials: 17,
          denialsByReason: { per_session_limit: 12 },
          lastDenial: {
            requestId: "req-1",
            role: "orchestrator",
            reason: "per_session_limit",
            timestamp: "2026-10-06T09:38:02.000Z"
          }
        }
      })
  });
  assert.equal(withDenial.kind, "ok");

  // Runtime had no response guard at all, so every one of these rendered as a
  // healthy runtime. Each must fail closed into an explicit unavailable state
  // instead of reporting numbers nobody measured.
  for (const broken of [
    { ...valid, schema: "autodev-control-runtime-v0" },
    { ...valid, routerInstanceId: 7 },
    { ...valid, lifecycle: { state: 1 } },
    // A string that is not a state this build has a word for. `typeof === "string"`
    // accepted it, and the Console renders this value as the operator-facing word
    // on a status badge — so an unknown state reached a reader verbatim instead of
    // failing closed. The Runtime only ever emits `ready` or `draining`.
    { ...valid, lifecycle: { ...valid.lifecycle, state: "restarting" } },
    { ...valid, lifecycle: { state: "ready", draining: "yes" } },
    { ...valid, concurrency: { effectivePerSessionLimit: "two" } },
    { ...valid, concurrency: { denialsByReason: { cap: "many" } } },
    // A recorded denial is a real object; only its absence or nullness counts
    // as "no denial observed". Rejecting the object would discard evidence.
    { ...valid, concurrency: { lastDenial: "per_session_limit" } },
    { ...valid, inFlightRequestCount: null }
  ]) {
    assert.equal(
      (
        await fetchRuntime(config, {
          fetchImpl: async () => Response.json(broken)
        })
      ).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }
});

test("AgentsView reports runtime counters as unobserved instead of zero", () => {
  const runtime = {
    schema: "autodev-control-runtime-v1",
    routerInstanceId: "router-uuid-test",
    lifecycle: {
      state: "ready",
      draining: true,
      changedAt: "2026-10-06T09:00:00.000Z",
      activeResponseRequests: 0
    },
    // A Runtime that has no concurrency evidence omits the fields rather than
    // reporting zero, so the Console must not turn their absence into a zero.
    concurrency: {},
    inFlightRequestCount: 0
  } as const;
  const markup = renderToStaticMarkup(
    React.createElement(AgentsView, {
      agents: [CONFIGURED_AGENT],
      providers: PROVIDERS_FIXTURE,
      runtime
    })
  );
  assert.match(markup, /data-section="runtime-health"/);
  for (const label of [
    "Session Concurrency Limit",
    "Active Subagent Threads",
    "Active Sessions",
    "Total Denials"
  ]) {
    const start = markup.indexOf(label);
    assert.ok(start > 0, `${label} must be rendered`);
    const cell = markup.slice(start, start + 400);
    assert.match(cell, /Not observed/u, `${label} must not read as a zero`);
  }
  // Draining is its own operational state and must not collapse into "ready".
  assert.match(markup, /Draining/);
});

test("next dev and the production build never share a dist directory", () => {
  // The LaunchAgent's `next start` and run-codex-console.sh's BUILD_ID gate
  // read the production build from console/.next.
  assert.equal(CONSOLE_BUILD_DIST_DIR, ".next");
  assert.notEqual(CONSOLE_DEV_DIST_DIR, CONSOLE_BUILD_DIST_DIR);
  assert.equal(consoleDistDir(PHASE_DEVELOPMENT_SERVER), CONSOLE_DEV_DIST_DIR);
  assert.equal(consoleDistDir(PHASE_PRODUCTION_BUILD), CONSOLE_BUILD_DIST_DIR);
  assert.equal(consoleDistDir(PHASE_PRODUCTION_SERVER), CONSOLE_BUILD_DIST_DIR);
});

test("ToolsView applies URL-addressable source and role filters without losing catalog coverage banner", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "complete",
      validity: "valid",
      usageLink: "/usage",
      filters: { source: "mcp", role: "" },
      tools: [
        {
          name: "lsp_goto_definition",
          source: "mcp",
          sourceAuthority: "execution-contract",
          server: "lsp",
          availability: "configured",
          exposedRoles: ["default", "worker"]
        },
        {
          name: "web_search",
          source: "native",
          sourceAuthority: "codex-native",
          availability: "configured",
          exposedRoles: ["docs-researcher"]
        },
        {
          name: "request_user_input",
          source: "plugin",
          sourceAuthority: "rulesync-plugin",
          server: "codex_app",
          availability: "configured",
          exposedRoles: ["orchestrator"]
        },
        {
          name: "unknown_native",
          source: "native",
          sourceAuthority: "codex-native",
          availability: "not-observed",
          exposedRoles: []
        }
      ]
    })
  );
  // Filter is active for mcp only.
  assert.match(markup, /data-source-filter="mcp"[^>]*bg-surface-raised/);
  assert.match(markup, /Showing 1 of 4 tool entries/);
  // MCP entry is visible; native and plugin are filtered out.
  assert.match(markup, /lsp_goto_definition/);
  assert.doesNotMatch(markup, /data-tool-name="web_search"/);
  assert.doesNotMatch(markup, /request_user_input/);
  // Composite catalog coverage banner stays accurate.
  assert.match(markup, /data-tools-coverage="complete"/);
  assert.match(markup, /Composite catalog: RuleSync MCP declarations/);
});

test("ToolsView renders a Not observed availability badge when source authority is missing", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      validity: "valid",
      usageLink: "/usage",
      filters: { source: "", role: "" },
      tools: [
        {
          name: "future_tool",
          source: "mcp",
          sourceAuthority: "execution-contract",
          server: "future",
          availability: "not-observed",
          exposedRoles: [],
          canonicalEditSurface: {
            section: "mcps",
            identifier: "future",
            label: "MCP future"
          }
        }
      ]
    })
  );
  assert.match(markup, /data-status="not-observed"/);
  assert.match(markup, /No roles assigned/);
  // The catalog still links to the canonical MCP edit surface.
  assert.match(markup, /href="\/mcps\/future"/);
});

test("ToolsView reports explicit invalid source via the error vocabulary", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "unavailable",
      validity: "invalid",
      usageLink: "/usage",
      filters: { source: "", role: "" },
      tools: []
    })
  );
  assert.match(markup, /data-tools-validity="invalid"/);
  assert.match(markup, /source is invalid/);
});

test("ToolDetailView renders source authority, edit surface, and unobserved historical use", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolDetailView, {
      tool: {
        name: "lsp_goto_definition",
        source: "mcp",
        sourceAuthority: "execution-contract",
        server: "lsp",
        availability: "configured",
        exposedRoles: ["default", "worker"],
        canonicalEditSurface: {
          section: "mcps",
          identifier: "lsp",
          label: "MCP lsp"
        }
      },
      coverage: "complete",
      validity: "valid",
      usage: { calls: null, errors: null, observed: false },
      usageLink: "/usage",
      usageUnavailable: false
    })
  );
  assert.match(markup, /data-tool-name="mcp__lsp__lsp_goto_definition"/);
  assert.match(markup, /Source authority/);
  assert.match(markup, /Role exposure/);
  assert.match(markup, /Historical use/);
  assert.match(markup, /No recorded tool calls/);
  assert.match(markup, /href="\/mcps\/lsp"/);
  // No raw usage values are rendered when unobserved.
  assert.doesNotMatch(markup, /0</);
});

test("every detail view titles its resource with the one canonical entity title", () => {
  // A detail view used to invent its own title treatment: `/tools` emitted a
  // second `h1` under the shell's, `/memory` skipped to `h3` at a third of the
  // size, and each view spelled the class out separately. Every detail view now
  // renders the shared title, so moving between them cannot change how the
  // subject of the page looks or where it sits in the document outline.
  const views: ReadonlyArray<readonly [string, string, React.ReactElement]> = [
    [
      "ToolDetailView",
      "mcp__lsp__lsp_goto_definition",
      React.createElement(ToolDetailView, {
        tool: {
          name: "lsp_goto_definition",
          source: "mcp",
          sourceAuthority: "execution-contract",
          server: "lsp",
          availability: "configured",
          exposedRoles: ["default"],
          canonicalEditSurface: {
            section: "mcps",
            identifier: "lsp",
            label: "lsp"
          }
        },
        coverage: "complete",
        validity: "valid",
        usage: { calls: null, errors: null, observed: false },
        usageLink: "/usage",
        usageUnavailable: false
      })
    ],
    [
      "McpDetailView",
      "context7",
      React.createElement(McpDetailView, {
        sourceValidity: true,
        configuredTools: null,
        server: {
          name: "context7",
          enabled: true,
          transport: "http",
          declared: true,
          targetOverrides: [{ target: "codexcli", enabled: false }],
          roles: ["docs-researcher"]
        },
        activeTab: "overview"
      })
    ],
    [
      "PromptDetailView",
      "dry",
      React.createElement(PromptDetailView, {
        prompt: promptDocumentFromControlApi({
          schema: "autodev-control-prompt-detail-v4",
          name: "dry",
          type: "command",
          source: ".rulesync/commands/dry.md",
          content: "# /dry\n\nUse a dry run.",
          preview: "## Rendered Prompt\n\n**Use a dry run.**",
          revision: "a".repeat(64),
          diff: {
            summary: "Canonical RuleSync command.",
            identifier: "a".repeat(64)
          },
          reconciliation: {
            status: {
              convergence: "not-observed",
              desiredGeneration: null,
              observedGeneration: null,
              lastApplyAt: null,
              lastObservationAt: null,
              lastError: null,
              explanation: "Not observed."
            },
            history: []
          }
        }),
        reconciliation: unobservedPromptReconciliation,
        history: unavailablePromptHistory
      })
    ]
  ];

  for (const [name, entityName, element] of views) {
    const markup = renderToStaticMarkup(element);
    // The title is the `h2` beneath the shell's `h1`, never another `h1`.
    assert.doesNotMatch(markup, /<h1[\s>]/, `${name} must not emit an h1`);
    assert.doesNotMatch(markup, /<h3[^>]*>\s*<\/h3>/);
    assert.match(
      markup,
      new RegExp(
        `<h2 class="${ENTITY_TITLE_CLASS}( font-mono)?">${entityName}</h2>`
      ),
      `${name} must title the resource with the canonical entity title`
    );
    assert.doesNotMatch(
      markup,
      /text-2xl font-bold text-fg[^"]*"[^>]*><\/(?!h2)/,
      `${name} must not hand-roll an entity title`
    );

    // A title at the right level is only half the outline. `ToolDetailView`
    // emitted its title as the canonical `h2` and its four section headings as
    // `h2` as well, so they were siblings of the thing they belonged to -- the
    // outline read flat there and nested on every sibling surface, where
    // `/mcps`, `/providers` and `/prompts` all demote their sections to `h3`.
    // Nothing caught it because "no heading skips" is the opposite condition:
    // `h2` followed by `h2` skips nothing.
    //
    // Sections are identified by the shared class they render, not by the name
    // of the constant supplying it -- markup carries the value, so matching
    // "SECTION_HEADING" against the output finds nothing at all.
    const sectionLevels = Array.from(
      markup.matchAll(
        new RegExp(
          String.raw`<h([1-6])\b[^>]*class="${SECTION_HEADING_CLASS}"`,
          "gu"
        )
      ),
      (m) => Number(m[1])
    );
    assert.ok(
      sectionLevels.length > 0,
      `${name} renders no SECTION_HEADING_CLASS heading, so the level check ` +
        `below proves nothing -- the shared class is what identifies a section`
    );
    for (const level of sectionLevels) {
      assert.equal(
        level,
        3,
        `${name} nests a section at h${level} (levels present: ` +
          `${[...new Set(sectionLevels)].join(", ")}); the entity title is the ` +
          `h2, so its sections must be h3 or they read as siblings of their ` +
          `own title`
      );
    }
  }
});

test("ToolDetailView surfaces observed historical use and falls back to Unavailable when telemetry errors", () => {
  const observedMarkup = renderToStaticMarkup(
    React.createElement(ToolDetailView, {
      tool: {
        name: "request_user_input",
        source: "plugin",
        sourceAuthority: "rulesync-plugin",
        server: "codex_app",
        availability: "configured",
        exposedRoles: ["orchestrator"],
        canonicalEditSurface: {
          section: "mcps",
          identifier: "codex_app",
          label: "MCP codex_app"
        }
      },
      coverage: "complete",
      validity: "valid",
      usage: { calls: 12, errors: null, observed: true },
      usageLink: "/usage",
      usageUnavailable: false
    })
  );
  assert.match(
    observedMarkup,
    /data-tool-name="mcp__codex_app__request_user_input"/
  );
  assert.match(observedMarkup, /Calls \(24h\)/);
  assert.match(observedMarkup, /12/);

  const unavailableMarkup = renderToStaticMarkup(
    React.createElement(ToolDetailView, {
      tool: {
        name: "request_user_input",
        source: "plugin",
        sourceAuthority: "rulesync-plugin",
        server: "codex_app",
        availability: "configured",
        exposedRoles: ["orchestrator"],
        canonicalEditSurface: {
          section: "mcps",
          identifier: "codex_app",
          label: "MCP codex_app"
        }
      },
      coverage: "complete",
      validity: "valid",
      usage: { calls: null, errors: null, observed: false },
      usageLink: "/usage",
      usageUnavailable: true
    })
  );
  assert.match(unavailableMarkup, /Usage telemetry unavailable/);
});

/**
 * Purge erases a raw experience envelope irreversibly. The Console ships no
 * client JavaScript, so the confirmation cannot be a `window.confirm` or a
 * disabled-until-checked button: it has to be a field the route refuses to act
 * without. These tests pin that the route only forwards a purge that carries an
 * experience id, a Runtime-accepted reason, and explicit confirmation.
 */
function memoryPurgeRequest(fields: Record<string, string>): NextRequest {
  return new NextRequest("http://console.test/api/memory", {
    method: "POST",
    headers: {
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(fields).toString()
  });
}

async function withMemoryRoute(
  run: (
    requests: { url: string; method: string; body: string }[]
  ) => Promise<void>,
  respond: () => Response = () =>
    Response.json({ purged: true }, { status: 200 })
): Promise<void> {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const token = "p".repeat(64);
  process.env.AUTODEV_CONTROL_API_TOKEN = token;
  const requests: { url: string; method: string; body: string }[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const request = input as Request;
    requests.push({
      url: String(request.url ?? input),
      method: init?.method ?? "GET",
      body: String(init?.body ?? "")
    });
    return respond();
  }) as typeof fetch;

  try {
    await run(requests);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
  }
}

test("Memory purge forwards to the Runtime purge endpoint only with a valid reason and explicit confirmation", async () => {
  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "purge",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        reason: "privacy_request",
        confirm: "purge"
      })
    );

    assert.equal(response.status, 303);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.url,
      "http://127.0.0.1:4101/control/memory/experiences/exp-1/purge?workspaceId=SimulatorLife%2FAutoDev"
    );
    assert.equal(requests[0]?.method, "POST");
    // The Runtime accepts exactly `{ reason }` and rejects extra keys.
    assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
      reason: "privacy_request"
    });
  });
});

test("Memory purge refuses without explicit confirmation and never reaches the Runtime", async () => {
  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "purge",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        reason: "privacy_request"
      })
    );

    // A form submission is a browser navigation, so a refusal redirects back
    // into the Console carrying the shared notice rather than dumping JSON.
    assert.equal(response.status, 303);
    // The refusal re-selects the experience. It used to redirect without any
    // identifier at all, and this exact string asserted that: the operator who
    // tried to erase one envelope was returned to the bare table with nothing
    // on the page saying which row had been refused. It now also carries
    // `refusal=confirmation_missing`, because this route -- not the Runtime --
    // decided the request, and "tick the box" is the whole next step.
    assert.equal(
      response.headers.get("location"),
      "/memory?tab=experiences&experienceId=exp-1&workspaceId=SimulatorLife%2FAutoDev&control=failed&refusal=confirmation_missing"
    );
    assert.equal(requests.length, 0);
  });
});

test("Memory purge refuses a reason the Runtime does not accept", async () => {
  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "purge",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        reason: "because",
        confirm: "purge"
      })
    );

    assert.equal(response.status, 303);
    // The confirmation was ticked and the form was otherwise complete, so the
    // refusal must not blame the confirmation. This is the case that stops a
    // fix keying the reason off the action: "purge" here means the box was
    // ticked, and the only thing wrong with the submission is the reason code.
    assert.equal(
      response.headers.get("location"),
      "/memory?tab=experiences&experienceId=exp-1&workspaceId=SimulatorLife%2FAutoDev&control=failed&refusal=reason_not_accepted"
    );
    assert.equal(requests.length, 0);
  });
});

test("storage status is read for what it observed, not inferred from the failure", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const read = async (storage: Record<string, unknown>): Promise<boolean> => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        schema: "autodev-memory-status-v1",
        storage
      })) as typeof fetch;
    try {
      return (await fetchMemoryStatus(config)).kind === "ok";
    } finally {
      globalThis.fetch = previousFetch;
    }
  };

  // The three states are the whole contract. A validator that accepted any
  // string would let a Runtime that changed its vocabulary render as
  // "unavailable" -- the one answer this read exists to avoid, arriving through
  // the read meant to prevent it.
  for (const state of ["not_configured", "unreachable", "reachable"]) {
    assert.equal(
      await read({
        state,
        backend: "postgresql",
        embeddings: "configured",
        probeTimeoutMs: 1500
      }),
      true,
      `${state} is a state the contract defines`
    );
  }
  assert.equal(
    await read({
      state: "degraded",
      backend: "postgresql",
      embeddings: "configured",
      probeTimeoutMs: 1500
    }),
    false,
    "an unrecognised state is refused rather than rendered"
  );
  assert.equal(
    await read({
      state: "reachable",
      backend: "mysql",
      embeddings: "configured",
      probeTimeoutMs: 1500
    }),
    false,
    "the backend is part of the contract, not decoration"
  );
});

test("the Memory page names why storage failed, from the status read rather than the error", async () => {
  // The records read answers the same 503 whether memory was never configured or
  // is configured and not answering, and the two send the operator to different
  // places. The page used to infer "not configured" from the failure code, which
  // is right most of the time and wrong exactly when it costs most.
  const renderWith = async (
    status: Record<string, unknown>
  ): Promise<string> => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-memory-status-"));
    const previousFetch = globalThis.fetch;
    const previousEnv = saveConsolePageEnvironment();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/control/workspaces")) {
        return Response.json({
          schema: "autodev-control-workspaces-v1",
          source: "config/workspaces.json",
          readOnly: true,
          catalogStatus: "valid",
          totalWorkspaces: 1,
          workspaces: [
            {
              id: "SimulatorLife/AutoDev",
              baseBranch: "main",
              enabled: true,
              agentRoles: null
            }
          ]
        });
      }
      if (url.includes("/control/memory/status")) {
        return Response.json({
          schema: "autodev-memory-status-v1",
          storage: status
        });
      }
      if (url.includes("/control/memory/records")) {
        return Response.json(
          {
            error: {
              message: "Memory operation could not be completed.",
              type: "autodev_memory_control_error",
              code: "autodev_memory_operation_failed"
            }
          },
          { status: 503 }
        );
      }
      throw new Error(`Unexpected Memory page request: ${url}`);
    }) as typeof fetch;
    try {
      process.env.HOME = isolatedHome;
      process.env.CODEX_HOME = isolatedHome;
      process.env.AUTODEV_OPENLIT_SECRET_FILE = join(
        isolatedHome,
        "missing.env"
      );
      process.env.AUTODEV_CONTROL_API_TOKEN = "status-page-test-token";
      process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
      return renderToStaticMarkup(
        await MemoryPage({ searchParams: Promise.resolve({}) })
      );
    } finally {
      globalThis.fetch = previousFetch;
      restoreConsolePageEnvironment(previousEnv);
    }
  };

  const storage = (state: string): Record<string, unknown> => ({
    state,
    backend: "postgresql",
    embeddings: "configured",
    probeTimeoutMs: 1500
  });

  assert.match(
    await renderWith(storage("unreachable")),
    /Memory storage is unreachable/,
    "a down store is named as down, not as an unconfigured one"
  );
  assert.match(
    await renderWith(storage("unreachable")),
    /1500ms/,
    "the probe's deadline is shown, so 'we did not reach it' is not read as 'it is down'"
  );
  assert.match(
    await renderWith(storage("not_configured")),
    /Memory storage is not configured/
  );
  // A store that answers is worth saying out loud on a failure page: it tells the
  // reader this read failed on its own terms rather than because memory is down.
  assert.match(
    await renderWith(storage("reachable")),
    /Durable memory storage answered/
  );
});

test("Memory purge requires an experience id rather than a record id", async () => {
  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "purge",
        workspaceId: "SimulatorLife/AutoDev",
        reason: "privacy_request",
        confirm: "purge"
      })
    );

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "/memory?tab=experiences&workspaceId=SimulatorLife%2FAutoDev&control=failed"
    );
    assert.equal(requests.length, 0);
  });
});

test("a record's governed actions submit the revision the route requires", () => {
  // `revise` existed in the route and nowhere else: it returns null without a
  // `claim`, and no form sent one, so the action the migration tracker listed as
  // shipped could never be performed from the Console.
  const record: MemoryRecord = {
    id: "mem-governed",
    kind: "semantic",
    status: "active",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "The claim as it stands.",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [record],
      total: 1,
      selectedRecord: record,
      listScope: memoryListScope()
    })
  );

  const form = (testId: string): string => {
    const start = markup.indexOf(`data-button="${testId}"`);
    assert.notEqual(start, -1, `${testId} must render`);
    const open = markup.lastIndexOf("<form", start);
    const close = markup.indexOf("</form>", start);
    assert.ok(open !== -1 && close > open, `${testId} must sit in a form`);
    return markup.slice(open, close);
  };

  const revise = form("memory-revise");
  assert.match(revise, /name="action" value="revise"/);
  assert.match(revise, /name="recordId" value="mem-governed"/);
  // The replacement claim, pre-filled from the record so the operator edits the
  // text rather than retyping it.
  assert.match(revise, /data-text-field="memory-revise-claim"/);
  assert.match(revise, /The claim as it stands\./);

  // An append-only lifecycle reason is recorded for every transition, so the
  // forms that make one carry a box for it. Blank still falls back to the
  // route's sentence; it just stops being the only option.
  for (const testId of ["memory-invalidate", "memory-revise"]) {
    assert.match(
      form(testId),
      /data-text-field="memory-[a-z-]+-reason"/,
      `${testId} must offer an audit reason`
    );
  }

  // Labels must be real: a placeholder disappears once the field has a value,
  // leaving the control with no accessible name at all.
  assert.match(revise, /<label for="memory-revise-claim-mem-governed"/);
  assert.match(revise, /<label for="memory-revise-reason-mem-governed"/);

  // Verify applies to a claim awaiting review, and carries the same reason box.
  const proposed = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [{ ...record, status: "proposed" }],
      total: 1,
      selectedRecord: { ...record, status: "proposed" },
      listScope: memoryListScope()
    })
  );
  assert.match(proposed, /data-button="memory-verify"/);
  assert.match(proposed, /data-text-field="memory-verify-reason"/);

  // A superseded or invalidated claim is not editable, so no revision form.
  const closed = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [{ ...record, status: "superseded" }],
      total: 1,
      selectedRecord: { ...record, status: "superseded" },
      listScope: memoryListScope()
    })
  );
  assert.equal(closed.includes('data-button="memory-revise"'), false);
});

test("Memory revise reaches the Runtime only with a replacement claim", async () => {
  await withMemoryRoute(async (requests) => {
    const refused = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "revise",
        recordId: "mem-1",
        workspaceId: "SimulatorLife/AutoDev",
        reason: "Outgrew its wording."
      })
    );
    assert.equal(refused.status, 303);
    assert.equal(
      refused.headers.get("location"),
      "/memory?tab=records&recordId=mem-1&workspaceId=SimulatorLife%2FAutoDev&control=failed&refusal=claim_required"
    );
    assert.equal(
      requests.length,
      0,
      "a revision with no claim is not a request"
    );
  });

  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "revise",
        recordId: "mem-1",
        workspaceId: "SimulatorLife/AutoDev",
        claim: "The revised claim.",
        reason: "Outgrew its wording."
      })
    );
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "/memory?tab=records&recordId=mem-1&workspaceId=SimulatorLife%2FAutoDev"
    );
    assert.equal(requests.length, 1);
    // The form fields become the control-API body, so the revision's claim is
    // asserted there rather than on the submitted form.
    const sent = JSON.parse(requests[0]?.body ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(sent.claim, "The revised claim.");
    assert.equal(sent.reason, "Outgrew its wording.");
  });
});

test("a Memory mutation returns to the list it was made on, and only to it", async () => {
  await withMemoryRoute(async (_requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "verify",
        recordId: "mem-1",
        workspaceId: "SimulatorLife/AutoDev",
        reason: "Checked against the suite.",
        // What the record form submits: the list the operator was working in.
        returned:
          "tab=records&workspaceId=SimulatorLife%2FAutoDev&kind=procedural" +
          "&status=proposed&from=2026-09-01T00%3A00%3A00Z&until=2026-10-01T00%3A00%3A00Z&limit=25&offset=50"
      })
    );
    assert.equal(response.status, 303);
    const back = new URL(
      response.headers.get("location") ?? "",
      "http://console.test"
    );
    // Still the same list: a verify made inside a 25-row page 3 of a
    // 90-day window must not return the operator to an unfiltered 30-day list.
    assert.equal(back.pathname, "/memory");
    assert.equal(back.searchParams.get("kind"), "procedural");
    assert.equal(back.searchParams.get("status"), "proposed");
    assert.equal(back.searchParams.get("from"), "2026-09-01T00:00:00Z");
    assert.equal(back.searchParams.get("until"), "2026-10-01T00:00:00Z");
    assert.equal(back.searchParams.get("limit"), "25");
    assert.equal(back.searchParams.get("offset"), "50");
    // And the acted-on item is re-selected, which is what the route already did.
    assert.equal(back.searchParams.get("recordId"), "mem-1");
    assert.equal(back.searchParams.get("tab"), "records");
  });

  // The carried value is a set of filter facts, not a redirect target: the
  // route re-parses named keys and rebuilds `/memory?…`, so a crafted value
  // cannot send the browser anywhere else, and cannot smuggle a selection in
  // either -- the action decides what is selected.
  await withMemoryRoute(async (_requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "verify",
        recordId: "mem-1",
        workspaceId: "SimulatorLife/AutoDev",
        returned:
          "https://evil.test/steal&tab=cohorts&recordId=mem-other" +
          "&experienceId=exp-other&workspaceId=Somewhere%2FElse"
      })
    );
    const location = response.headers.get("location") ?? "";
    assert.match(location, /^\/memory\?/, "must never redirect off-site");
    assert.equal(location.includes("evil.test"), false);
    assert.equal(location.includes("Somewhere"), false);
    const back = new URL(location, "http://console.test");
    assert.equal(back.searchParams.get("tab"), "records");
    assert.equal(back.searchParams.get("recordId"), "mem-1");
    assert.equal(back.searchParams.get("experienceId"), null);
    // `workspaceId` comes from the request the route already trusted, not from
    // the carried list.
    assert.equal(back.searchParams.get("workspaceId"), "SimulatorLife/AutoDev");
  });
});

test("an experience shows observed packets and reported outcomes as separate claims", () => {
  // The Runtime has stored and read back injections, reporter outcomes, and
  // curator use assessments the whole time, and the Console could show none of
  // them. The point of the panel is that it does not merge what it shows: the
  // risk is not "no evidence view" but "one verdict standing in for three
  // different claims".
  const experience: ExperienceEnvelope = {
    id: "exp-evidence",
    workspaceId: "SimulatorLife/AutoDev",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-orch",
    agentRole: "orchestrator",
    startedAt: "2026-10-01T00:00:00Z",
    outcome: "success",
    memoryMode: "jit",
    trajectory: {
      format: "codex-v1",
      uri: "file:///tmp/transcripts/run-1.jsonl",
      sourceAdapter: "codex"
    },
    evidence: []
  };

  const renderPanel = (
    overrides: Partial<MemoryExperiencesViewProps>
  ): string =>
    renderToStaticMarkup(
      React.createElement(MemoryExperiencesView, {
        experiences: [experience],
        total: 1,
        selectedExperience: experience,
        listScope: memoryListScope({ tab: "experiences" }),
        ...overrides
      })
    );

  // One observed injection, one reported outcome, one assessed use.
  const reported = renderPanel({
    outcomes: [
      {
        injection: {
          id: "inj-1",
          correlationToken: "corr-1",
          memoryMode: "jit",
          injectionResult: "injected",
          packetCharacterCount: 900,
          memoryIds: ["mem-1", "mem-2"],
          occurredAt: "2026-10-01T00:00:00Z"
        },
        outcome: {
          outcomeKind: "success",
          reportKind: "task",
          reportedAt: "2026-10-01T01:00:00Z",
          reporterId: "operator-1",
          reporterAuthority: "root",
          reasonCode: "reporter_supplied"
        },
        sessionInjectionCount: 1
      }
    ],
    outcomeTotal: 1,
    useAssessments: [
      {
        // The Runtime's own projection: no correlation token, and the evidence
        // a curator assessed against. The fixture used to carry the token the
        // route withholds and omit the evidence it always sends, so it agreed
        // with neither the contract nor the producer.
        injection: {
          id: "inj-1",
          memoryMode: "jit",
          injectionResult: "injected",
          packetCharacterCount: 900,
          memoryIds: ["mem-1", "mem-2"],
          occurredAt: "2026-10-01T00:00:00Z"
        },
        use: {
          useKind: "partially_used",
          usedMemoryIds: ["mem-1"],
          reportedAt: "2026-10-01T02:00:00Z",
          evidence: [
            { kind: "trajectory", uri: "codex://captured/exp-1", revision: "1" }
          ]
        },
        sessionInjectionCount: 1
      }
    ],
    useAssessmentTotal: 1
  });

  assert.match(reported, /data-experience-evidence="true"/);
  assert.match(reported, /Observed by the runtime/);
  assert.match(reported, /Reported outcome: success/);
  assert.match(reported, /partially_used \(1\/2 memories cited\)/);
  // The session count is labelled as the session's, not this row's.
  assert.match(reported, /1 injection in this session/);

  // An injection nobody reported on says so, and says it is not a failure.
  const unreported = renderPanel({
    outcomes: [
      {
        injection: {
          id: "inj-2",
          correlationToken: "corr-2",
          memoryMode: "retrieval-only",
          injectionResult: "injected",
          packetCharacterCount: 400,
          memoryIds: ["mem-3"],
          occurredAt: "2026-10-01T00:00:00Z"
        },
        outcome: null,
        sessionInjectionCount: 3
      }
    ],
    outcomeTotal: 1,
    useAssessments: [],
    useAssessmentTotal: 0
  });
  assert.match(unreported, /data-evidence-report="unreported"/);
  assert.match(unreported, /This is not a failed outcome\./);
  // A session that injected three times must not read as this row injecting
  // three times.
  assert.match(unreported, /3 injections in this session/);
  assert.doesNotMatch(unreported, /Reported outcome:/);

  // `unobservable` is a distinct verdict and is not folded into "not used".
  const unobservable = renderPanel({
    outcomes: [],
    outcomeTotal: 0,
    useAssessments: [
      {
        injection: {
          id: "inj-3",
          memoryMode: "jit",
          injectionResult: "injected",
          packetCharacterCount: 10,
          memoryIds: [],
          occurredAt: "2026-10-01T00:00:00Z"
        },
        use: {
          useKind: "unobservable",
          usedMemoryIds: [],
          reportedAt: "x",
          evidence: []
        },
        sessionInjectionCount: 1
      }
    ],
    useAssessmentTotal: 1
  });
  assert.match(unobservable, /unobservable/);
  assert.doesNotMatch(unobservable, /not_used/);

  // A read that did not succeed is reported as unavailable. It must never
  // render as an empty list, because "we could not look" and "there is nothing
  // there" are the two answers an operator must not confuse.
  const unavailable = renderPanel({ outcomes: null, useAssessments: null });
  assert.match(unavailable, /data-status="unavailable"/);
  assert.match(unavailable, /nothing is inferred about them/);
  assert.doesNotMatch(unavailable, /No packet was attached/);
  assert.doesNotMatch(unavailable, /No curator has assessed/);
});

test("the experience evidence validators refuse a response that would read as 'unreported'", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const injection = {
    id: "inj-1",
    correlationToken: "corr-1",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 10,
    memoryIds: ["mem-1"],
    occurredAt: "2026-10-01T00:00:00Z"
  };
  const read = async (body: unknown): Promise<boolean> => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
    try {
      const result = await fetchMemoryExperienceOutcomes(
        "exp-1",
        "SimulatorLife/AutoDev",
        config
      );
      return result.kind === "ok";
    } finally {
      globalThis.fetch = previousFetch;
    }
  };

  const page = {
    schema: "autodev-memory-injection-outcomes-v1",
    experienceId: "exp-1",
    items: [{ injection, outcome: null, sessionInjectionCount: 1 }],
    total: 1,
    limit: 50,
    offset: 0
  };
  // A genuine unreported outcome is a legitimate, accepted response.
  assert.equal(await read(page), true);

  // A row that simply omits `outcome` is not "unreported" -- it is unreadable,
  // and accepting it would render a dropped field as a negative finding.
  assert.equal(
    await read({
      ...page,
      items: [{ injection, sessionInjectionCount: 1 }]
    }),
    false
  );
  // A page naming a different experience is the wrong answer, not an empty one.
  assert.equal(await read({ ...page, experienceId: "exp-other" }), false);
  // And a half-formed report is refused rather than partially believed.
  assert.equal(
    await read({
      ...page,
      items: [
        {
          injection,
          outcome: { outcomeKind: "success", reportKind: "task" },
          sessionInjectionCount: 1
        }
      ]
    }),
    false
  );
  assert.equal(
    await read({
      ...page,
      items: [
        {
          injection: { ...injection, memoryIds: [null] },
          outcome: null,
          sessionInjectionCount: 1
        }
      ]
    }),
    false
  );
  assert.equal(await read({ ...page, schema: "something-else" }), false);
});

test("cohort filters reach the Runtime and stay on the cohorts tab", async () => {
  // The Runtime has accepted memoryMode, injectionResult, reportKind,
  // outcomeKind, and useKind on these reads since they were written, and the
  // tab rendered none of them. Every cohort view reachable from the Console was
  // therefore the unfiltered one.
  const previousFetch = globalThis.fetch;
  const previousEnv = saveConsolePageEnvironment();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-memory-cohorts-"));
  const requested: string[] = [];
  const renderPage = async (
    searchParams: Record<string, string>
  ): Promise<string> => {
    requested.length = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/control/workspaces")) {
        return Response.json({
          schema: "autodev-control-workspaces-v1",
          source: "config/workspaces.json",
          readOnly: true,
          catalogStatus: "valid",
          totalWorkspaces: 1,
          workspaces: [
            {
              id: "SimulatorLife/AutoDev",
              baseBranch: "main",
              enabled: true,
              agentRoles: null
            }
          ]
        });
      }
      if (url.includes("/control/memory/records")) {
        return Response.json({
          schema: "autodev-memory-records-v1",
          items: [],
          total: 0,
          limit: 50,
          offset: 0,
          statusCounts: {
            proposed: 0,
            active: 0,
            superseded: 0,
            invalidated: 0,
            uncertain: 0
          }
        });
      }
      if (url.includes("/control/memory/experiences")) {
        return Response.json({
          schema: "autodev-memory-experiences-v1",
          items: [],
          total: 0,
          limit: 50,
          offset: 0
        });
      }
      if (url.includes("/control/memory/use-cohorts")) {
        return Response.json({
          schema: "autodev-memory-use-cohorts-v1",
          cells: [],
          sessionCount: 0
        });
      }
      if (url.includes("/control/memory/session-cohorts")) {
        return Response.json({
          schema: "autodev-memory-session-cohorts-v1",
          cells: [],
          sessionCount: 0
        });
      }
      throw new Error(`Unexpected Memory page request: ${url}`);
    };
    return renderToStaticMarkup(
      await MemoryPage({ searchParams: Promise.resolve(searchParams) })
    );
  };

  try {
    process.env.HOME = isolatedHome;
    process.env.CODEX_HOME = isolatedHome;
    process.env.AUTODEV_OPENLIT_SECRET_FILE = join(isolatedHome, "missing.env");
    process.env.AUTODEV_CONTROL_API_TOKEN = "memory-cohort-test-token";
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";

    const markup = await renderPage({
      tab: "cohorts",
      memoryMode: "jit",
      injectionResult: "injected",
      reportKind: "task",
      outcomeKind: "success",
      useKind: "partially_used"
    });

    const cohorts = requested.find((url) =>
      url.includes("/control/memory/session-cohorts")
    );
    assert.ok(
      cohorts,
      `the outcome cohorts must be read; requested: ${requested.join(" ")}`
    );
    const cohortUrl = new URL(cohorts);
    assert.equal(cohortUrl.searchParams.get("memoryMode"), "jit");
    assert.equal(cohortUrl.searchParams.get("injectionResult"), "injected");
    assert.equal(cohortUrl.searchParams.get("reportKind"), "task");
    assert.equal(cohortUrl.searchParams.get("outcomeKind"), "success");

    const useCohorts = requested.find((url) =>
      url.includes("/control/memory/use-cohorts")
    );
    assert.ok(useCohorts, "the use cohorts must be read");
    const useUrl = new URL(useCohorts);
    assert.equal(useUrl.searchParams.get("memoryMode"), "jit");
    assert.equal(useUrl.searchParams.get("useKind"), "partially_used");

    // Each control renders, and the tab's own filter bar keeps the window.
    assert.match(markup, /data-feature-filter="cohorts"/);
    for (const testId of [
      "memory-cohort-memory-mode",
      "memory-cohort-injection-result",
      "memory-cohort-report-kind",
      "memory-cohort-outcome-kind",
      "memory-cohort-use-kind"
    ]) {
      assert.match(markup, new RegExp(`data-select="${testId}"`, "u"));
    }

    // An unfiltered cohort read forwards nothing, rather than an empty array
    // the Runtime would have to interpret.
    await renderPage({ tab: "cohorts" });
    const plain = requested.find((url) =>
      url.includes("/control/memory/session-cohorts")
    );
    assert.ok(plain);
    const plainUrl = new URL(plain);
    for (const key of [
      "memoryMode",
      "injectionResult",
      "reportKind",
      "outcomeKind",
      "useKind"
    ]) {
      assert.equal(
        plainUrl.searchParams.has(key),
        false,
        `${key} must be absent`
      );
    }

    // A mode the Runtime would refuse is named, not forwarded.
    const refused = await renderPage({ tab: "cohorts", memoryMode: "bogus" });
    assert.match(refused, /1 filter in this URL was not applied\./);
    assert.match(refused, /memoryMode=&quot;bogus&quot;/);
    const afterRefusal = requested.find((url) =>
      url.includes("/control/memory/session-cohorts")
    );
    assert.ok(afterRefusal);
    assert.equal(new URL(afterRefusal).searchParams.has("memoryMode"), false);

    // Cohort filters do not follow the operator to another tab. Records has no
    // memoryMode axis, so carrying it there would name a filter nothing applies.
    await renderPage({
      tab: "records",
      memoryMode: "jit",
      outcomeKind: "success"
    });
    const records = requested.find((url) =>
      url.includes("/control/memory/records")
    );
    assert.ok(records);
    const recordsUrl = new URL(records);
    assert.equal(recordsUrl.searchParams.has("memoryMode"), false);
    assert.equal(recordsUrl.searchParams.has("outcomeKind"), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreConsolePageEnvironment(previousEnv);
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("a record's source experiences are reachable, not just counted", () => {
  // "Provenance & Citations" used to report "Sources: 2 experiences" and offer
  // no way to reach either. An operator checking whether a claim still holds has
  // to read the claim's sources, so a count is the one thing that block could
  // not give them.
  const record: MemoryRecord = {
    id: "mem-sourced",
    kind: "semantic",
    status: "active",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "A claim with sources.",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: ["exp-a", "exp-b"],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [record],
      total: 1,
      selectedRecord: record,
      listScope: memoryListScope({
        query: "guard",
        from: "2026-09-01T00:00:00Z",
        until: "2026-10-01T00:00:00Z"
      })
    })
  );

  assert.match(markup, /data-provenance-sources="linked"/);
  for (const id of ["exp-a", "exp-b"]) {
    const anchor = markup
      .split("<a")
      .find((a) => a.includes(`data-provenance-experience="${id}"`));
    assert.ok(anchor, `${id} must be a link`);
    const href = anchor.match(/href="([^"]+)"/u)?.[1];
    assert.ok(href);
    const url = new URL(href.replaceAll("&amp;", "&"), "http://console.test");
    // The experience is only addressable on its own tab, so the link crosses.
    assert.equal(url.pathname, "/memory");
    assert.equal(url.searchParams.get("tab"), "experiences");
    assert.equal(url.searchParams.get("experienceId"), id);
    assert.equal(url.searchParams.get("workspaceId"), "SimulatorLife/AutoDev");
    // And it comes back to the list the operator was working in.
    assert.equal(url.searchParams.get("from"), "2026-09-01T00:00:00Z");
    assert.equal(url.searchParams.get("until"), "2026-10-01T00:00:00Z");
  }

  // A claim with no cited source says so, rather than showing an empty list
  // under a heading that promises citations.
  const uncited = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [
        { ...record, provenance: { ...record.provenance, experienceIds: [] } }
      ],
      total: 1,
      selectedRecord: {
        ...record,
        provenance: { ...record.provenance, experienceIds: [] }
      },
      listScope: memoryListScope()
    })
  );
  assert.match(uncited, /data-provenance-sources="none"/);
  assert.match(uncited, /No source experiences are cited\./);
  assert.doesNotMatch(uncited, /data-provenance-experience=/);
});

/** The why panel reads only the id, but the response type is the whole envelope. */
function minimalExperience(id: string): ExperienceEnvelope {
  return {
    id,
    workspaceId: "SimulatorLife/AutoDev",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    startedAt: "2026-10-01T00:00:00Z",
    outcome: "success",
    memoryMode: "jit",
    trajectory: {
      format: "codex-v1",
      uri: "file:///t.jsonl",
      sourceAdapter: "codex"
    },
    evidence: []
  };
}

test("a record says how much of its provenance this reader can resolve", () => {
  // `why` is the Runtime's eligibility-bounded explanation: it reports the
  // cited experiences this caller can still resolve, which may be fewer than the
  // record cites. That difference is the whole reason the route exists, and
  // presenting the shorter list as the whole truth would be the opposite of it.
  const record: MemoryRecord = {
    id: "mem-partial",
    kind: "semantic",
    status: "active",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "A claim citing three sources.",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: ["exp-a", "exp-b", "exp-c"],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  };

  const render = (
    why: ControlApiMemoryWhyResponse | null | undefined
  ): string =>
    renderToStaticMarkup(
      React.createElement(MemoryRecordsView, {
        records: [record],
        total: 1,
        selectedRecord: record,
        listScope: memoryListScope(),
        why
      })
    );

  const partial = render({
    schema: "autodev-memory-why-v1",
    memory: record,
    relatedMemories: [],
    sourceExperiences: [minimalExperience("exp-a")]
  });
  assert.match(partial, /data-provenance-unresolved="true"/);
  assert.match(partial, /1 of 3 resolvable to this reader/);
  // All three ids stay listed and linked; the gap narrows what can be opened,
  // it does not delete what was cited.
  for (const id of ["exp-a", "exp-b", "exp-c"]) {
    assert.match(
      partial,
      new RegExp(`data-provenance-experience="${id}"`, "u")
    );
  }
  assert.match(partial, /Sources: 3 experiences/);

  const complete = render({
    schema: "autodev-memory-why-v1",
    memory: record,
    relatedMemories: [],
    sourceExperiences: [
      minimalExperience("exp-a"),
      minimalExperience("exp-b"),
      minimalExperience("exp-c")
    ]
  });
  assert.match(complete, /data-provenance-unresolved="false"/);
  assert.match(complete, /All cited sources are resolvable to this reader\./);

  // Not read is not "all resolvable". Saying so would let a failed read look
  // like a clean provenance check.
  const unread = render(null);
  assert.doesNotMatch(unread, /data-provenance-unresolved/);
  assert.doesNotMatch(unread, /resolvable to this reader/);
});

test("an observed injection offers both reports, on the injection they describe", () => {
  // Both claims are per-injection: the Runtime binds an outcome to the
  // correlation token minted for one injection and a use assessment to an
  // injection event id. A form on the experience header would have to pick one,
  // and picking silently is how a report ends up bound to the wrong evidence.
  const experience: ExperienceEnvelope = {
    id: "exp-report",
    workspaceId: "SimulatorLife/AutoDev",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    agentRole: "orchestrator",
    startedAt: "2026-10-01T00:00:00Z",
    outcome: "success",
    memoryMode: "jit",
    trajectory: {
      format: "codex-v1",
      uri: "file:///t.jsonl",
      sourceAdapter: "codex"
    },
    evidence: []
  };
  const injection = {
    id: "inj-r",
    correlationToken: "corr-r",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 900,
    memoryIds: ["mem-1", "mem-2"],
    occurredAt: "2026-10-01T00:00:00Z"
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryExperiencesView, {
      experiences: [experience],
      total: 1,
      selectedExperience: experience,
      listScope: memoryListScope({ tab: "experiences", query: "guard" }),
      outcomes: [{ injection, outcome: null, sessionInjectionCount: 1 }],
      useAssessments: [{ injection, use: null, sessionInjectionCount: 1 }]
    })
  );

  assert.match(markup, /data-injection-reports="inj-r"/);
  // Two separate forms: an outcome is a reporter's claim about the task, a use
  // assessment a curator's judgement about the packet.
  assert.match(markup, /name="action" value="report-outcome"/);
  assert.match(markup, /name="action" value="report-use"/);
  // The correlation token rides along so the Runtime can re-resolve the binding.
  assert.match(markup, /name="correlationToken" value="corr-r"/);
  assert.match(markup, /name="injectionEventId" value="inj-r"/);
  // The evidence a report must carry is part of the form, not a nicety.
  assert.match(markup, /name="evidenceKind"/);
  assert.match(markup, /name="evidenceUri"/);
  // The injected set bounds a use verdict, so it is shown as the answer's range.
  assert.match(markup, /placeholder="mem-1, mem-2"/);

  // Once a report exists the form is gone: the Runtime binds one per injection,
  // so offering a second would be offering a submission it will refuse.
  const reported = renderToStaticMarkup(
    React.createElement(MemoryExperiencesView, {
      experiences: [experience],
      total: 1,
      selectedExperience: experience,
      listScope: memoryListScope({ tab: "experiences" }),
      outcomes: [
        {
          injection,
          outcome: {
            outcomeKind: "success",
            reportKind: "task",
            reportedAt: "2026-10-01T01:00:00Z",
            reporterId: "op",
            reporterAuthority: "root",
            reasonCode: "reporter_supplied"
          },
          sessionInjectionCount: 1
        }
      ],
      useAssessments: [
        {
          injection,
          use: {
            useKind: "used",
            usedMemoryIds: ["mem-1", "mem-2"],
            reportedAt: "2026-10-01T02:00:00Z"
          },
          sessionInjectionCount: 1
        }
      ]
    })
  );
  assert.doesNotMatch(reported, /value="report-outcome"/);
  assert.doesNotMatch(reported, /value="report-use"/);
  assert.match(reported, /already reported for this injection/);
  assert.match(reported, /already assessed this injection as used/);
});

test("Memory reports reach the Runtime bound to one injection, or not at all", async () => {
  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "report-outcome",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        correlationToken: "corr-1",
        outcomeKind: "success",
        reportKind: "task",
        evidenceKind: "trajectory",
        evidenceUri: "traj://run-1"
      })
    );
    assert.equal(response.status, 303);
    assert.equal(requests.length, 1);
    assert.match(
      requests[0]?.url ?? "",
      /\/control\/memory\/experiences\/exp-1\/outcomes\?/
    );
    const sent = JSON.parse(requests[0]?.body ?? "{}") as Record<
      string,
      unknown
    >;
    // Exactly the Runtime's `exactKeys` body: no author, no timestamp, no
    // verdict of the Console's own. `reporterId` and `reporterAuthority` come
    // from the session, because a report that names its own author is not
    // evidence of anything.
    assert.deepEqual(Object.keys(sent).sort(), [
      "correlationToken",
      "evidence",
      "outcomeKind",
      "reportKind"
    ]);
    assert.equal(sent.correlationToken, "corr-1");
    assert.deepEqual(sent.evidence, [
      { kind: "trajectory", uri: "traj://run-1" }
    ]);
  });

  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "report-use",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        injectionEventId: "inj-1",
        useKind: "partially_used",
        usedMemoryIds: "mem-1, mem-2",
        evidenceKind: "trace",
        evidenceUri: "trace://run-1"
      })
    );
    assert.equal(response.status, 303);
    const sent = JSON.parse(requests[0]?.body ?? "{}") as Record<
      string,
      unknown
    >;
    assert.deepEqual(sent.usedMemoryIds, ["mem-1", "mem-2"]);
    assert.equal(sent.useKind, "partially_used");
  });

  // An outcome with no evidence is refused here rather than forwarded. The
  // Runtime refuses it too, but its message would name a Runtime decision on a
  // request it never saw. The code says what is actually true of this refusal:
  // the Runtime was never asked, so no outcome was recorded.
  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "report-outcome",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        correlationToken: "corr-1",
        outcomeKind: "success",
        reportKind: "task"
      })
    );
    assert.equal(response.status, 303);
    assert.match(
      response.headers.get("location") ?? "",
      /refusal=evidence_required/
    );
    assert.equal(requests.length, 0, "an unevidenced claim is not a request");
  });

  // `unknown` is the honest answer when there is no evidence, so it is the one
  // outcome kind that may be recorded without one. Refusing it would make the
  // route refuse the only report it should accept unevidenced.
  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "report-outcome",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        correlationToken: "corr-1",
        outcomeKind: "unknown",
        reportKind: "task"
      })
    );
    assert.equal(response.status, 303);
    assert.doesNotMatch(
      response.headers.get("location") ?? "",
      /control=failed/
    );
    assert.equal(requests.length, 1);
  });

  // And a report with no injection to bind to is refused as incomplete.
  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "report-outcome",
        workspaceId: "SimulatorLife/AutoDev",
        correlationToken: "corr-1",
        outcomeKind: "success",
        reportKind: "task",
        evidenceKind: "trace",
        evidenceUri: "trace://1"
      })
    );
    assert.equal(response.status, 303);
    // A request naming no identifier at all is malformed, not a refused claim,
    // so it carries the generic could-not-confirm notice and no refusal code.
    assert.match(response.headers.get("location") ?? "", /control=failed/);
    assert.doesNotMatch(response.headers.get("location") ?? "", /refusal=/);
    assert.equal(requests.length, 0);
  });

  // A report that names the experience but not the injection it annotates has no
  // subject to bind to. It is malformed rather than refused for a reason an
  // operator can act on, and `claim_required` -- "a revision needs the
  // replacement claim text" -- was the code it used to carry, which named a field
  // this form has no control for.
  await withMemoryRoute(async (requests) => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "report-outcome",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        outcomeKind: "success",
        reportKind: "task",
        evidenceKind: "trace",
        evidenceUri: "trace://1"
      })
    );
    assert.equal(response.status, 303);
    assert.match(
      response.headers.get("location") ?? "",
      /[?&]tab=experiences&experienceId=exp-1/
    );
    assert.doesNotMatch(response.headers.get("location") ?? "", /refusal=/);
    assert.equal(requests.length, 0);
  });

  // An action this route does not implement has no subject, no tab, and no cause
  // to report, so there is nothing a redirect could name. It answers the caller
  // instead of redirecting to a list the operator never asked about.
  await withMemoryRoute(async () => {
    const response = await memoryRoute.POST(
      memoryPurgeRequest({
        action: "supersede",
        recordId: "rec-1",
        workspaceId: "SimulatorLife/AutoDev"
      })
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
  });
});

test("ClosePanelLink renders the shared close mark and keeps its accessible name", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ClosePanelLink, { href: "/memory?tab=records" })
  );

  // A real link: the panel must be dismissible without client JavaScript.
  assert.match(markup, /^<a href="\/memory\?tab=records"/);
  // The mark comes from the shared icon set, not a raw glyph typed into the
  // view, so it shares the product's grid, stroke, and currentColor behaviour.
  assert.match(markup, /<svg[^>]*viewBox="0 0 24 24"/);
  assert.match(markup, /<svg[^>]*stroke="currentColor"/);
  assert.equal(markup.includes("✕"), false, "must not re-type the close glyph");
  // Decorative icon beside a real word: the word is the accessible name.
  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, />Close<\/a>$/);
});

test("DataTable caps its scroll floor so a table never scrolls at desktop width", () => {
  interface TestRow {
    readonly id: string;
  }
  // Weights authored at their measured pixel widths: this set sums to 1300,
  // wider than the ~1060px content column at 1440. The floor must not become
  // that natural width, or the table region scrolls 240px on a desktop window
  // for no small-screen reason.
  const wide = renderToStaticMarkup(
    DataTable<TestRow>({
      data: [{ id: "1" }],
      columns: [
        { id: "a", header: "A", cell: (r: TestRow) => r.id, weight: 500 },
        { id: "b", header: "B", cell: (r: TestRow) => r.id, weight: 500 },
        { id: "c", header: "C", cell: (r: TestRow) => r.id, weight: 300 }
      ],
      keyExtractor: (r: TestRow) => r.id,
      emptyMessage: "No rows."
    })
  );
  const wideFloor = Number(
    wide.match(/style="min-width:([0-9]+)px"/)?.[1] ?? 0
  );
  assert.ok(wideFloor > 0, "a table must still declare a floor");
  assert.equal(
    wideFloor,
    54 * 16,
    "the floor must be capped, not the natural sum"
  );

  // A narrow table still gets its own smaller floor, so it is never handed a
  // scrollbar it does not need.
  const narrow = renderToStaticMarkup(
    DataTable<TestRow>({
      data: [{ id: "1" }],
      columns: [
        { id: "a", header: "A", cell: (r: TestRow) => r.id, weight: 120 },
        { id: "b", header: "B", cell: (r: TestRow) => r.id, weight: 120 }
      ],
      keyExtractor: (r: TestRow) => r.id,
      emptyMessage: "No rows."
    })
  );
  const narrowFloor = Number(
    narrow.match(/style="min-width:([0-9]+)px"/)?.[1] ?? 0
  );
  assert.equal(
    narrowFloor,
    240,
    "a narrow table keeps the floor its columns need"
  );
  assert.ok(narrowFloor < wideFloor, "narrow tables must floor below the cap");
});

test("the resource failure shell breaks an error code only at its own separators", () => {
  // The failure shell is what every route renders when a resource cannot be
  // loaded, so it is the one place a page must never look healthy by accident.
  //
  // Three failure modes are guarded here, all invisible to the type checker.
  // Composing `${DETAIL_PANEL_CLASS} bg-error/10` silently keeps `bg-surface`,
  // because Tailwind resolves two utilities on the same property by stylesheet
  // order rather than by class-attribute order. A shape constant that set
  // `whitespace-nowrap` could not be relaxed to `normal` by appending another
  // utility, which left the long code unable to wrap at all.
  //
  // The third is the one that rendered a value the page does not hold. The code
  // was given `break-all`, so a 45-character snake_case code had no choice but
  // to be cut at an arbitrary character, and the shell showed
  // `autodev_control_api_invalid_perm` + `issions_response` — two strings that
  // are not the code and match no log line. `break-all` on a machine token
  // makes an arbitrary cut permanent rather than a last resort.
  const code = "autodev_control_api_invalid_permissions_response";
  const markup = renderToStaticMarkup(
    React.createElement(ResourceUnavailable, {
      title: "Permissions could not be loaded",
      code,
      message: "The Control API returned an incompatible response."
    })
  );

  assert.match(markup, new RegExp(`data-error-code="${code}"`));
  assert.match(markup, /bg-error\/10/);
  assert.doesNotMatch(
    markup,
    /bg-surface/,
    "the default panel surface must not win over the error tint"
  );
  assert.match(markup, /rounded-lg border shadow p-6/);
  assert.doesNotMatch(
    markup,
    /whitespace-nowrap/,
    "an error code must be able to wrap on a narrow card"
  );

  // The rendered code must still be the code. This is the assertion that would
  // have caught the defect: `break-all` left the text intact too, so asserting
  // on the string alone passes on both the broken and the fixed shell.
  const visible = /<span class="max-w-full[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(
    markup
  )?.[1];
  assert.ok(visible, "the failure shell renders the code in its own span");
  const text = visible.replaceAll(/<wbr\s*\/?>/g, "");
  assert.equal(
    text,
    code,
    "breaking the code must not add, drop or split any character of the value"
  );

  // Every separator is a break opportunity, so the browser's choice of where to
  // cut is constrained to positions between groups. `break-all`/`break-words`
  // remain only as the last resort for a single group too wide for the card.
  for (const group of code.split(/(?<=_)/u)) {
    assert.ok(
      visible.includes(`${group}<wbr`),
      `"${group}" must be followed by a break opportunity, not cut mid-segment`
    );
  }
  assert.doesNotMatch(
    markup,
    /break-all/,
    "break-all cuts a machine token at an arbitrary character on every render"
  );
});

test("a memory row missing a member its view dereferences fails closed instead of throwing", async () => {
  // The row guards checked identifiers and then stopped one level short: a
  // durable record's `provenance` and `validity` were checked with `isRecord`,
  // which passes for `{}`, while the view calls `.map` on
  // `provenance.evidence` and reads `validity.state` three times. An experience
  // envelope was never checked for `trajectory` at all, and the detail view
  // reads `experience.trajectory.format` unguarded -- Core declares the member
  // required, so that payload was well-formed except for one absent field and
  // produced a live `TypeError: Cannot read properties of undefined (reading
  // 'format')`: a 500 with no <h1>.
  //
  // Found by driving the memory detail route for the first time. No previous
  // sweep rendered /memory at all, because the live router has no Memory
  // backend, so every earlier "clean" result for that route was clean because
  // nothing was there. Each case below is a shape that produced the crash, or
  // would have.
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "server-only"
  };
  const serve = (payload: unknown) => ({
    fetchImpl: async () => Response.json(payload)
  });
  const scope = { workspaceId: "SimulatorLife/AutoDev" };

  const record = {
    id: "rec-1",
    kind: "semantic",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "A claim",
    status: "active",
    provenance: {
      experienceIds: ["exp-1"],
      evidence: [{ kind: "trace", uri: "trace://1" }],
      createdBy: "curator",
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    validity: {
      state: "verified",
      evidence: [{ kind: "trace", uri: "trace://1" }]
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z"
  };
  const experience = {
    id: "exp-1",
    workspaceId: "SimulatorLife/AutoDev",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "orchestrator",
    evidence: [{ kind: "trajectory", uri: "traj://1" }],
    trajectory: { format: "codex/jsonl", uri: "traj://1" }
  };
  const page = (items: readonly unknown[], schema: string) => ({
    schema,
    items,
    total: items.length,
    limit: 50,
    offset: 0,
    // The lifecycle rollup is part of the records contract, so a records page
    // without one is refused — which is why this fixture carries it for every
    // schema, including the experience ones that do not require it.
    statusCounts: {
      proposed: 0,
      active: 0,
      superseded: 0,
      invalidated: 0,
      uncertain: 0
    }
  });

  // The complete rows must still be accepted. A guard that is too strict is
  // indistinguishable in the UI from bad data, and this is the assertion that
  // keeps these guards from drifting toward rejecting real payloads.
  assert.equal(
    (
      await fetchMemoryRecords(
        scope,
        config,
        serve(page([record], "autodev-memory-records-v1"))
      )
    ).kind,
    "ok",
    "a complete durable record must be accepted"
  );
  assert.equal(
    (
      await fetchMemoryExperiences(
        scope,
        config,
        serve(page([experience], "autodev-memory-experiences-v1"))
      )
    ).kind,
    "ok",
    "a complete experience envelope must be accepted"
  );

  // Each dropped member is asserted individually, because a loop over one
  // fixture proves only the first case.
  const droppedRecords: readonly (readonly [
    string,
    Record<string, unknown>
  ])[] = [
    ["provenance emptied", { ...record, provenance: {} }],
    [
      "provenance without experienceIds",
      { ...record, provenance: { evidence: [] } }
    ],
    ["validity emptied", { ...record, validity: {} }]
  ];
  for (const [label, row] of droppedRecords) {
    const result = await fetchMemoryRecords(
      scope,
      config,
      serve(page([row], "autodev-memory-records-v1"))
    );
    assert.notEqual(
      result.kind,
      "ok",
      `a record with ${label} must fail closed`
    );
  }

  const noTrajectory: Record<string, unknown> = { ...experience };
  delete noTrajectory.trajectory;
  const droppedExperiences: readonly (readonly [
    string,
    Record<string, unknown>
  ])[] = [
    ["no trajectory", noTrajectory],
    [
      "trajectory without format",
      { ...experience, trajectory: { uri: "traj://1" } }
    ],
    [
      "trajectory without uri",
      { ...experience, trajectory: { format: "codex/jsonl" } }
    ]
  ];
  for (const [label, row] of droppedExperiences) {
    const result = await fetchMemoryExperiences(
      scope,
      config,
      serve(page([row], "autodev-memory-experiences-v1"))
    );
    assert.notEqual(
      result.kind,
      "ok",
      `an experience with ${label} must fail closed`
    );
  }

  // The cohort page validated its envelope and not one cell. The view calls
  // `.toLocaleString()` on every cell's counts, so a single malformed cell took
  // the whole tab down.
  const cohortScope = {
    workspaceId: "SimulatorLife/AutoDev",
    repositoryId: "autodev",
    occurredFrom: "2026-09-06T00:00:00.000Z",
    occurredUntil: "2026-10-06T00:00:00.000Z"
  };
  const sessionCohortPage = (cells: readonly unknown[]) => ({
    schema: "autodev-memory-session-outcome-cohorts-v1",
    workspaceId: "SimulatorLife/AutoDev",
    repositoryId: "autodev",
    occurredFrom: cohortScope.occurredFrom,
    occurredUntil: cohortScope.occurredUntil,
    cells,
    sessionCount: 64,
    reportedSessionCount: 60,
    unreportedSessionCount: 4,
    conflictingOutcomeSessionCount: 2,
    mixedModeSessionCount: 1
  });
  assert.equal(
    (
      await fetchMemoryCohorts(
        cohortScope,
        config,
        serve(
          sessionCohortPage([
            {
              memoryMode: "retrieval-only",
              outcomeKind: "success",
              sessionCount: 27
            },
            // A null outcomeKind means "no outcome report exists for this
            // cell", which the view renders as unobserved. That is a real
            // state, not a malformed cell, so it must still be accepted.
            { memoryMode: "jit", outcomeKind: null, sessionCount: 18 }
          ])
        )
      )
    ).kind,
    "ok",
    "a cohort page with a null outcomeKind must be accepted"
  );
  const droppedCells: readonly (readonly [string, unknown])[] = [
    ["no sessionCount", { memoryMode: "jit", outcomeKind: "success" }],
    ["no memoryMode", { outcomeKind: "success", sessionCount: 3 }]
  ];
  for (const [label, cell] of droppedCells) {
    const result = await fetchMemoryCohorts(
      cohortScope,
      config,
      serve(sessionCohortPage([cell]))
    );
    assert.notEqual(
      result.kind,
      "ok",
      `a cohort cell with ${label} must fail closed`
    );
  }

  // And the injection-use cohort fetch, which had no response guard at all --
  // how nineteen other fetches were hardened earlier and this one was missed.
  assert.equal(
    (
      await fetchMemoryUseCohorts(
        cohortScope,
        config,
        serve({
          schema: "autodev-memory-injection-use-cohorts-v1",
          workspaceId: "SimulatorLife/AutoDev",
          repositoryId: "autodev",
          occurredFrom: cohortScope.occurredFrom,
          occurredUntil: cohortScope.occurredUntil,
          cells: [
            {
              memoryMode: "retrieval-only",
              sessionCardinality: "single",
              useKind: "used",
              exposureCount: 148
            }
          ],
          exposureCount: 148
        })
      )
    ).kind,
    "ok",
    "a complete injection-use cohort page must be accepted"
  );
  assert.notEqual(
    (
      await fetchMemoryUseCohorts(
        cohortScope,
        config,
        serve({
          schema: "autodev-memory-injection-use-cohorts-v1",
          workspaceId: "SimulatorLife/AutoDev",
          repositoryId: "autodev",
          occurredFrom: cohortScope.occurredFrom,
          occurredUntil: cohortScope.occurredUntil,
          cells: [
            { memoryMode: "jit", sessionCardinality: "single", useKind: "used" }
          ],
          exposureCount: 3
        })
      )
    ).kind,
    "ok",
    "a use-cohort cell with no exposureCount must fail closed"
  );
});
test("a drawer title row can lose space to its badges, never the other way round", () => {
  // The title row is the one flex line where the wrong item must not shrink.
  // Badges are `whitespace-nowrap` pills, so their automatic minimum size is
  // their full width and they cannot shrink at all; the title carries `min-w-0`
  // precisely so a long unbreakable id can, which made the title the only item
  // that *could* give. At a 390px viewport the memory experience drawer had a
  // 194px row holding "Role: orchestrator" (148px) and "not_run" (79px) plus a
  // 12px gap, and the entity name collapsed to a zero-width, 224px-tall box:
  // nothing painted, and the panel reserved the height of a name it was not
  // showing.
  //
  // Measured in Chromium before the fix and after it, on the real page; this
  // test holds the layout contract so it cannot come back through a refactor.
  // A `flex-wrap` row is what puts the badges on their own line instead.
  assert.match(
    DETAIL_DRAWER_TITLE_ROW_CLASS,
    /\bflex-wrap\b/,
    `the drawer title row must wrap, got: ${DETAIL_DRAWER_TITLE_ROW_CLASS}`
  );
  assert.match(
    DETAIL_DRAWER_TITLE_ROW_CLASS,
    /\bmin-w-0\b/,
    `the drawer title row must stay shrinkable as a whole, got: ${DETAIL_DRAWER_TITLE_ROW_CLASS}`
  );

  // The badge pills must keep `whitespace-nowrap`: a chip that breaks mid-word
  // to avoid this problem trades one defect for another. The fix is the wrap,
  // not making badges squish.
  const chip = renderToStaticMarkup(
    React.createElement(Chip, { label: "Filter" }, "Role: orchestrator")
  );
  assert.match(
    chip,
    /whitespace-nowrap/,
    `a badge must not be made to shrink; the row wraps instead, got: ${chip}`
  );
});
test("a catalog row missing the fields its view reads fails closed instead of throwing", async () => {
  // The failure shell is only reachable when a fetcher reports `ok`. A guard
  // that narrows a payload to its catalog type but checks only the row's
  // identifier lets an incomplete payload through as `ok`, and the view then
  // dereferences the missing field during render -- an HTTP 500 with no <h1>
  // at all, which is the one outcome worse than a visible failure shell.
  //
  // Both directions are asserted for every collection below, because only the
  // first is easy: the identifier-only payload must be rejected, and the
  // payload the guard *does* accept must render without throwing. The second
  // assertion is what keeps a guard from drifting back toward identifier-only
  // checking, and it is the assertion that fails if a guard starts rejecting
  // rows the view can perfectly well render.
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "server-only"
  };
  const serve = (payload: unknown) => ({
    fetchImpl: async () => Response.json(payload)
  });
  const reconciliation = {
    convergence: "converged",
    desiredGeneration: "1",
    observedGeneration: "1",
    lastApplyAt: "2026-01-01T00:00:00.000Z",
    lastObservationAt: "2026-01-01T00:00:00.000Z",
    lastError: null,
    explanation: "Observed generation matches the desired generation."
  };

  // --- MCP servers: the view reads transport.toUpperCase(), targetOverrides
  // --- .length, and the role chips, and renders `declared`/`enabled` claims.
  const mcpRow = {
    name: "github",
    enabled: true,
    transport: "stdio",
    // Overrides are records, not strings. A string-list check on this field
    // rejects every well-formed catalog, which reads as "the data is bad"
    // rather than "the guard is wrong" -- so the fixture carries a real entry.
    targetOverrides: [{ target: "codexcli", enabled: true }],
    declared: true,
    roles: ["orchestrator"]
  };
  const mcpEnvelope = (servers: unknown[]) => ({
    schema: "autodev-control-mcps-v1",
    source: ".rulesync/mcp.jsonc",
    readOnly: true,
    valid: true,
    issues: [],
    servers
  });
  const mcpAccept = await fetchMcps(config, serve(mcpEnvelope([mcpRow])));
  assert.equal(mcpAccept.kind, "ok");
  // Dropping each required member in turn must fail closed.
  for (const dropped of [
    "enabled",
    "transport",
    "targetOverrides",
    "declared",
    "roles"
  ]) {
    const incomplete = await fetchMcps(
      config,
      serve(mcpEnvelope([{ ...mcpRow, [dropped]: undefined }]))
    );
    assert.equal(
      incomplete.kind,
      "invalid-response",
      `an MCP row without "${dropped}" must not reach the view`
    );
  }

  // --- Providers: the readiness badge reads `cooldown.failureClass`. The
  // --- nested record is nullable, but omitting the key yields `undefined`,
  // --- which is not `null`, so the badge's `!== null` test passes and the
  // --- read throws. This one crashed /providers in the browser sweep.
  const providerRole = (overrides: Record<string, unknown> = {}) => ({
    priority: 1,
    model: "anthropic/claude",
    mutable: false,
    convergence: reconciliation,
    ...overrides
  });
  const providerRow = {
    id: "anthropic",
    disabled: false,
    agentLimits: { perSession: 2, acrossSessions: null },
    route: null,
    credential: { envKey: "ANTHROPIC_API_KEY", configured: true },
    roles: {
      default: providerRole(),
      smart: providerRole(),
      orchestrator: providerRole(),
      subagent: providerRole()
    },
    models: [{ tier: "orchestrator", model: "anthropic/claude" }],
    priorities: [{ tier: "orchestrator", group: 1 }],
    orchestratorReasoningEffort: null,
    health: { cooldown: null, lastFailure: null }
  };
  const providersEnvelope = (providers: unknown[]) => ({
    schema: "autodev-control-providers-v2",
    orchestratorTier: "orchestrator",
    tiers: [{ tier: "orchestrator", groups: [["anthropic"]] }],
    providers
  });
  const providersAccept = await fetchProviders(
    config,
    serve(providersEnvelope([providerRow]))
  );
  assert.equal(providersAccept.kind, "ok");
  for (const dropped of [
    "health",
    "credential",
    "models",
    "priorities",
    "roles",
    "disabled",
    "agentLimits"
  ]) {
    const incomplete = await fetchProviders(
      config,
      serve(providersEnvelope([{ ...providerRow, [dropped]: undefined }]))
    );
    assert.equal(
      incomplete.kind,
      "invalid-response",
      `a provider row without "${dropped}" must not reach the view`
    );
  }
  // Every role Core declares must be present: a role missing from the response
  // is unobserved, and rendering a control for it would let an operator pick a
  // priority the Runtime never reported.
  for (const role of PROVIDER_ROLES) {
    const roles = { ...providerRow.roles } as Record<string, unknown>;
    delete roles[role];
    const missingRole = await fetchProviders(
      config,
      serve(providersEnvelope([{ ...providerRow, roles }]))
    );
    assert.equal(
      missingRole.kind,
      "invalid-response",
      `a provider row missing the "${role}" role must not reach the view`
    );
  }
  // A half-present nested record is as unreadable as an absent one.
  const halfCooldown = await fetchProviders(
    config,
    serve(
      providersEnvelope([
        { ...providerRow, health: { cooldown: { kind: "overloaded" } } }
      ])
    )
  );
  assert.equal(halfCooldown.kind, "invalid-response");

  // --- Permissions: the whole policy was checked only as "a record", so one
  // --- with no members passed. That produced four wrong cards in one row --
  // --- a blank Approval Policy card (React draws nothing for `undefined`),
  // --- and "Blocked"/"Disabled" read out of two falsy undefineds.
  const policyRow = {
    approvalPolicy: "on-demand",
    sandboxMode: "workspace-write",
    approvalsReviewer: "user",
    networkAccess: true,
    webSearch: true,
    defaultToolsApprovalMode: "approve"
  };
  const permissionsEnvelope = (policy: unknown) => ({
    schema: "autodev-control-permissions-v1",
    source: ".rulesync/permissions",
    readOnly: true,
    policy,
    rolePermissions: {}
  });
  assert.equal(
    (await fetchPermissions(config, serve(permissionsEnvelope(policyRow))))
      .kind,
    "ok",
    "a complete policy is accepted"
  );
  for (const dropped of [
    "approvalPolicy",
    "sandboxMode",
    "approvalsReviewer",
    "networkAccess",
    "webSearch",
    "defaultToolsApprovalMode"
  ]) {
    const incomplete = await fetchPermissions(
      config,
      serve(permissionsEnvelope({ ...policyRow, [dropped]: undefined }))
    );
    assert.equal(
      incomplete.kind,
      "invalid-response",
      `a policy without "${dropped}" must not reach the view`
    );
  }
  // Both vocabularies are closed, and a drifted value must fail closed rather
  // than render as a novel policy name.
  for (const drifted of [
    { approvalPolicy: "sometimes" },
    { sandboxMode: "anything-goes" }
  ]) {
    const driftedResult = await fetchPermissions(
      config,
      serve(permissionsEnvelope({ ...policyRow, ...drifted }))
    );
    assert.equal(
      driftedResult.kind,
      "invalid-response",
      `a drifted policy vocabulary (${JSON.stringify(drifted)}) must fail closed`
    );
  }

  // Every mode Core declares must reach the view, driven from the shared list
  // rather than restated here. That is what stops the Console from silently
  // narrowing: a mode added to `SANDBOX_MODES` is accepted on the day it lands,
  // and one that the Console rejects shows up as this test failing rather than
  // as a blank policy card in production.
  for (const mode of SANDBOX_MODES) {
    const accepted = await fetchPermissions(
      config,
      serve(permissionsEnvelope({ ...policyRow, sandboxMode: mode }))
    );
    assert.equal(
      accepted.kind,
      "ok",
      `the supported sandbox mode "${mode}" must be accepted`
    );
  }
  // A near-miss of a real mode is the case that used to render as a confident
  // novel policy name: same letters, wrong case.
  for (const nearMiss of ["Read-Only", "workspace_write", "workspace-write "]) {
    const rejected = await fetchPermissions(
      config,
      serve(permissionsEnvelope({ ...policyRow, sandboxMode: nearMiss }))
    );
    assert.equal(
      rejected.kind,
      "invalid-response",
      `the near-miss "${nearMiss}" must fail closed`
    );
  }

  // --- Tools: role exposure drives both the role filter and the role chips,
  // --- and `availability` is what separates "Configured" from "Not observed".
  const toolRow = {
    name: "mcp__github__create_issue",
    source: "mcp",
    sourceAuthority: "rulesync-mcp",
    exposedRoles: ["orchestrator"],
    availability: "configured"
  };
  const toolsEnvelope = (tools: unknown[]) => ({
    schema: "autodev-control-tools-v2",
    source: "rulesync-mcp+execution-contract",
    readOnly: true,
    coverage: "complete",
    validity: "valid",
    totalTools: 1,
    usageLink: "/usage",
    tools
  });
  const toolsAccept = await fetchTools(config, serve(toolsEnvelope([toolRow])));
  assert.equal(toolsAccept.kind, "ok");
  for (const dropped of [
    "source",
    "sourceAuthority",
    "exposedRoles",
    "availability"
  ]) {
    const incomplete = await fetchTools(
      config,
      serve(toolsEnvelope([{ ...toolRow, [dropped]: undefined }]))
    );
    assert.equal(
      incomplete.kind,
      "invalid-response",
      `a tool row without "${dropped}" must not reach the view`
    );
  }

  // --- GitHub workflows: the catalog column and the scheduled count are both
  // --- derived from these lists, so a row without them cannot be rendered.
  const workflowRow = {
    id: "_scheduler.yml",
    name: "Scheduler",
    path: ".github/workflows/_scheduler.yml",
    events: ["schedule"],
    schedules: ["0 * * * *"]
  };
  const githubEnvelope = (workflows: unknown[]) => ({
    schema: "autodev-control-github-v1",
    source: ".github/workflows",
    readOnly: true,
    catalogStatus: "valid",
    totalWorkflows: 1,
    runtimeFactsAvailable: false,
    runtimeStatus: "unavailable",
    runtimeMessage: null,
    repository: null,
    stats: null,
    workflows,
    recentRuns: []
  });
  const githubAccept = await fetchGithubWorkflows(
    config,
    serve(githubEnvelope([workflowRow]))
  );
  assert.equal(githubAccept.kind, "ok");
  // Stats were checked only as "a record", so an *empty* one reached the view:
  // `Math.round(stats.successRate * 100)` published `NaN%` and `totalRuns` drew
  // an empty stat card. An unreadable projection must fail closed instead.
  const statsRow = {
    totalRuns: 12,
    successfulRuns: 10,
    failedRuns: 1,
    inProgressRuns: 1,
    cancelledRuns: 0,
    successRate: 0.83
  };
  assert.equal(
    (
      await fetchGithubWorkflows(
        config,
        serve({ ...githubEnvelope([workflowRow]), stats: statsRow })
      )
    ).kind,
    "ok",
    "a complete stats projection is accepted"
  );
  for (const dropped of [
    "totalRuns",
    "successfulRuns",
    "failedRuns",
    "inProgressRuns",
    "cancelledRuns",
    "successRate"
  ]) {
    const incomplete = await fetchGithubWorkflows(
      config,
      serve({
        ...githubEnvelope([workflowRow]),
        stats: { ...statsRow, [dropped]: undefined }
      })
    );
    assert.equal(
      incomplete.kind,
      "invalid-response",
      `stats without "${dropped}" must not reach the view`
    );
  }
  // A null rate is an observed absence, not a missing one.
  assert.equal(
    (
      await fetchGithubWorkflows(
        config,
        serve({
          ...githubEnvelope([workflowRow]),
          stats: { ...statsRow, successRate: null }
        })
      )
    ).kind,
    "ok",
    "a null success rate is a real reading"
  );
  for (const dropped of ["name", "path", "events", "schedules"]) {
    const incomplete = await fetchGithubWorkflows(
      config,
      serve(githubEnvelope([{ ...workflowRow, [dropped]: undefined }]))
    );
    assert.equal(
      incomplete.kind,
      "invalid-response",
      `a workflow row without "${dropped}" must not reach the view`
    );
  }

  // --- Evaluations: `passed` is a three-state verdict (true/false/null). A
  // --- missing one compares as a failure, so an unreadable verdict would be
  // --- synthesized as "did not pass" rather than shown as unobserved.
  const evaluationRow = {
    id: "eval-1",
    agentRole: "orchestrator",
    model: "anthropic/claude",
    metrics: [],
    passed: null,
    timestamp: "2026-01-01T00:00:00.000Z"
  };
  const evaluationsEnvelope = (evaluations: unknown[]) => ({
    schema: "autodev-control-evaluations-v1",
    source: "clickhouse",
    readOnly: true,
    totalEvaluations: 1,
    evaluations
  });
  const evaluationsAccept = await fetchEvaluations(
    config,
    serve(evaluationsEnvelope([evaluationRow]))
  );
  assert.equal(evaluationsAccept.kind, "ok");
  for (const dropped of [
    "agentRole",
    "model",
    "metrics",
    "passed",
    "timestamp"
  ]) {
    const incomplete = await fetchEvaluations(
      config,
      serve(evaluationsEnvelope([{ ...evaluationRow, [dropped]: undefined }]))
    );
    assert.equal(
      incomplete.kind,
      "invalid-response",
      `an evaluation row without "${dropped}" must not reach the view`
    );
  }

  // Finally: what the guards accept must actually render. This is the
  // assertion that would have caught the original crash.
  assert.match(
    renderToStaticMarkup(
      React.createElement(McpsView, {
        servers: [mcpRow as never],
        sourceValidity: true,
        validationIssues: []
      })
    ),
    /github/
  );
  assert.match(
    renderToStaticMarkup(
      React.createElement(ToolsView, {
        tools: [toolRow as never],
        coverage: "complete",
        validity: "valid",
        usageLink: "/usage",
        filters: { source: "", role: "" }
      })
    ),
    /create_issue/
  );
  assert.match(
    renderToStaticMarkup(
      React.createElement(GithubView, { workflows: [workflowRow as never] })
    ),
    /_scheduler\.yml/
  );
  // `passed: null` is the unobserved verdict, and it must survive the whole
  // round trip as "Not observed" rather than collapsing into a counted zero.
  const evaluationsMarkup = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      evaluations: [evaluationRow as never]
    })
  );
  assert.match(evaluationsMarkup, /orchestrator/);
  assert.match(evaluationsMarkup, /data-evaluation-pass-rate-observed="false"/);
  assert.match(evaluationsMarkup, /Not observed/);
  assert.doesNotMatch(
    evaluationsMarkup,
    /Pass Rate<\/span>[\s\S]{0,200}?>100%/,
    "an unobserved verdict must not be reported as a percentage"
  );
});

test("BarChart keeps unobserved, empty and observed data three distinct things", () => {
  // The whole point of a chart on this surface is that it encodes a
  // measurement. An unobserved source must therefore never render as a chart
  // with no bars, because that reads as "measured, and the value is zero" —
  // which is exactly the synthesis the target state forbids.
  const base = {
    label: "Requests by role",
    barClass: "bg-chart-1",
    notObservedMessage: "Role telemetry not observed.",
    emptyMessage: "No requests in range."
  };

  const unobserved = renderToStaticMarkup(
    React.createElement(BarChart, { ...base, data: null })
  );
  assert.match(unobserved, /Role telemetry not observed\./);
  assert.doesNotMatch(unobserved, /<ul/);
  assert.doesNotMatch(unobserved, /rounded-sm/);

  const empty = renderToStaticMarkup(
    React.createElement(BarChart, { ...base, data: [] })
  );
  assert.match(empty, /No requests in range\./);
  assert.doesNotMatch(empty, /<ul/);

  const observed = renderToStaticMarkup(
    React.createElement(BarChart, {
      ...base,
      data: [
        { label: "orchestrator", value: 8, valueText: "8" },
        { label: "validator", value: 2, valueText: "2" }
      ]
    })
  );
  assert.match(observed, /aria-label="Requests by role"/);
  // Bars are scaled to the largest value in the set, not to an absolute total.
  assert.match(observed, /bg-chart-1" style="width:100%"/);
  assert.match(observed, /bg-chart-1" style="width:25%"/);
  // A value of zero is still a bar and still a number, never a missing row.
  const withZero = renderToStaticMarkup(
    React.createElement(BarChart, {
      ...base,
      data: [
        { label: "a", value: 0, valueText: "0" },
        { label: "b", value: 0, valueText: "0" }
      ]
    })
  );
  assert.match(withZero, /<li/);
  assert.match(withZero, />0<\/span>/);
});

test("FilterBar owns the form, the submit action and the state a filter must preserve", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      FilterBar,
      {
        label: "Record filters",
        action: "/memory",
        preserved: [
          { name: "tab", value: "records" },
          { name: "workspaceId", value: "SimulatorLife/AutoDev" }
        ],
        submitTestId: "memory-filter",
        summary: "3 of 12 records"
      },
      React.createElement(FilterSearchField, {
        name: "query",
        defaultValue: "deployment",
        label: "Search memory claims",
        placeholder: "Search memory claims..."
      })
    )
  );

  // A form is a landmark, so it has to be named. The two Memory bars used to
  // be anonymous, which left three filter regions indistinguishable.
  assert.match(markup, /<form[^>]*method="GET"/);
  assert.match(markup, /<form[^>]*action="\/memory"/);
  assert.match(markup, /<form[^>]*aria-label="Record filters"/);

  // The surface and the wrapping row come from the primitive, so four filter
  // bars cannot drift into four spellings of the same box.
  const formTag = markup.slice(
    markup.indexOf("<form"),
    markup.indexOf(">", markup.indexOf("<form")) + 1
  );
  for (const required of [
    "rounded-lg",
    "border",
    "bg-surface",
    "flex",
    "flex-wrap"
  ]) {
    assert.ok(
      formTag.includes(required),
      `FilterBar form must carry ${required}, got: ${formTag}`
    );
  }

  // State that has no control on the bar survives the submission, or applying
  // a filter silently resets the tab and drops the list out of its workspace.
  assert.match(markup, /<input type="hidden" name="tab" value="records"/);
  assert.match(
    markup,
    /<input type="hidden" name="workspaceId" value="SimulatorLife\/AutoDev"/
  );

  // The submit control is the shared primary Button, not a hand-typed button:
  // PRIMARY_BUTTON_CLASS markers are asserted so a re-typed submit fails here.
  const submitTag = markup.slice(
    markup.lastIndexOf("<button"),
    markup.indexOf(">", markup.lastIndexOf("<button")) + 1
  );
  assert.match(submitTag, /type="submit"/);
  assert.match(submitTag, /data-button="memory-filter"/);
  for (const required of [
    "bg-accent",
    "border-transparent",
    "text-fg-inverse"
  ]) {
    assert.ok(
      submitTag.includes(required),
      `FilterBar submit must use the shared primary chrome, got: ${submitTag}`
    );
  }
  assert.match(markup, />Apply filters<\/button>/);

  // The result count sits on the trailing edge.
  assert.match(markup, /ml-auto text-xs text-fg-muted">3 of 12 records</);
});

test("FilterSearchField keeps its accessible name when the placeholder is gone", () => {
  // A placeholder is not a label: it disappears the moment the field has a
  // value, and the Experience bar shipped with no other name at all. The
  // accessible name must come from a real <label>, so it survives typing.
  const markup = renderToStaticMarkup(
    React.createElement(FilterSearchField, {
      name: "query",
      defaultValue: "already typed",
      label: "Search experiences by task, run, role, or trajectory",
      placeholder: "Search experiences..."
    })
  );

  const labelFor = markup.match(/<label[^>]*for="([^"]+)"/)?.[1];
  assert.ok(labelFor, "FilterSearchField must render a real <label for>");
  assert.match(
    markup,
    new RegExp(`<input id="${labelFor}"[^>]*type="search"`, "u")
  );
  assert.match(markup, /Search experiences by task, run, role, or trajectory/);
  // The control matches the selects beside it instead of re-typing its chrome.
  assert.match(markup, /bg-input/);
  assert.match(markup, /border-border-strong/);
  assert.match(markup, /max-w-full/);
});

test("no feature view hand-types a GET form: filter state belongs to FilterBar", () => {
  // Every GET form in the Console is a filter bar, and every filter bar now
  // goes through the primitive. A hand-typed one is how four identical-looking
  // rows drifted into four different behaviours in the first place, so this
  // fails at the source rather than leaving it to a reviewer's eye.
  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const offenders: string[] = [];
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const file = join(featuresDir, relative.toString());
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    if (!/method:\s*"GET"/u.test(source) && !/method:\s*"get"/u.test(source)) {
      continue;
    }
    if (!source.includes("FilterBar")) {
      offenders.push(relative.toString());
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These views declare a GET form without the shared FilterBar primitive:\n${offenders.join("\n")}`
  );
});

test("no feature view hand-types a submit button: the Button vocabulary is shared", () => {
  // The governed-actions row on a memory record carried three submit buttons
  // with three arbitrary fills -- success, error, and a chart series colour
  // used as a button background -- and the prompt editor had a fourth
  // hand-typed "primary". One action per colour meant nothing was readable as
  // primary, secondary, or destructive.
  //
  // A raw <button> is still legitimate where it is a control rather than a
  // submission (the enablement toggle renders a status pill). This guard is
  // specifically about submit buttons, which the shared Button owns.
  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const offenders: string[] = [];
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const file = join(featuresDir, relative.toString());
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    // A hand-typed submit button always carries its own className, because a
    // bare <button type="submit"> would have no styling at all.
    const pattern =
      /createElement\(\s*"button",\s*\{[^}]*type:\s*"submit"[^}]*className/gsu;
    if (pattern.test(source)) offenders.push(relative.toString());
  }
  assert.deepEqual(
    offenders,
    [],
    `These views hand-type a submit button instead of using Button:\n${offenders.join("\n")}`
  );
});

test("governed record actions read as one primary, one destructive, one secondary", () => {
  // Three record mutations share one row, so they have to be distinguishable
  // by role rather than by three unrelated background colours. No single
  // record shows all three, so both relevant states are rendered.
  const record = (
    id: string,
    status: MemoryRecord["status"]
  ): MemoryRecord => ({
    id,
    kind: "procedural",
    status,
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "Run the Console suite before pushing.",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z"
  });

  const renderActions = (selected: MemoryRecord): string =>
    renderToStaticMarkup(
      React.createElement(MemoryRecordsView, {
        records: [selected],
        total: 1,
        listScope: memoryListScope(),
        // The governed actions live in the record detail panel, which renders
        // for the record selected in the URL.
        selectedRecord: selected
      })
    );

  const buttonTag = (markup: string, id: string): string =>
    markup.match(
      new RegExp(`<button[^>]*data-button="${id}"[^>]*>`, "u")
    )?.[0] ?? "";

  const proposed = renderActions(record("mem-proposed", "proposed"));
  const active = renderActions(record("mem-active", "active"));

  // Verify is the affirmative action, so it carries the primary accent fill.
  assert.match(buttonTag(proposed, "memory-verify"), /bg-accent/);
  // Invalidate reads as destructive, matching the shared destructive variant
  // every other irreversible control in the Console uses.
  assert.match(buttonTag(proposed, "memory-invalidate"), /text-error/);
  // Promote is an alternative action, so it is a secondary control rather
  // than a third arbitrary fill. It used to be chart-3, a data-series token
  // used as a button background.
  assert.match(buttonTag(active, "memory-promote-skill"), /bg-surface-raised/);
  assert.doesNotMatch(proposed + active, /bg-chart-3 hover:brightness-110/);

  // Each action is a real submit button inside its own form, so every one of
  // them posts without a client-side handler.
  const combined = proposed + active;
  assert.equal(
    combined.match(/data-button="memory-/g)?.length,
    combined.match(/type="submit"/g)?.length
  );
});

test("DetailDrawer is the shared selected-item panel, not a per-feature copy", () => {
  // The two Memory selection panels shared four hand-copied class strings
  // between them, so the only thing keeping them identical was nobody editing
  // one of them. Both must now render the primitive's surface and header.
  const drawer = renderToStaticMarkup(
    React.createElement(
      DetailDrawer,
      {
        title: "mem-1",
        subtitle: "Scope: SimulatorLife/AutoDev",
        closeHref: "/memory?tab=records",
        badges: React.createElement(
          "span",
          { className: TAG_SHAPE },
          "procedural"
        )
      },
      React.createElement("p", null, "Body")
    )
  );

  assert.ok(drawer.includes(DETAIL_DRAWER_CLASS));
  assert.ok(drawer.includes(DETAIL_DRAWER_HEADER_CLASS));
  assert.ok(drawer.includes(DETAIL_DRAWER_SUBTITLE_CLASS));
  // The title is the entity's own heading, so the drawer keeps one h1/h2
  // outline rather than inventing a heading level of its own.
  assert.match(drawer, /<h2 class="[^"]*break-words[^"]*"[^>]*>mem-1<\/h2>/);
  // Dismissal is a plain link to the list without the selection, so the drawer
  // works with no JavaScript and the selection stays URL-addressable.
  assert.match(drawer, /href="\/memory\?tab=records"/);
  assert.match(drawer, />Close<\/a>/);
  assert.doesNotMatch(drawer, /<dialog/);
  assert.doesNotMatch(drawer, /onClick/);
});

test("no feature view re-copies the selected-item drawer surface", () => {
  // bg-selected is the drawer's own surface. A feature that hand-writes it is
  // rebuilding the drawer instead of using it.
  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const offenders: string[] = [];
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const file = join(featuresDir, relative.toString());
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes("bg-selected") && !source.includes("DetailDrawer")) {
      offenders.push(relative.toString());
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These views hand-copy the drawer surface:\n${offenders.join("\n")}`
  );
});

test("CodeBlock and CodeEditor share one chrome instead of seven spellings", () => {
  const block = renderToStaticMarkup(
    React.createElement(CodeBlock, {
      content: "print('hi')",
      ariaLabel: "Example source",
      dataAttributes: { "data-example": "observed" }
    })
  );

  // Asserted by containment rather than by RegExp: these class strings contain
  // `[32rem]`-style arbitrary values, which a RegExp would read as a character
  // class instead of a literal.
  assert.ok(block.includes(CODE_BLOCK_CLASS));
  // The default cap is a named value from the closed set, not a literal the
  // caller appended -- Tailwind resolves same-property utilities by
  // stylesheet order, so a composed max-h would silently lose.
  assert.ok(
    block.includes(`${CODE_BLOCK_CLASS} ${CODE_BLOCK_HEIGHT_CLASS.secondary}`),
    `expected the secondary cap, got: ${block}`
  );
  assert.match(block, /aria-label="Example source"/);
  assert.match(block, /data-example="observed"/);
  // Source is shown verbatim, never reformatted or truncated. React escapes
  // the apostrophe, so the entity form is what the markup carries.
  assert.match(block, />print\(&#x27;hi&#x27;\)<\/pre>$/);

  // The primary variant is a taller cap for the page's main document.
  const primary = renderToStaticMarkup(
    React.createElement(CodeBlock, { content: "x", height: "primary" })
  );
  assert.ok(primary.includes(CODE_BLOCK_HEIGHT_CLASS.primary));

  const snippet = renderToStaticMarkup(
    React.createElement(
      "pre",
      { className: `${CODE_SNIPPET_CLASS} mb-3` },
      "inline"
    )
  );
  assert.ok(snippet.includes(`${CODE_SNIPPET_CLASS} mb-3`));

  const editor = renderToStaticMarkup(
    React.createElement(CodeEditor, {
      id: "prompt-content",
      name: "content",
      defaultValue: "# Command",
      ariaLabel: "Canonical Markdown source"
    })
  );
  assert.ok(editor.includes(CODE_EDITOR_CLASS));
  // A real form control: submits on its own, works without scripting, and is
  // announced with the name rather than a placeholder.
  assert.match(editor, /<textarea/);
  assert.match(editor, /aria-label="Canonical Markdown source"/);
  assert.doesNotMatch(editor, /contenteditable/);
  assert.doesNotMatch(editor, /onChange|onInput/);
});

test("no feature view hand-types a code or config surface", () => {
  // A bordered monospace scrolling block is the primitive's job. This checks
  // each rendered <pre>/<textarea> individually rather than per file, so a
  // feature that uses CodeBlock in one place cannot hand-type another code
  // surface in the same file.
  //
  // A surface qualifies as hand-typed when font-mono appears in a literal
  // class string. Referencing CODE_BLOCK_CLASS or CODE_SNIPPET_CLASS carries
  // font-mono through the constant instead, so the preview's markdown `pre`
  // override stays legal.
  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const offenders: string[] = [];
  const surface = /createElement\(\s*"(?:pre|textarea)"\s*,\s*\{([^}]*)\}/gsu;
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const file = join(featuresDir, relative.toString());
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(surface)) {
      const props = match[1] ?? "";
      if (!/className:\s*[`'"][^`'"]*font-mono/u.test(props)) continue;
      offenders.push(
        `${relative.toString()}: ${props.trim().replaceAll(/\s+/gu, " ").slice(0, 70)}`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These views hand-type a code surface instead of using CodeBlock/CodeEditor:\n${offenders.join("\n")}`
  );
});

test("EmptyState keeps box and inline distinct and never invents its message", () => {
  // An empty table is a region with nothing in it; an empty series is a slot
  // inside a region. They are not the same shape, so they are not the same
  // treatment -- but they are one vocabulary, not three hand-typed ones.
  const box = renderToStaticMarkup(
    React.createElement(EmptyState, {
      message: "No providers are configured.",
      testId: "table"
    })
  );
  assert.ok(box.includes(EMPTY_BOX_CLASS));
  assert.match(box, /data-empty-state="table"/);
  assert.match(box, /No providers are configured\./);
  // The mark is decorative: it sits directly above the sentence it repeats.
  assert.match(box, /aria-hidden="true"/);

  const inline = renderToStaticMarkup(
    React.createElement(EmptyState, {
      message: "No logical requests were observed in this time range.",
      variant: "inline"
    })
  );
  assert.ok(inline.includes(EMPTY_INLINE_CLASS));
  // The inline slot has no box and no icon: it fills a position inside a
  // panel, and a 24px mark inside a chart would read as a data point.
  assert.doesNotMatch(inline, /<svg/);
});

test("italic is the shared absent-state signal, not a style for real values", () => {
  // Hooks rendered an observed status message in muted italic, which is the
  // same idiom the Console uses for "nothing here", and had also lost the
  // text-xs every other muted note carries. Italic now means absent, so a
  // value that really was observed must not borrow it.
  const markup = readFileSync(
    join(import.meta.dirname, "..", "src", "features", "hooks", "HooksView.ts"),
    "utf8"
  );
  assert.doesNotMatch(markup, /text-fg-muted italic/);
  assert.doesNotMatch(markup, /italic/);
});

test("no feature view hand-types an empty state", () => {
  // The Console's "nothing here" was written by hand in three places, one of
  // which had drifted to a different font size.
  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const offenders: string[] = [];
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const file = join(featuresDir, relative.toString());
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    if (/\bitalic\b/.test(source) && !source.includes("EmptyState")) {
      offenders.push(relative.toString());
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These views style an absent-state by hand instead of using EmptyState:\n${offenders.join("\n")}`
  );
});

test("one grid ladder: every card row and labelled-fact row resolves its columns through it", () => {
  // The row was hand-written at thirty-two sites with five spellings, and the
  // disagreement was visible rather than cosmetic: eleven took the two-column
  // step at `sm` (640px) and four at `md` (768px), so an operator moving
  // between Agents and Tools at a 700px window saw a two-column row on one page
  // and a single-column stack on another. Three Memory grids started at
  // `grid-cols-2` and never collapsed at all.
  //
  // A breakpoint only means something if it means the same thing everywhere, so
  // the ladder lives in one table and this guard fails the moment a view writes
  // its own `grid-cols-` steps again. The exemptions are deliberate and narrow:
  // three sites whose columns hold unstyled text rather than cards, which is a
  // different shape with a different budget.
  const EXEMPT: ReadonlySet<string> = new Set([
    "mcps/McpDetailView.ts",
    "prompts/PromptDetailView.ts"
  ]);

  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const offenders: string[] = [];
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const name = relative.toString();
    if (EXEMPT.has(name)) continue;
    const file = join(featuresDir, name);
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/className:\s*(["'`])([^"'`]*)\1/g)) {
      // `gridRowClass` and the two shared grids are the ladder itself. Anything
      // else carrying a `grid-cols-` step is a view choosing its own.
      if (!/(^|\s)grid-cols-[\d]/.test(m[2] ?? "")) continue;
      if (source.includes("components/panels/DetailGrid")) continue;
      offenders.push(`${name}: ${m[2] ?? ""}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These views hand-write their own grid columns instead of using StatGrid, DetailGrid or gridRowClass:\n${offenders.join("\n")}`
  );
});

test("every labelled fact has one implementation, and 'Not observed' has one spelling", () => {
  // Two duplication problems that a typecheck and a passing suite both miss,
  // because each copy is correct on its own.
  //
  // `DetailValue` existed four times -- in the agent detail, agents list,
  // provider detail and model detail views -- and three were byte-identical. Two
  // had drifted: the agent detail copy had dropped the wrapping rule on its
  // value, and the agents list copy had grown a `valueClassName: null` hatch.
  //
  // The guard is on the copied shape rather than on the element: a `<dt>` alone
  // is not a copy. `ProvidersView` builds a `<dl>` of routing tiers whose `dd`
  // holds a chip list laid out on a baseline, which is a different component
  // with a different budget, so the signal is a `<dd>` carrying the copied
  // `text-sm` value treatment.
  //
  // `NOT_OBSERVED_LABEL` was declared as a local const in eight feature files.
  // It is the one string the product must never reword: it is how the Console
  // says evidence is missing, and a view that says "Unknown" beside a badge
  // that says "Not observed" makes the page contradict itself about whether
  // evidence is absent or actively wrong.
  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const detailCopies: string[] = [];
  const labelCopies: string[] = [];
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const name = relative.toString();
    const file = join(featuresDir, name);
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    const buildsOwnFact =
      /createElement\(\s*"dt"/.test(source) &&
      /createElement\(\s*"dd",\s*\{\s*className:\s*(["'`])[^"'`]*\btext-sm\b/.test(
        source
      );
    if (buildsOwnFact && !source.includes("DetailValue")) {
      detailCopies.push(name);
    }
    if (/const NOT_OBSERVED_LABEL\s*=/.test(source)) {
      labelCopies.push(name);
    }
  }
  assert.deepEqual(
    detailCopies,
    [],
    `These views build their own labelled fact instead of using DetailValue:\n${detailCopies.join("\n")}`
  );
  assert.deepEqual(
    labelCopies,
    [],
    `These views declare their own "Not observed" string instead of importing NOT_OBSERVED_LABEL:\n${labelCopies.join("\n")}`
  );
});

test("an unobserved routing counter is never rendered as a zero", () => {
  // The Runtime omits a concurrency field it has no evidence for. Printing `0`
  // there claims an observed idle state that was never measured -- and it is
  // the claim an operator acts on, because "0 active subagent threads" reads as
  // a healthy router. The sibling field on the same panel already said "Not
  // observed" for the same missing block, so the page contradicted itself
  // between two adjacent facts.
  const withoutRouting = renderToStaticMarkup(
    React.createElement(AgentDetailView, { agent: CONFIGURED_AGENT })
  );
  // `CONFIGURED_AGENT` carries no routing block at all.
  assert.ok(
    withoutRouting.includes("Active subagent threads"),
    `the panel must still render the fact, got: ${withoutRouting}`
  );
  assert.ok(
    withoutRouting.includes("Not observed"),
    `an absent routing block must read as not observed, got: ${withoutRouting}`
  );
  // The specific defect: the value cell said zero.
  const threadRow = withoutRouting.match(
    /Active subagent threads[\s\S]{0,400}?<\/dd>/
  );
  assert.ok(
    threadRow !== null,
    `expected a thread row, got: ${withoutRouting}`
  );
  assert.doesNotMatch(
    threadRow[0],
    />0</,
    `an unobserved thread count must not render as 0, got: ${threadRow[0]}`
  );
});

test("the failure notice adds a reason only when the route observed one", () => {
  // The notice's primary sentence is deliberately outcome-free -- the refreshed
  // value the redirect lands on is the authoritative answer, so it must not
  // invent an outcome. But "must not invent" is not "must withhold a known
  // fact": a purge refused because the box was unticked, and one the Runtime
  // turned down because durable memory still cites the envelope, are different
  // situations with different next moves. Told only "could not be confirmed",
  // the first operator retries the identical request.
  //
  // So the notice grows one line *when a reason is carried*, and the reason
  // travels as a code in the redirect rather than as a message the Console
  // chose -- a code cannot reflect text into the page and cannot drift from
  // what the route meant by it.

  // The shared default is unchanged: every other mutation surface renders
  // exactly the notice it always did.
  const plain = renderToStaticMarkup(React.createElement(ControlFailureNotice));
  assert.match(
    plain,
    /could not be confirmed/u,
    "the shared sentence must still be there"
  );
  assert.doesNotMatch(
    plain,
    /data-control-refusal/u,
    "a mutation whose outcome is unknown must not name a cause"
  );
  assert.doesNotMatch(
    plain,
    /<span/u,
    "the shared notice must not grow a detail line it has no reason for"
  );

  for (const refusal of CONTROL_REFUSAL_REASONS) {
    const markup = renderToStaticMarkup(
      React.createElement(ControlFailureNotice, { refusal })
    );
    assert.match(
      markup,
      /could not be confirmed/u,
      `the shared sentence must survive for ${refusal}`
    );
    assert.match(
      markup,
      new RegExp(`data-control-refusal="${refusal}"`, "u"),
      `${refusal} must be recorded for assertions`
    );
    // The detail must say something, or the line is decoration.
    const detail = /<span class="[^"]*">([^<]+)</u.exec(markup)?.[1] ?? "";
    assert.ok(
      detail.length > 30,
      `${refusal} must render a real explanation, got: ${JSON.stringify(detail)}`
    );
  }

  // The two purge refusals must not read alike: the whole point is that
  // "tick the box" and "this cannot be done" are different instructions.
  const missing = renderToStaticMarkup(
    React.createElement(ControlFailureNotice, {
      refusal: "confirmation_missing"
    })
  );
  const refused = renderToStaticMarkup(
    React.createElement(ControlFailureNotice, { refusal: "runtime_refused" })
  );
  assert.notEqual(missing, refused);

  // An unrecognised code is treated as absent rather than rendered, so a link
  // or bookmark carrying something this build does not know still gets the
  // shared notice instead of an unexplained gap in it.
  const unknown = readControlRefusal("something_invented");
  assert.equal(unknown, undefined);
  assert.equal(readControlRefusal(undefined), undefined);
  assert.equal(readControlRefusal("runtime_refused"), "runtime_refused");
});
test("a purge redirect names the experience its tab reads, on success and on refusal", async () => {
  // Purge is the one irreversible action in the Console, and both of its
  // outcomes used to drop the operator onto a bare list.
  //
  // The redirect re-selects what was acted on by putting the identifier in the
  // query, and the key that carries it is chosen by which tab is being returned
  // to: the experiences tab reads `experienceId`, the records tab reads
  // `recordId`. Both outcomes spelled it `recordId` regardless -- and a purge's
  // identifier is an *experience* id, so the redirect landed on the right tab
  // carrying the right id under a key that tab ignores, and the drawer simply
  // did not open. Verified in the browser: `?tab=experiences&experienceId=`
  // opens the drawer and `?tab=experiences&recordId=` does not. On the refusal
  // path no identifier was sent at all, so nothing on the page said which row
  // had been refused.
  //
  // Driven through the rendered route with a stubbed fetch so both the success
  // and the refusal outcome are reachable without a Memory backend.
  await withMemoryRoute(async (requests) => {
    const form = (fields: Record<string, string>) => memoryPurgeRequest(fields);

    // Success: the Runtime accepted the purge, and the operator must come back
    // to the experience they just erased -- not to a list with no selection.
    requests.push({
      url: "http://127.0.0.1:4101/control/memory/experiences/exp-1/purge",
      method: "POST",
      body: ""
    } as never);
    globalThis.fetch = (async () =>
      Response.json({ erased: true })) as typeof fetch;

    const purged = await memoryRoute.POST(
      form({
        action: "purge",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        reason: "privacy_request",
        confirm: "purge"
      })
    );
    assert.equal(purged.status, 303);
    assert.equal(
      purged.headers.get("location"),
      "/memory?tab=experiences&experienceId=exp-1&workspaceId=SimulatorLife%2FAutoDev",
      "a completed purge must land back on the experience it erased"
    );

    // Refusal: no confirm. Must still name the experience.
    const refused = await memoryRoute.POST(
      form({
        action: "purge",
        experienceId: "exp-1",
        workspaceId: "SimulatorLife/AutoDev",
        reason: "privacy_request"
      })
    );
    assert.equal(refused.status, 303);
    const refusedLocation = refused.headers.get("location") ?? "";
    assert.match(
      refusedLocation,
      /[?&]experienceId=exp-1/,
      `a refused purge must re-select the experience, got: ${refusedLocation}`
    );
    assert.doesNotMatch(
      refusedLocation,
      /[?&]recordId=/,
      `a purge must never name its subject as a record, got: ${refusedLocation}`
    );

    // The control: a record action must keep using its own key, or "fix the
    // purge" could have been satisfied by always sending experienceId.
    const recordAction = await memoryRoute.POST(
      form({
        action: "verify",
        recordId: "rec-1",
        workspaceId: "SimulatorLife/AutoDev",
        reason: "Checked against the repository."
      })
    );
    const recordLocation = recordAction.headers.get("location") ?? "";
    assert.match(
      recordLocation,
      /[?&]recordId=rec-1/,
      `a record action must re-select its record, got: ${recordLocation}`
    );
    assert.match(
      recordLocation,
      /[?&]tab=records/,
      `a record action must return to the records tab, got: ${recordLocation}`
    );
    assert.doesNotMatch(recordLocation, /experienceId=/);
  });
});
test("one page rhythm: every view body stacks its sections through the shared class", () => {
  // The target state asks for "a small number of consistent page templates",
  // and this is the page template: a column of bordered panels at one spacing.
  // It was written out by hand twenty-one times, which made the one spacing
  // decision most likely to be adjusted across the product also the one with
  // twenty-one chances to miss a site -- and a page whose sections sit closer
  // together than its neighbour's reads as a different product rather than as
  // a bug.
  //
  // This guard previously matched only the exact literal `flex flex-col gap-6`,
  // on the stated ground that "the shared constant and any other gap value are
  // fine". That ground is the defect: the two pages that had bypassed the
  // template were not on gap-6, they were on `gap-8` (Memory) and `gap-5` (the
  // prompt detail page), so the guard passed them. "Any other gap value" is
  // exactly the thing that must not be allowed.
  //
  // The reliable signal in source is not the gap but the *hook*: `data-feature`
  // is the page body's stable identity and only `PageBody` renders it. So a view
  // that writes `data-feature` beside its own className has hand-rolled a page
  // body, whatever gap it chose. Inner stacks -- a panel's own `gap-1`, a filter
  // group's `gap-2` -- carry no hook and are untouched, which is why this does
  // not need to guess from the gap value.
  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const offenders: string[] = [];
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const name = relative.toString();
    const file = join(featuresDir, name);
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes('"data-feature"')) continue;
    if (source.includes("PageBody")) continue;
    offenders.push(`${name}: writes data-feature without PageBody`);
  }
  assert.deepEqual(
    offenders,
    [],
    `These views hand-roll a page body instead of using PageBody, so their sections do not share the product's page rhythm:\n${offenders.join("\n")}`
  );

  // And the rhythm itself, asserted on the constant every page resolves to, so
  // the value is pinned as well as the routing.
  assert.equal(
    PAGE_SECTION_STACK_CLASS,
    "flex flex-col gap-6",
    "the shared page rhythm is the value every page is measured against"
  );
});

test("the monospace family has one spelling per role", () => {
  // Almost every value the Console shows is a canonical name rather than prose,
  // and those want a different treatment from muted copy. The family was
  // unowned while the non-monospace treatments were consolidated, so it
  // accumulated its own drift: one caption existed as both
  // `font-mono text-xs text-fg-muted` and `text-xs text-fg-muted font-mono`
  // across three views each.
  //
  // Token order does not change which rule wins -- Tailwind resolves
  // same-property utilities by stylesheet order, not attribute order -- so
  // neither spelling was wrong. That is exactly why it was invisible: a diff
  // between two pages should not turn on which token someone typed first.
  // A string is a re-spelling when its tokens are *exactly* one of the three
  // named treatments, in any order. Comparing sets rather than substrings is
  // what keeps this honest: a genuinely different treatment -- a mono link that
  // also hovers, an id at `text-sm` rather than the default -- is not a
  // misspelling of one of the three and is left alone. A bare `font-mono` is
  // likewise exempt, because it restyles a `Chip` or supplies only the family
  // where the size comes from `TAG_SHAPE` or from the element itself.
  const CANONICAL = new Set(
    [MONO_ID_CLASS, MONO_VALUE_CLASS, MONO_META_CLASS].map((c) =>
      [...new Set(c.split(/\s+/))].sort().join(" ")
    )
  );
  const FEATURES = join(import.meta.dirname, "..", "src", "features");
  const offenders: string[] = [];
  for (const relative of readdirSync(FEATURES, { recursive: true })) {
    const name = relative.toString();
    const file = join(FEATURES, name);
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(
      /className:\s*(["'`])((?:[^"'`\\]|\\.)*)\1/g
    )) {
      const value = (m[2] ?? "").trim();
      if (value.includes("${")) continue; // composed at runtime
      if (!CANONICAL.has([...new Set(value.split(/\s+/))].sort().join(" ")))
        continue;
      offenders.push(`${name}: ${value}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These views re-spell a monospace treatment instead of using MONO_ID_CLASS, MONO_VALUE_CLASS or MONO_META_CLASS:\n${offenders.join("\n")}`
  );
});

test("a labelled-fact list is named only when its section does not already name it", () => {
  // `DetailGrid` carried a required `label`, and every site supplied one -- so
  // a `<dl>` inside a section whose `<h3>` already read "Role enablement" also
  // announced "Role enablement", and one under "Concurrency & Routing Limits"
  // announced "Runtime routing limits". Two problems in one: the region speaks
  // twice on the way in, and where the two wordings differed the page gives one
  // region two names, so a reader has to work out which is the heading.
  //
  // `label` is now optional, and the rule is that a grid inside a headed
  // section has none. The agent detail's configuration grid is the one place it
  // stands alone, directly under the page header with no section of its own, and
  // keeps its name.
  const detail = renderToStaticMarkup(
    React.createElement(AgentDetailView, { agent: CONFIGURED_AGENT })
  );
  const grids = Array.from(detail.matchAll(/<dl[^>]*>/g), (m) => m[0]);
  assert.ok(grids.length > 0, `expected labelled-fact lists, got: ${detail}`);

  const labelled = grids.filter((tag) => tag.includes("aria-label"));
  // Exactly one: the configuration grid, which stands alone under the page
  // header with no section of its own. Every other list sits inside a section
  // already named by its heading, so naming it again is the double announcement.
  assert.deepEqual(
    labelled.map((tag) => /aria-label="([^"]*)"/.exec(tag)?.[1]),
    ["Agent configuration"],
    `only the grid with no section heading of its own may be named, got: ${labelled.join(" | ")}`
  );

  // The routing grid sits under a heading that already names it, so the two
  // must not disagree: it is unnamed rather than renamed.
  const routing = detail.slice(
    detail.indexOf("Concurrency"),
    detail.indexOf("Concurrency") + 1200
  );
  assert.doesNotMatch(
    routing,
    /<dl[^>]*aria-label=/,
    `the routing grid repeats its section heading as a label, got: ${routing}`
  );
});

test("nothing truncates text it cannot give back", () => {
  // Truncation is not a display choice, it is a deletion: after `truncate`,
  // the first twenty pixels are the only copy of the value on the page unless
  // something else carries it. Ten elements did this and offered nothing --
  // the page `h1`, every skill name, the prompt path, the task and run ids,
  // the claim summary, the record scope.
  //
  // The rule is deliberately mechanical rather than a matter of taste, because
  // the failure is invisible in review: the markup looks right, the ellipsis
  // looks intentional, and only an operator on a narrow window discovers that
  // the identifier they needed is gone. Two shared components now own it
  // outright -- `Chip` titles itself, and `DataTable` titles a truncating cell
  // whose content is a plain string -- so this guard exists to catch the
  // one-off span in a feature view, which is exactly where the rest were.
  //
  // Scanned by brace-matching rather than by a shape regex: the props object
  // is arbitrary JavaScript, and a pattern that tries to describe it is either
  // ambiguous or rejected as unsafe.
  //
  // Two ways an element can cut its own text, and only the first used to be
  // caught. An explicit `truncate` is the obvious one. The other is a chip that
  // refuses to wrap (`whitespace-nowrap`) and caps its own width
  // (`max-w-full`): capped by its cell, it is cut by whatever contains it, and
  // because `inline-flex` blockifies to `flex` as a flex item, `text-overflow`
  // does not apply -- so the cut carries no ellipsis and no marker. That is how
  // `/github` shipped `workflow_dispatch` cut mid-identifier at 390px with
  // nothing on hover.
  //
  // And the second form is invisible to a scan of the element's own `className`,
  // because the utilities arrive through a shared shape constant: the chip's
  // className was `` `${TAG_SHAPE} border-border-strong …` ``, so reading the
  // literal found neither `max-w-full` nor `whitespace-nowrap`. That is the same
  // shape as the `NOT_OBSERVED_LABEL` defect, where composing the constant left
  // it decorative. So the shared shapes are resolved before matching.
  const roots = ["app", "src"].map((root) =>
    join(import.meta.dirname, "..", root)
  );
  // `StatusBadge` used to be exempt here, because its title was spread
  // conditionally (`{ title }`, not `title:`) and the scan reads the ordinary
  // form. It no longer needs to be: it titles itself with `title: title ?? …`,
  // so it is held by this rule like every other element. An exemption kept after
  // its reason has gone is a hole waiting for the next change to use it.
  // `Chips` titles from its own child, so it stays, and it is held by the
  // assertions on that component directly. `Tag` is deliberately *not* exempt --
  // it owns the shape and the title in the ordinary way, so it has to keep
  // passing this rule.
  const SHAPE_OWNERS = new Set([join("components", "tables", "Chips.ts")]);
  const offenders: string[] = [];
  // Every exported shape class list in the product, resolved before any call
  // site is read. Resolving them per module does not work: a call site writes
  // `${TAG_SHAPE}`, which is *imported* from another module, so the constant's
  // own file is the only place those utilities appear at all.
  const shapes = allSharedShapeClasses(roots);
  for (const root of roots) {
    for (const relative of readdirSync(root, { recursive: true })) {
      const file = join(root, relative.toString());
      if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
      if (SHAPE_OWNERS.has(relative.toString())) continue;
      for (const line of unrecoverableTruncations(
        readFileSync(file, "utf8"),
        shapes
      )) {
        offenders.push(`${relative}:${line}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These elements truncate their text with nothing to give it back. Add a title, or use Chip/DataTable, which do it for you:\n${offenders.join("\n")}`
  );
});

/**
 * Line numbers of every `createElement` in one module that can cut its own text
 * and carries no `title`.
 *
 * The element's own utilities are checked first, then whatever it composes in: a
 * `className` of `` `${TAG_SHAPE} …` `` writes none of the truncation itself, and
 * reading only the literal is how this defect shipped.
 */
function unrecoverableTruncations(
  source: string,
  shapes: ReadonlyMap<string, readonly string[]>
): readonly number[] {
  const found: number[] = [];
  // The calls currently open around the scan point, outermost first, with the
  // props object each one opened with. Truncation is recoverable from anywhere
  // above it, so an enclosing element that carries the title covers its
  // descendants: `StatusBadge` titles itself once and puts the ellipsis on a
  // child label, and reading only the child's own props calls that a
  // truncation with nothing to give it back. That exemption is the whole reason
  // this is a stack rather than a flat loop -- a per-file exemption is a hole
  // the next `truncate` in that file walks straight through.
  const open: { props: string; end: number }[] = [];
  for (let at = source.indexOf("React.createElement("); at !== -1;) {
    const propsStart = source.indexOf("{", at + "React.createElement(".length);
    const propsEnd = matchingBrace(source, propsStart);
    if (propsStart === -1 || propsEnd === -1) break;
    while (open.length > 0 && (open.at(-1)?.end ?? -1) < at) open.pop();
    const props = source.slice(propsStart, propsEnd + 1);
    const line = source.slice(0, at).split("\n").length;
    const written = writtenClassName(props);
    const composed = [...shapes]
      .filter(([name]) => written.includes(`\${${name}}`))
      .flatMap(([, values]) => values);
    const cuts =
      cutsItsOwnText(written) || composed.some((v) => cutsItsOwnText(v));
    const titled = /\btitle:/u.test(props);
    const titledAbove = open.some((frame) => /\btitle:/u.test(frame.props));
    if (cuts && !titled && !titledAbove) {
      found.push(line);
    }
    // Resume at the *next* call, not one character past this props object.
    // Advancing by `propsEnd + 1` treats that position as if it were a
    // `createElement(` offset, so every following props object was read from
    // the wrong origin and attributed to the wrong line -- which is how a real
    // unrecoverable truncation passed a guard that was scanning all along.
    open.push({
      props,
      end: matchingParen(source, at + "React.createElement(".length - 1)
    });
    at = source.indexOf("React.createElement(", propsEnd);
  }
  return found;
}

/**
 * Every exported `UPPER_SNAKE` shape constant across the product, mapped to the
 * class lists it can stand for.
 *
 * Resolution has to happen across modules: a call site writes `${TAG_SHAPE}`,
 * which is imported from another file, so the constant's own module is the only
 * place those utilities appear. Every declaration of a name is kept, because
 * quietly preferring one of them is how a composed shape slips through again.
 */
function allSharedShapeClasses(
  roots: readonly string[]
): ReadonlyMap<string, readonly string[]> {
  const shapes = new Map<string, string[]>();
  for (const root of roots) {
    for (const relative of readdirSync(root, { recursive: true })) {
      const file = join(root, relative.toString());
      if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
      // Comments are stripped first, because a shape constant is allowed to
      // explain itself between the `=` and the string -- and `TAG_SHAPE` does
      // exactly that, to say why `whitespace-nowrap` is spelled out beside a
      // shorthand that already implies it. Without this, the one constant whose
      // rationale most needs reading is the one the scan cannot resolve, and a
      // guard quietly stops covering every element that composes it in.
      const source = readFileSync(file, "utf8")
        .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
        .replaceAll(/\/\/[^\n]*/gu, " ");
      for (const [name, value] of sharedShapeClasses(source)) {
        const existing = shapes.get(name);
        if (existing === undefined) shapes.set(name, [value]);
        else existing.push(value);
      }
    }
  }
  return shapes;
}

/**
 * Whether a class list can cut its own text without a marker.
 *
 * `truncate` is the obvious form. The other is a chip that refuses to wrap and
 * caps its own width: capped by its cell, it is cut by whatever contains it, and
 * because `inline-flex` blockifies to `flex` as a flex item, `text-overflow`
 * does not apply to it. Either utility inside a longer utility name is not the
 * utility this is about, so both are matched on word boundaries.
 */
function cutsItsOwnText(classList: string): boolean {
  const bare = (utility: string): RegExp =>
    new RegExp(String.raw`(^|\s)${utility}(\s|$)`, "u");
  if (bare("truncate").test(classList)) return true;
  return (
    bare("whitespace-nowrap").test(classList) &&
    (bare("max-w-full").test(classList) ||
      bare("overflow-hidden").test(classList))
  );
}

/** The literal `className` value on one `createElement` props object. */
function writtenClassName(props: string): string {
  return props.match(/className:\s*(["'`])([\s\S]*?)\1/u)?.[2] ?? "";
}

/** Index of the `)` matching the `(` at `from`, or -1 within the bound. */
function matchingParen(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length && i < from + 4000; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The class list of every exported `UPPER_SNAKE` shape constant in one module,
 * so a guard reading a call site's `className` can see utilities that the site
 * composes in from a shared shape rather than writes itself.
 */
function sharedShapeClasses(
  source: string
): readonly (readonly [string, string])[] {
  const out: [string, string][] = [];
  for (const m of source.matchAll(
    /export const ([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]*)["'`]/gu
  )) {
    out.push([m[1] ?? "", m[2] ?? ""]);
  }
  return out;
}

/** Index of the `}` matching the `{` at `from`, or -1 within the bound. */
function matchingBrace(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length && i < from + 4000; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every `Name({` or `Name<T>({` call where `Name` is capitalised and not
 * preceded by a dot, member access, or another identifier character.
 *
 * Scanned rather than matched: a regex over this shape is either ambiguous or
 * flagged as unsafe, and the intent is simple enough to read directly.
 */
function findCapitalisedObjectCalls(
  source: string
): { name: string; braceAt: number }[] {
  const found: { name: string; braceAt: number }[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    if (!/[A-Z]/.test(ch)) continue;
    if (i > 0 && /[A-Za-z0-9_.$]/.test(source[i - 1] ?? "")) continue;
    let end = i;
    while (end < source.length && /[A-Za-z0-9]/.test(source[end] ?? "")) end++;
    const name = source.slice(i, end);
    let cursor = end;
    if (source[cursor] === "<") {
      cursor++;
      while (cursor < source.length && source[cursor] !== ">") cursor++;
      cursor++;
    }
    if (source[cursor] !== "(" || source[cursor + 1] !== "{") continue;
    found.push({ name, braceAt: cursor + 1 });
    i = end;
  }
  return found;
}

/**
 * Names this source imports. Read from the whole file rather than line by
 * line: most views import DataTable across several lines, and a line-based
 * scan silently missed exactly the case the caller below exists to catch.
 */
function importedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < source.length; i++) {
    if (!source.startsWith("import", i)) continue;
    if (i > 0 && /[A-Za-z0-9_$]/.test(source[i - 1] ?? "")) continue;
    const open = source.indexOf("{", i);
    if (open === -1) continue;
    const close = matchingBrace(source, open);
    if (close === -1) continue;
    for (const part of source.slice(open + 1, close).split(",")) {
      const name = part.trim().replace(/^type\s+/u, "");
      if (name.length > 0) names.add(name);
    }
    i = close;
  }
  return names;
}

test("no feature view calls a shared component as a plain function", () => {
  // Fourteen call sites rendered DataTable as `DataTable({...})` rather than as
  // an element. That returns the component's *output* rather than an element of
  // the component, so React never sees DataTable as a component at all: it
  // loses its identity in the tree, it cannot be targeted by an error boundary
  // or found in devtools, and the moment DataTable uses a hook the call
  // registers that hook against the *parent*, corrupting the parent's hook
  // order. It only worked because DataTable happens to be hook-free today.
  //
  // Only names the file actually imports are considered, so a capitalised
  // platform global such as URLSearchParams is not mistaken for a component.
  const featuresDir = join(import.meta.dirname, "..", "src", "features");
  const offenders: string[] = [];
  for (const relative of readdirSync(featuresDir, { recursive: true })) {
    const file = join(featuresDir, relative.toString());
    if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    const imported = importedNames(source);
    for (const call of findCapitalisedObjectCalls(source)) {
      if (!imported.has(call.name)) continue;
      const close = matchingBrace(source, call.braceAt);
      if (close === -1 || !source.slice(call.braceAt, close).includes("\n")) {
        continue;
      }
      offenders.push(`${relative.toString()}: ${call.name}({ ... })`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These views call a component as a plain function instead of rendering it:\n${offenders.join("\n")}`
  );
});

test("transition history is an ordered, named list rather than a stack of divs", () => {
  // A record's transitions are a sequence, so the structure has to say so.
  // Rendered as divs the list had no semantics at all: assistive technology
  // could not announce how many transitions there were, that they were
  // ordered, or what the group was called.
  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [],
      total: 0,
      listScope: memoryListScope(),
      selectedRecord: {
        id: "mem-history",
        kind: "procedural",
        status: "active",
        scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
        claim: "A claim.",
        validity: { state: "verified", evidence: [] },
        provenance: {
          experienceIds: [],
          evidence: [],
          createdBy: "operator",
          createdAt: "2026-10-01T00:00:00Z"
        },
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z"
      },
      history: {
        schema: "autodev-memory-history-v1",
        memory: {
          id: "mem-history",
          kind: "procedural",
          status: "invalidated",
          scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
          claim: "A claim.",
          validity: { state: "verified", evidence: [] },
          provenance: {
            experienceIds: [],
            evidence: [],
            createdBy: "operator",
            createdAt: "2026-10-01T00:00:00Z"
          },
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-03T00:00:00Z"
        },
        relatedMemories: [],
        // Real lifecycle events. This fixture was cast with `as never` and
        // written in the old `{ actor, timestamp, reason }` spelling, so it
        // exercised a row shape no producer has ever sent.
        transitions: [
          {
            id: "event-1",
            memoryId: "mem-history",
            action: "verified",
            actorId: "operator",
            occurredAt: "2026-10-02T00:00:00Z",
            fromStatus: "proposed",
            toStatus: "active",
            reasonCode: "verified_current_state",
            evidence: [],
            relatedMemoryIds: []
          },
          {
            id: "event-2",
            memoryId: "mem-history",
            action: "invalidated",
            actorId: "curator",
            occurredAt: "2026-10-03T00:00:00Z",
            fromStatus: "active",
            toStatus: "invalidated",
            reasonCode: "superseded",
            evidence: [],
            relatedMemoryIds: []
          }
        ]
      }
    })
  );

  assert.match(markup, /<ol[^>]*data-transition-history="observed"/);
  // The list is named by its own heading rather than announced anonymously.
  assert.match(markup, /id="memory-transition-history"/);
  assert.match(markup, /<ol[^>]*aria-labelledby="memory-transition-history"/);
  assert.equal(markup.match(/<li/g)?.length, 2);
  // Markers and indent are reset so the visual result is unchanged.
  assert.match(markup, /list-none p-0 m-0/);
  // The rows themselves were divs before; asserting their absence is the
  // direct regression check, rather than trying to describe the whole tree
  // with a lookahead.
  assert.doesNotMatch(
    markup,
    /<div class="flex items-center justify-between p-3 text-xs">/
  );
});

test("the Console stays server-rendered: no client directive, no hooks, no handlers", () => {
  // The target state forbids client JavaScript, and the Console honours it by
  // construction today: every component is a server component, every control is
  // a native form element, and every action is a normal navigation or a form
  // post. Measured in a browser against a production build, the ~100kB the page
  // downloads is entirely React and Next runtime -- no Console source reaches
  // the client bundle at all, so that claim is currently true rather than
  // aspirational.
  //
  // These three guards keep it true. Each is cheap, and each fails loudly the
  // moment a convenient "use client" is added to a leaf component, which is
  // how a fully server-rendered product usually starts shipping behaviour that
  // only works with scripting on.
  const roots = ["app", "src"];
  const files: string[] = [];
  const collect = (dir: string): void => {
    for (const relative of readdirSync(dir, { recursive: true })) {
      const file = join(dir, relative.toString());
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      files.push(file);
    }
  };
  for (const root of roots) {
    collect(join(import.meta.dirname, "..", root));
  }

  const clientDirective: string[] = [];
  const hooks: string[] = [];
  const handlers: string[] = [];
  // Hooks that are illegal in a server component. `use` is deliberately absent:
  // it is legal in RSC payloads and is not evidence of a client boundary.
  const hookPattern =
    /\buse(State|Effect|Reducer|Ref|Context|SyncExternalStore)\b/u;
  for (const file of files) {
    const relative = file.slice(import.meta.dirname.length);
    const source = readFileSync(file, "utf8");
    if (/^\s*(["'])use client\1/mu.test(source)) clientDirective.push(relative);
    if (hookPattern.test(source)) hooks.push(relative);
    // An event handler prop means the element only does something with
    // scripting on. DataTable's row click is the single allowed exception and
    // is asserted separately, because it is opt-in and off by default.
    if (/\bon(Change|Submit|Input|KeyDown|Blur|Focus):/u.test(source)) {
      handlers.push(relative);
    }
  }

  assert.deepEqual(clientDirective, [], "client directives found");
  assert.deepEqual(hooks, [], "React hooks found in a server component");
  assert.deepEqual(handlers, [], "inline event handlers found");
});

test("DataTable's row click is opt-in and off unless a caller asks for it", () => {
  // The one handler the Console accepts is a table row click, and it must stay
  // opt-in: rendering an onClick that does nothing would put a no-op handler on
  // every row of every table purely to support a feature nobody uses.
  const withoutClick = renderToStaticMarkup(
    React.createElement<DataTableProps<{ id: string }>>(DataTable, {
      data: [{ id: "a" }, { id: "b" }],
      columns: [
        {
          id: "id",
          header: "ID",
          weight: 100,
          cell: (r) => r.id
        }
      ],
      keyExtractor: (r) => r.id,
      emptyMessage: "No rows."
    })
  );
  assert.doesNotMatch(withoutClick, /onclick|onClick|cursor-pointer/);

  const withClick = renderToStaticMarkup(
    React.createElement<DataTableProps<{ id: string }>>(DataTable, {
      data: [{ id: "a" }],
      columns: [
        {
          id: "id",
          header: "ID",
          weight: 100,
          cell: (r) => r.id
        }
      ],
      keyExtractor: (r) => r.id,
      emptyMessage: "No rows.",
      onRowClick: () => undefined
    })
  );
  assert.match(withClick, /cursor-pointer/);
});

/**
 * The fields a browser would actually submit for one skill's assignment form.
 *
 * Derived from the markup rather than asserted against it directly, because the
 * bug this guards against is invisible to a test that only checks that the
 * inputs exist. An unchecked checkbox contributes nothing to a submission, so
 * the empty desired set -- which is exactly how a skill gets unassigned -- posts
 * zero `roles` fields. A route that demanded one occurrence of `roles` would
 * reject every unassignment while a test that counted inputs would call it
 * correct.
 *
 * The form is located by its `action` and then bounded by scanning out to the
 * surrounding `<form>` and `</form>`, because React emits attributes in its own
 * order: matching a fixed opening tag made this helper find nothing at all
 * while reporting an empty field set, which reads as "the form submitted
 * nothing" rather than as "the helper is broken".
 *
 * `disabled` is matched only outside the class attribute: every styled control
 * in the Console carries `disabled:` variants in its class list, so a naive
 * `/\bdisabled\b/` scan reports all of them as disabled.
 */
function submittedAssignmentFields(
  markup: string,
  skillName: string
): Map<string, string[]> {
  const actionAt = markup.indexOf(`action="/api/skills/${skillName}"`);
  assert.notEqual(actionAt, -1, `no assignment form for ${skillName}`);
  const formStart = markup.lastIndexOf("<form", actionAt);
  assert.notEqual(
    formStart,
    -1,
    `assignment form for ${skillName} has no start`
  );
  const formEnd = markup.indexOf("</form>", actionAt);
  assert.notEqual(formEnd, -1, `assignment form for ${skillName} never closes`);
  const body = markup.slice(formStart, formEnd);
  const fields = new Map<string, string[]>();
  for (const [, attributes] of body.matchAll(/<input\b([^>]*?)\/?>/gu)) {
    const withoutClass = (attributes ?? "").replaceAll(/\sclass="[^"]*"/gu, "");
    // A browser omits a disabled control from the submission entirely, so a
    // hidden input standing in for one would submit nothing.
    if (/(?:^|\s)disabled(?=[\s/>=]|$)/u.test(withoutClass)) continue;
    const name = /\sname="([^"]*)"/u.exec(withoutClass)?.[1];
    if (name === undefined || name === "") continue;
    const type = /\stype="([^"]*)"/u.exec(withoutClass)?.[1] ?? "text";
    // An unchecked checkbox is not a successful control and submits nothing.
    if (type === "checkbox" && !/\schecked(?=[\s/>=]|$)/u.test(withoutClass)) {
      continue;
    }
    const fieldValue =
      /\svalue="([^"]*)"/u.exec(withoutClass)?.[1] ??
      (type === "checkbox" ? "on" : "");
    fields.set(name, [...(fields.get(name) ?? []), fieldValue]);
  }
  return fields;
}

const SKILL_ASSIGNMENT_SKILL = {
  name: "release-checklist",
  description: "Steps for cutting a release.",
  path: ".rulesync/skills/release-checklist/SKILL.md"
};

test("a skill assignment form posts the whole desired set, and an empty one clears it", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [SKILL_ASSIGNMENT_SKILL],
      eligibility: [{ skill: "release-checklist", roles: ["worker"] }],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["orchestrator", "worker"],
      executionContractRevision: "d".repeat(64)
    })
  );

  const assigned = submittedAssignmentFields(markup, "release-checklist");
  assert.deepEqual(assigned.get("expectedRevision"), ["d".repeat(64)]);
  assert.deepEqual(
    assigned.get("roles"),
    ["worker"],
    "only the checked role travels; the unchecked one is not in the submission"
  );

  const cleared = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [SKILL_ASSIGNMENT_SKILL],
      eligibility: [{ skill: "release-checklist", roles: [] }],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["orchestrator", "worker"],
      executionContractRevision: "d".repeat(64)
    })
  );
  // Unassigning is "check nothing", so the submission legitimately carries no
  // `roles` at all. A route that required the field to be present would make the
  // one operation that fixes an unreachable skill impossible to express.
  assert.deepEqual(
    [...submittedAssignmentFields(cleared, "release-checklist").keys()],
    ["expectedRevision"]
  );
  assert.match(
    cleared,
    /Unassigned — no agent role can invoke this skill/,
    "the operator has to be told why the skill is dead, not left to infer it"
  );
});

test("an unassigned skill is fixable from the page that reports it as unassigned", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [SKILL_ASSIGNMENT_SKILL],
      eligibility: [{ skill: "release-checklist", roles: [] }],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["orchestrator"],
      executionContractRevision: "e".repeat(64)
    })
  );
  assert.match(markup, /Not assigned/);
  assert.match(
    markup,
    /action="\/api\/skills\/release-checklist"/,
    "the page that says a skill is unreachable has to carry the control that assigns it"
  );
  // Every assignable role is offered, not just the ones already checked: an
  // unassigned skill has none checked, so an unchecked-only list would leave the
  // operator nothing to do.
  assert.match(markup, /data-skill-role-option="orchestrator"/);
});

test("no execution contract means no assignment form and a reason, not a broken control", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [SKILL_ASSIGNMENT_SKILL],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["orchestrator"],
      executionContractRevision: null
    })
  );
  assert.doesNotMatch(
    markup,
    /action="\/api\/skills\//,
    "a form with no revision would post an empty expectation and be refused every time"
  );
  assert.match(markup, /data-skill-assignment-revision="none"/);
  assert.match(markup, /No execution contract was found/);
});

test("a refused assignment says what happened and claims nothing was written", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [SKILL_ASSIGNMENT_SKILL],
      eligibility: [{ skill: "release-checklist", roles: [] }],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["orchestrator"],
      executionContractRevision: "f".repeat(64),
      saveOutcome: "conflict"
    })
  );
  assert.match(markup, /data-save-outcome="conflict"/);
  assert.match(markup, /so nothing was written/);
  assert.match(
    markup,
    /The execution contract changed after this page was loaded/
  );
});

test("patchSkillRoles PATCHes the skill resource and validates the assignment it reports", async () => {
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "server-only"
  };
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const assigned = await patchSkillRoles(
    "release-checklist",
    { expectedRevision: "1".repeat(64), roles: ["worker"] },
    config,
    {
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body === undefined ? null : JSON.parse(String(init.body))
        });
        return Response.json({
          schema: "autodev-control-skill-assignment-v1",
          skill: "release-checklist",
          roles: ["worker"],
          revision: "2".repeat(64)
        });
      }
    }
  );
  assert.equal(assigned.kind, "ok");
  assert.deepEqual(calls, [
    {
      url: "http://127.0.0.1:4101/control/skills/release-checklist",
      method: "PATCH",
      body: { expectedRevision: "1".repeat(64), roles: ["worker"] }
    }
  ]);

  // A response whose roles do not match what was asked for means the write did
  // not stick. Accepting it would render the requested set as the new truth.
  const lying = await patchSkillRoles(
    "release-checklist",
    { expectedRevision: "1".repeat(64), roles: ["worker"] },
    config,
    {
      fetchImpl: async () =>
        Response.json({
          schema: "autodev-control-skill-assignment-v1",
          skill: "release-checklist",
          roles: [],
          revision: "not-a-digest"
        })
    }
  );
  assert.equal(lying.kind, "invalid-response");
  if (lying.kind === "invalid-response") {
    assert.equal(
      lying.code,
      "autodev_control_api_invalid_skill_assignment_response"
    );
  }
});

test("the permissions page answers which tools a role may call, not only which servers it reaches", () => {
  const { policy, roleMatrices } = permissionsFromControlApi({
    schema: "autodev-control-permissions-v1",
    source: "test",
    readOnly: true,
    policy: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
      networkAccess: true,
      webSearch: true,
      defaultToolsApprovalMode: "approve"
    },
    rolePermissions: {
      worker: {
        readOnly: false,
        sandbox: "workspace-write",
        networkAccess: true,
        approvals: "never",
        mcp: ["lsp"],
        mcpTools: { lsp: ["lsp_find_symbol", "lsp_goto_definition"] },
        skills: []
      },
      validator: {
        readOnly: true,
        sandbox: "read-only",
        networkAccess: true,
        approvals: "never",
        // Reaches an MCP server with no tool grants. That is a real state, and
        // it must not read the same as a role whose grants were never reported.
        mcp: ["lsp"],
        mcpTools: { lsp: [] },
        skills: []
      },
      orchestrator: {
        readOnly: false,
        sandbox: "workspace-write",
        networkAccess: true,
        approvals: "never",
        mcp: [],
        mcpTools: {},
        skills: []
      }
    }
  });

  const markup = renderToStaticMarkup(
    React.createElement(PermissionsView, { policy, roleMatrices })
  );

  // The server list alone used to be the whole answer, and a role named
  // against `lsp` read as a role that may call all of it.
  assert.match(markup, /Role Tool Exposure/u);
  assert.match(markup, /data-tool-role="worker"/u);
  assert.match(markup, /lsp_find_symbol/u);
  assert.match(markup, /lsp_goto_definition/u);
  // A server named with an empty grant is shown as such, not omitted.
  assert.match(markup, /No tools on this server/u);
  // A role with no grants at all is absent from the section rather than listed
  // with nothing, and the section says so when no role has one.
  assert.doesNotMatch(markup, /data-tool-role="orchestrator"/u);
});

test("a permissions page where no role has a tool grant says so instead of rendering an empty list", () => {
  const { policy, roleMatrices } = permissionsFromControlApi({
    schema: "autodev-control-permissions-v1",
    source: "test",
    readOnly: true,
    policy: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
      networkAccess: true,
      webSearch: true,
      defaultToolsApprovalMode: "approve"
    },
    rolePermissions: {
      default: {
        readOnly: false,
        sandbox: "workspace-write",
        networkAccess: true,
        approvals: "never",
        mcp: ["lsp"],
        mcpTools: {},
        skills: []
      }
    }
  });

  const markup = renderToStaticMarkup(
    React.createElement(PermissionsView, { policy, roleMatrices })
  );
  assert.match(markup, /No role has an MCP tool grant recorded/u);
  // Reaching a server is still reported: this role does reach `lsp`, and the
  // page must not hide that in order to be consistent about the tools.
  assert.match(markup, /lsp/u);
});

test("a permissions payload whose tool grants are unreadable fails closed", async () => {
  const config = {
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "server-only"
  };
  const payload = {
    schema: "autodev-control-permissions-v1",
    source: "test",
    readOnly: true,
    policy: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
      networkAccess: true,
      webSearch: true,
      defaultToolsApprovalMode: "approve"
    },
    rolePermissions: {
      default: {
        readOnly: false,
        sandbox: "workspace-write",
        networkAccess: true,
        approvals: "never",
        mcp: ["lsp"],
        mcpTools: {},
        skills: []
      }
    }
  };
  const rolePermissions = payload.rolePermissions.default;

  const ok = await fetchPermissions(config, {
    fetchImpl: async () => Response.json(payload)
  });
  assert.equal(ok.kind, "ok");

  for (const mcpTools of [
    undefined,
    null,
    "lsp",
    { lsp: "find" },
    { lsp: [7] }
  ]) {
    const malformed = await fetchPermissions(config, {
      fetchImpl: async () =>
        Response.json({
          ...payload,
          rolePermissions: { default: { ...rolePermissions, mcpTools } }
        })
    });
    assert.equal(
      malformed.kind,
      "invalid-response",
      `mcpTools ${JSON.stringify(mcpTools)} must not be accepted`
    );
  }
});

test("an invalid MCP source names the declaration it could not apply, like every other RuleSync source", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpsView, {
      servers: [],
      sourceValidity: false,
      validationIssues: [
        {
          location: "codexcli.mcpServers.bad",
          message:
            'The override for "bad" under "codexcli" is not a usable MCP server declaration.'
        }
      ]
    })
  );
  // An empty server list is otherwise indistinguishable from "this file declares
  // none", and the stat card beside it said exactly that.
  assert.match(markup, /data-testid="mcp-validation-issues"/u);
  assert.match(markup, /data-validation-issue-count="1"/);
  assert.match(markup, /data-validation-issue="codexcli\.mcpServers\.bad"/u);
  assert.match(markup, /is not a usable MCP server declaration/u);
  // The heading names the source, so a page with both a hook and an MCP problem
  // does not show two identical "invalid" panels.
  assert.match(markup, /MCP source invalid — 1 problem</u);
});

test("a valid MCP source renders no validation panel", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpsView, {
      servers: [],
      sourceValidity: true,
      validationIssues: []
    })
  );
  assert.doesNotMatch(markup, /data-testid="mcp-validation-issues"/u);
});

test("an invalid command source names the file it could not read, like every other RuleSync source", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: [],
      commandSourceValidity: false,
      validationIssues: [
        {
          location: ".rulesync/commands/dry.md",
          message:
            '".rulesync/commands/dry.md" is a symbolic link, and canonical commands are read from the repository itself.'
        }
      ]
    })
  );
  // An empty command list is otherwise indistinguishable from "this directory
  // declares no commands", and the stat card beside it said exactly that.
  assert.match(markup, /data-testid="command-validation-issues"/u);
  assert.match(markup, /data-validation-issue-count="1"/);
  assert.match(
    markup,
    /data-validation-issue="\.rulesync\/commands\/dry\.md"/u
  );
  assert.match(markup, /is a symbolic link/u);
  // The heading names the source, so a page with both a command and an MCP
  // problem does not show two identical "invalid" panels.
  assert.match(markup, /Command catalog invalid — 1 problem</u);
});

test("a valid command source renders no validation panel", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: [],
      commandSourceValidity: true,
      validationIssues: []
    })
  );
  assert.doesNotMatch(markup, /data-testid="command-validation-issues"/u);
});

test("an invalid skill catalog names the file it could not apply, like every other RuleSync source", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: false,
      validationIssues: [
        {
          location: ".rulesync/skills/release-checklist/SKILL.md",
          message:
            'The skill frontmatter declares "Release", but the directory is "release-checklist". A skill must be addressable by the name it declares.'
        }
      ],
      assignmentRoles: ["orchestrator"],
      executionContractRevision: "c".repeat(64)
    })
  );
  // A skill dropped from the catalog is a skill no agent can be assigned, and
  // the count beside the panel reported the survivors as if it were the catalog.
  assert.match(markup, /data-testid="skill-catalog-validation-issues"/u);
  assert.match(markup, /data-validation-issue-count="1"/);
  assert.match(
    markup,
    /data-validation-issue="\.rulesync\/skills\/release-checklist\/SKILL\.md"/u
  );
  assert.match(markup, /addressable by the name it declares/u);
  assert.match(markup, /Skill catalog invalid — 1 problem</u);
});

test("a valid skill catalog renders no validation panel", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["orchestrator"],
      executionContractRevision: "c".repeat(64)
    })
  );
  assert.doesNotMatch(markup, /data-testid="skill-catalog-validation-issues"/u);
});
