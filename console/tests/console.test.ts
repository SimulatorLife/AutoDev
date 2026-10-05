import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  type ExperienceEnvelope,
  type GithubWorkflowDefinition,
  LOCAL_CONTROL_API_ACTOR,
  type McpServerResource,
  type MemoryRecord,
  type MemorySessionOutcomeCohortPage,
  type ToolCatalogItem,
  type UsageMetricsData
} from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as promptMutationRoute from "../app/api/prompts/[name]/route.ts";
import * as providerRoleRoute from "../app/api/providers/[provider]/roles/[role]/route.ts";
import EvaluationsPage from "../app/evaluations/page.ts";
import MemoryPage from "../app/memory/page.ts";
import {
  AgentDetailView,
  AgentsView,
  AppNav,
  AppShell,
  Breadcrumbs,
  ConsoleForm,
  ConsoleLink,
  DataTable,
  EvaluationsView,
  formatCount,
  formatLatency,
  formatTokenCount,
  GithubView,
  HooksView,
  LinkPendingIndicator,
  MCP_DETAIL_TABS,
  McpDetailView,
  McpsView,
  MemoryCohortsView,
  MemoryExperiencesView,
  memoryHref,
  MemoryPortalCard,
  MemoryRecordsView,
  MemorySummary,
  type MemorySummaryCounts,
  MemorySummaryStream,
  type MemoryUrlScope,
  MemoryView,
  observeSummaryCounts,
  PromptDetailView,
  PromptsView,
  resolveActiveTabId,
  SkillsView,
  StatCard,
  StatusBadge,
  tabHref,
  TabNav,
  ToolsView,
  UsageView,
  WorkspacesView
} from "../src/index.ts";
import {
  canonicalNavPath,
  canonicalSectionFromPath
} from "../src/lib/routes.ts";
import {
  CONTROL_API_PATHS,
  fetchAgentDetail,
  fetchControlApi,
  fetchEvaluations,
  fetchGithubWorkflows,
  fetchMemoryRecords,
  fetchPromptDetail,
  fetchPrompts,
  fetchProviders,
  fetchSkills,
  fetchTools,
  readControlApiConfig
} from "../src/lib/server/control-api.ts";
import { readMemoryPortalConfig } from "../src/lib/server/memory-portal.ts";
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

/** Props source of every `React.createElement("a", { ... })` in `source`. */
function rawAnchorProps(source: string): string[] {
  const props: string[] = [];
  for (const match of source.matchAll(/createElement\(\s*"a",\s*\{/gu)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let end = start;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}" && --depth === 0) break;
    }
    props.push(source.slice(start, end + 1));
  }
  return props;
}

/** Opening `<a>` tag carrying `href`, independent of attribute order. */
function anchorTagFor(markup: string, href: string): string | undefined {
  return Array.from(markup.matchAll(/<a\b[^>]*>/gu), ([tag]) => tag).find(
    (tag) => tag.includes(`href="${href}"`)
  );
}

const MEMORY_PAGE_ENV_KEYS = [
  "HOME",
  "CODEX_HOME",
  "AUTODEV_CONTROL_API_TOKEN",
  "AUTODEV_CONTROL_API_BASE_URL",
  "AUTODEV_OPENLIT_SECRET_FILE",
  "AUTODEV_OPENLIT_UI_URL",
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

test("navigation chrome switches its active item without CSS transitions", () => {
  // An animated active-state change lags the page it names and repaints the
  // sidebar or tab bar for several frames after every navigation.
  const nav = renderToStaticMarkup(
    React.createElement(AppNav, { activeSection: "Agents" })
  );
  const tabs = renderToStaticMarkup(
    React.createElement(TabNav, {
      navLabel: "Sections",
      basePath: "/mcps/example",
      tabs: [
        { id: "configuration", label: "Configuration" },
        { id: "tools", label: "Tools" }
      ],
      activeTabId: "configuration"
    })
  );
  for (const markup of [nav, tabs]) {
    for (const [anchor] of markup.matchAll(/<a\b[^>]*>/gu)) {
      assert.doesNotMatch(anchor, /\btransition/u, anchor);
    }
  }
});

test("AppNav renders Configure/Observe/Operate groups with canonical membership, order, and URL links", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AppNav, { activeSection: "Agents" })
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
  // Only the active section is marked as the current page.
  assert.deepEqual(
    Array.from(
      markup.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/gu),
      ([tag]) => /data-nav-item="([^"]+)"/u.exec(tag)?.[1]
    ),
    ["agents"]
  );
  assert.equal(markup.includes("<button"), false);
  assert.equal(markup.includes("Projects"), false);
  assert.equal(markup.includes("Organizations"), false);
  assert.equal(markup.includes("Environments"), false);
  assert.equal(markup.includes("Rule Engine"), false);
  assert.equal(markup.includes("OpenGround"), false);
});

test("AppNav marks no item current outside a canonical section route", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AppNav, { activeSection: null })
  );
  assert.equal(markup.includes('aria-current="page"'), false);
  for (const section of CANONICAL_NAVIGATION) {
    assert.ok(markup.includes(`href="/${section.toLowerCase()}"`));
  }
});

test("AppShell owns persistent navigation chrome around the routed page body", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      AppShell,
      null,
      React.createElement("p", { "data-page-body": "true" }, "body")
    )
  );
  assert.equal(
    markup.match(/aria-label="AutoDev Console Navigation"/gu)?.length,
    1
  );
  assert.match(markup, /<header\b/u);
  assert.match(markup, /<main\b[^>]*>[\s\S]*data-page-body="true"/u);
  // Without a routed pathname there is no section to claim as current.
  assert.equal(markup.includes('aria-current="page"'), false);
});

const CONSOLE_ROOT = join(import.meta.dirname, "..");

function consoleSourceFiles(directory: string): string[] {
  return readdirSync(join(CONSOLE_ROOT, directory), { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/u.test(file))
    .map((file) => join(directory, file));
}

test("the root layout is the single owner of the Console shell", () => {
  const layout = readFileSync(join(CONSOLE_ROOT, "app/layout.tsx"), "utf8");
  assert.match(layout, /React\.createElement\(AppShell, null, children\)/u);
  for (const file of consoleSourceFiles("app")) {
    if (file === join("app", "layout.tsx")) continue;
    const source = readFileSync(join(CONSOLE_ROOT, file), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:AppShell|AppNav|ActiveAppNav|ConsolePageShell)\b/u,
      `${file} must render page content only; the root layout owns the shell`
    );
  }
});

test("routes declare no loading.tsx boundaries", () => {
  // Next.js 15.5 reuses a same-path prefetch entry ("aliased" prefetch) for
  // search-param navigations whenever the prefetched segment data carries a
  // route loading component, and that path intermittently never commits the
  // navigation (tab, filter, and record-selection clicks silently stall).
  // Navigation feedback therefore comes from ConsoleLink's pending indicator
  // instead of route loading boundaries.
  for (const file of consoleSourceFiles("app")) {
    assert.doesNotMatch(
      file,
      /(?:^|\/)loading\.tsx?$/u,
      `${file} would route search-param navigations through aliased prefetches`
    );
  }
});

test("internal Console navigation goes through ConsoleLink and ConsoleForm", () => {
  const navigationPrimitives = new Map([
    [join("src", "components", "navigation", "ConsoleLink.ts"), "next/link"],
    [join("src", "components", "navigation", "ConsoleForm.ts"), "next/form"]
  ]);
  for (const file of [
    ...consoleSourceFiles("src"),
    ...consoleSourceFiles("app")
  ]) {
    const source = readFileSync(join(CONSOLE_ROOT, file), "utf8");
    // A raw anchor is only for an external destination, which always opens
    // in a new browsing context; anything else is internal and must use
    // ConsoleLink, whether its href is a literal or computed.
    for (const anchorProps of rawAnchorProps(source)) {
      assert.match(
        anchorProps,
        /\btarget:\s*"_blank"/u,
        `${file} must render internal links with ConsoleLink: ${anchorProps}`
      );
    }
    assert.doesNotMatch(
      source,
      /createElement\(\s*"form",\s*\{[^}]*\bmethod:\s*"get"/iu,
      `${file} must submit GET filters with ConsoleForm`
    );
    for (const [primitive, nextModule] of navigationPrimitives) {
      if (file === primitive) continue;
      assert.equal(
        source.includes(`from "${nextModule}`),
        false,
        `${file} must use ${primitive} instead of importing ${nextModule}`
      );
    }
  }
});

test("ConsoleLink renders a real anchor with no pending indicator at rest", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      ConsoleLink,
      {
        href: "/mcps/playwright",
        className: "font-mono",
        "data-probe": "link"
      },
      "playwright"
    )
  );
  assert.match(
    markup,
    /^<a\b[^>]*href="\/mcps\/playwright"[^>]*>playwright<\/a>$/u
  );
  assert.match(markup, /data-probe="link"/u);
  assert.equal(markup.includes("data-navigation-pending"), false);
  assert.equal(
    renderToStaticMarkup(React.createElement(LinkPendingIndicator)),
    ""
  );
});

test("ConsoleForm renders a native GET form that is not busy at rest", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      ConsoleForm,
      { defaultsKey: "range=24H", action: "/usage", "data-probe": "filters" },
      React.createElement("input", { name: "range", defaultValue: "24H" })
    )
  );
  assert.match(markup, /^<form\b[^>]*action="\/usage"/u);
  assert.match(markup, /data-probe="filters"/u);
  assert.doesNotMatch(
    markup,
    /method="post"|aria-busy|data-navigation-pending/iu
  );
});

test("the Console ships an app icon so documents never request a missing favicon", () => {
  // Without one, every document load requested /favicon.ico and received an
  // uncacheable server-rendered 404 page.
  const icon = readFileSync(join(CONSOLE_ROOT, "app/icon.svg"), "utf8");
  assert.match(icon, /^<svg\b[^>]*viewBox="0 0 32 32"/u);
});

test("the Console root redirects to Agents before any rendering", () => {
  const config = readFileSync(join(CONSOLE_ROOT, "next.config.ts"), "utf8");
  assert.match(
    config,
    /\{ source: "\/", destination: "\/agents", permanent: false \}/u
  );
  assert.equal(
    consoleSourceFiles("app").includes(join("app", "page.tsx")),
    false,
    "a root page would server-render the shell only to redirect"
  );
});

test("router cache reuse is bounded to intent prefetches for at most 30 seconds", () => {
  // Ordinary navigations always re-read live runtime state; only pages
  // ConsoleLink fully prefetched on hover/focus/touch may be reused, for the
  // shortest window Next.js allows.
  const config = readFileSync(join(CONSOLE_ROOT, "next.config.ts"), "utf8");
  assert.match(config, /staleTimes: \{ dynamic: 0, static: 30 \}/u);
});

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
    /focus-visible:outline(?!-none)/.test(brandTag),
    "AppNav brand link must define a visible focus-visible outline"
  );

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

  // Ancestor item: a real <a href="/mcps"> anchor rendered by ConsoleLink.
  assert.match(navMarkup, /<a\b[^>]*href="\/mcps"[^>]*>MCPs<\/a>/);
  // Ancestor link must expose a visible keyboard focus state.
  assert.match(
    anchorTagFor(navMarkup, "/mcps") ?? "",
    /class="[^"]*focus-visible:outline/
  );

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
  // no aria-current, no placeholder href).
  assert.match(navMarkup, /<span class="[^"]*">Workspace hub<\/span>/);
  assert.equal(navMarkup.includes("Workspace hub</a>"), false);
  assert.doesNotMatch(navMarkup, /<span[^>]*Workspace hub[^>]*aria-current/);
  assert.match(navMarkup, /<span class="[^"]*">Unlinked group<\/span>/);
  assert.equal(navMarkup.includes("Unlinked group</a>"), false);
  assert.equal(navMarkup.includes('href=""'), false);

  // The middle ancestor still renders as a real <a href> link.
  assert.match(navMarkup, /<a\b[^>]*href="\/mcps"[^>]*>MCPs<\/a>/);

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
  assert.match(markup, /<a\b[^>]*href="\/prompts"[^>]*>Prompts<\/a>/);
  assert.match(markup, /<span[^>]*aria-current="page"[^>]*>dry<\/span>/);
  // Only one separator between the two items.
  const separatorMatches = markup.match(/aria-hidden="true"/g) ?? [];
  assert.equal(separatorMatches.length, 1);
});

test("StatusBadge renders valid variants", () => {
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
    // The shape and dot come from the shared utility, so each badge sends
    // only its variant colors and no extra dot element.
    assert.match(
      markup,
      /^<span class="status-badge [^"]+"[^>]*>[^<]+<\/span>$/u
    );
  }
  assert.match(
    readFileSync(join(CONSOLE_ROOT, "app/globals.css"), "utf8"),
    /@utility status-badge \{[^}]*&::before \{/u
  );
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
  const markup = renderToStaticMarkup(
    React.createElement(AgentDetailView, { agent: CONFIGURED_AGENT })
  );

  assert.match(markup, /data-feature="agent-detail"/);
  assert.match(markup, /orchestrator/);
  assert.match(markup, /data-status="not-observed"/);
  assert.equal(markup.includes("Runtime healthy"), false);
  assert.equal(markup.includes("Converged"), false);
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
  assert.match(breadcrumbMarkup, /<a\b[^>]*href="\/agents"[^>]*>Agents<\/a>/);
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
      commandSourceValidity: null
    })
  );
  assert.match(missing, /data-prompt-command-source="not-observed"/);
  assert.match(missing, /RuleSync `.rulesync\/commands\/` was not observed/);
  assert.match(missing, /Not observed/);
});

test("Prompt detail renders canonical text and reports an actually empty source", () => {
  const source = "# /dry\n\nUse a dry run.";
  const prompt = promptDocumentFromControlApi({
    schema: "autodev-control-prompt-detail-v2",
    name: "dry",
    type: "command",
    source: ".rulesync/commands/dry.md",
    content: source,
    revision: "a".repeat(64)
  });
  const markup = renderToStaticMarkup(
    React.createElement(PromptDetailView, { prompt })
  );
  assert.match(markup, /Use a dry run\./);
  assert.match(markup, /\.rulesync\/commands\/dry\.md/);
  assert.match(markup, /data-prompt-editor="canonical"/);
  assert.match(markup, /action="\/api\/prompts\/dry"/);
  assert.match(markup, /name="expectedRevision" value="a{64}"/);
  assert.match(markup, /Save &amp; Apply/);

  const roleMarkup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      prompt: {
        name: "orchestrator",
        kind: "role",
        path: "agents/prompts/roles/orchestrator.md",
        content: "# Role prompt",
        revision: "d".repeat(64)
      }
    })
  );
  assert.match(roleMarkup, /data-prompt-editor="read-only"/);
  assert.equal(roleMarkup.includes("/api/prompts/orchestrator"), false);

  const emptyMarkup = renderToStaticMarkup(
    React.createElement(PromptDetailView, {
      prompt: { ...prompt, content: "" }
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
      prompt: {
        name: "orchestrator",
        kind: "role",
        path: "agents/prompts/roles/orchestrator.md",
        content: "# Orchestrator System Prompt\nYou are an orchestrator.",
        revision: "c".repeat(64)
      }
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
  assert.match(breadcrumbMarkup, /<a\b[^>]*href="\/prompts"[^>]*>Prompts<\/a>/);
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
    DataTable<TestRow>({
      data,
      columns: [
        { id: "id", header: "ID", cell: (r: TestRow) => r.id },
        { id: "name", header: "Name", cell: (r: TestRow) => r.name, wrap: true }
      ],
      keyExtractor: (r: TestRow) => r.id
    })
  );
  assert.ok(markup.includes("Alpha"));
  assert.ok(markup.includes("Beta"));
  assert.ok(markup.includes("<table"));
  // Row and cell styling is declared once on the body, not per row or cell;
  // a wrapping column marks only its cells.
  assert.match(markup, /<tbody class="[^"]*\[&amp;&gt;tr&gt;td\]:px-4/u);
  assert.match(markup, /\[&amp;&gt;tr&gt;td\[data-wrap\]\]:whitespace-normal/u);
  assert.match(markup, /<td>1<\/td><td data-wrap="">Alpha<\/td>/u);
  assert.doesNotMatch(markup, /<t[dr] class=/u);
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
      schema: "autodev-control-providers-v1",
      providers: [],
      disabledOrchestratorProviders: [],
      disabledSubagentProviders: []
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
 * Each view must report `Not observed` / `Unknown` / `Unknown` rather than
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

  assert.ok(markup.includes('class="font-semibold text-chart-1">3</span>'));
  assert.ok(markup.includes('class="font-semibold text-chart-2">5</span>'));
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
  // ConsoleForm submits GET filters as a soft navigation; the rendered form
  // keeps the native default GET method (no explicit POST) for no-JS use.
  assert.match(markup, /<form\b[^>]*action="\/usage"/);
  assert.doesNotMatch(markup, /method="post"/iu);
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
      sourceValidity: true
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
  assert.match(toolsMarkup, />Unknown</);
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
      exposedRoles: ["docs-researcher"]
    },
    {
      name: "get-library-docs",
      source: "mcp",
      server: "context7",
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
  assert.match(toolsMarkup, />Unknown</);
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
      sourceValidity: true
    })
  );
  assert.match(markup, /Configured roles/);
  assert.match(markup, /No roles assigned/);
});

test("McpsView distinguishes invalid canonical configuration from an empty list", () => {
  const markup = renderToStaticMarkup(
    React.createElement(McpsView, { servers: [], sourceValidity: false })
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
      sourceValidity: true
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
      sourceValidity: true
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
      sourceValidity: null
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

test("ToolsView falls back to 'Unknown' when status is missing", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      tools: [
        {
          name: "read_file",
          source: "native",
          exposedRoles: ["orchestrator"]
          // status intentionally omitted
        }
      ]
    })
  );
  assert.equal(markup.includes(">ready<"), false);
  assert.match(markup, /Unknown/);
  assert.match(markup, /data-tools-coverage="partial"/);
  assert.match(
    markup,
    /Other tools, runtime availability, and historical use are not observed/
  );
  assert.doesNotMatch(markup, /Universal/);
});

test("ToolsView keeps an unavailable capability source unknown instead of zero", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, { tools: [], coverage: "unknown" })
  );
  assert.match(markup, /Known Declarations/);
  assert.match(markup, />Unknown</);
  assert.match(markup, /execution-contract role inventory is not observed/);
  assert.doesNotMatch(markup, /Known Declarations[\s\S]*?>0</);
});

test("ToolsView preserves explicit 'ready'/'unavailable' status values", () => {
  const readyMarkup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      tools: [
        {
          name: "exec_command",
          source: "native",
          exposedRoles: ["orchestrator"],
          status: "ready"
        }
      ]
    })
  );
  assert.match(readyMarkup, /data-status="ready"/);

  const unavailableMarkup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      tools: [
        {
          name: "exec_command",
          source: "native",
          exposedRoles: ["orchestrator"],
          status: "unavailable"
        }
      ]
    })
  );
  assert.match(unavailableMarkup, /data-status="unavailable"/);
});

test("readMemoryPortalConfig defaults to the local OpenLIT UI base URL", () => {
  assert.deepEqual(readMemoryPortalConfig({}), {
    href: "http://127.0.0.1:3000/memory"
  });
});

test("readMemoryPortalConfig normalizes a configured URL to the fixed /memory path", () => {
  assert.deepEqual(
    readMemoryPortalConfig({
      AUTODEV_OPENLIT_UI_URL:
        "https://openlit.example.com:8443/some/other/path?x=1"
    }),
    { href: "https://openlit.example.com:8443/memory" }
  );
  assert.deepEqual(
    readMemoryPortalConfig({
      AUTODEV_OPENLIT_UI_URL: "  http://openlit:3000/  "
    }),
    { href: "http://openlit:3000/memory" }
  );
});

test("readMemoryPortalConfig rejects unsafe configured URLs", () => {
  assert.equal(
    readMemoryPortalConfig({ AUTODEV_OPENLIT_UI_URL: "not a url" }),
    null
  );
  assert.equal(
    readMemoryPortalConfig({ AUTODEV_OPENLIT_UI_URL: "javascript:alert(1)" }),
    null
  );
  assert.equal(
    readMemoryPortalConfig({ AUTODEV_OPENLIT_UI_URL: "ftp://openlit:3000" }),
    null
  );
  assert.equal(
    readMemoryPortalConfig({
      AUTODEV_OPENLIT_UI_URL: "https://admin:s3cret@openlit.example.com"
    }),
    null
  );
});

test("MemoryPortalCard links to the resolved Memory destination and never exposes a token", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MemoryPortalCard, {
      href: "http://127.0.0.1:3000/memory"
    })
  );
  assert.match(markup, /data-feature="memory-portal"/);
  assert.match(
    markup,
    /href="http:\/\/127\.0\.0\.1:3000\/memory"[^>]*data-memory-portal-link="true"/
  );
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener noreferrer"/);
  assert.match(markup, /Open external Memory UI/);
  assert.equal(/openlit/i.test(markup), false);
  assert.equal(markup.toLowerCase().includes("token"), false);
  assert.equal(markup.toLowerCase().includes("secret"), false);
  assert.equal(markup.toLowerCase().includes("bearer"), false);
});

test("MemoryPortalCard links to its default local destination", () => {
  const portal = readMemoryPortalConfig({
    AUTODEV_OPENLIT_UI_URL: undefined
  });
  assert.ok(portal, "default portal config must resolve");
  const markup = renderToStaticMarkup(
    React.createElement(MemoryPortalCard, { href: portal.href })
  );
  assert.match(markup, /data-feature="memory-portal"/);
  assert.match(
    markup,
    /href="http:\/\/127\.0\.0\.1:3000\/memory"[^>]*data-memory-portal-link="true"/
  );
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener noreferrer"/);
  assert.match(markup, /Open external Memory UI/);
});

test("readMemoryPortalConfig rejects credentialed destinations", () => {
  const portal = readMemoryPortalConfig({
    AUTODEV_OPENLIT_UI_URL: "https://admin:s3cret@openlit.example.com"
  });
  assert.equal(portal, null);
  assert.doesNotMatch(JSON.stringify(portal), /s3cret|openlit\.example\.com/u);
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
          totalCount: 0,
          limit: 50,
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

test("MemoryPortalCard uses the normalized safe Memory destination", () => {
  const env = {
    AUTODEV_CONTROL_API_TOKEN: undefined,
    AUTODEV_OPENLIT_UI_URL: "https://memory.example.com/some/other/path?x=1"
  };
  const portal = readMemoryPortalConfig(env);
  assert.deepEqual(portal, { href: "https://memory.example.com/memory" });
  const markup = renderToStaticMarkup(
    React.createElement(MemoryPortalCard, { href: portal.href })
  );
  assert.match(
    markup,
    /href="https:\/\/memory.example.com\/memory"[^>]*data-memory-portal-link="true"/
  );
  assert.equal(markup.includes('data-status="unavailable"'), false);
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

test("EvaluationsPage starts the trace lookup without waiting for the evaluation read", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = saveConsolePageEnvironment();
  const isolatedHome = mkdtempSync(join(tmpdir(), "autodev-evaluations-page-"));
  const spanId = "0123456789abcdef";
  let traceRequested: () => void = () => {};
  const traceStarted = new Promise<void>((resolve) => {
    traceRequested = resolve;
  });
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
        // Answers only once the trace lookup is in flight; a page that
        // waited for this read before starting the lookup would time out.
        await Promise.race([
          traceStarted,
          new Promise((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("trace lookup not started")),
              1000
            )
          )
        ]);
        return Response.json({
          schema: "autodev-control-evaluations-v1",
          source: "openlit_evaluation",
          readOnly: true,
          totalEvaluations: 0,
          evaluations: []
        });
      }
      if (url.endsWith(`/api/autodev/usage/span/${spanId}`)) {
        traceRequested();
        return Response.json({
          schema: "autodev-openlit-trace-detail-v1",
          traceId: "0123456789abcdef0123456789abcdef",
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
              spanAttributes: {}
            }
          ]
        });
      }
      throw new Error(`Unexpected Evaluations page request: ${url}`);
    };

    const markup = renderToStaticMarkup(
      await EvaluationsPage({ searchParams: Promise.resolve({ spanId }) })
    );
    assert.match(markup, /data-feature="evaluations"/);
    assert.match(markup, /data-trace-state="observed"/);
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
    anchorTagFor(markup, "/evaluations?spanId=0123456789abcdef") ?? "",
    /data-evaluation-trace-span-id="0123456789abcdef"/
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
      status: "available",
      message: null,
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

test("AgentsView renders secondary provider routing policy and runtime health sections", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentsView, {
      agents: [CONFIGURED_AGENT],
      providers: {
        schema: "autodev-control-providers-v1",
        providers: [
          {
            id: "codex",
            roles: {
              orchestrator: { enabled: true, mutable: true },
              subagent: { enabled: false, mutable: true }
            }
          }
        ],
        disabledOrchestratorProviders: [],
        disabledSubagentProviders: ["codex"]
      },
      routing: {
        schema: "autodev-control-routing-v1",
        runtime: {
          disabledOrchestratorProviders: [],
          disabledSubagentProviders: ["codex"]
        },
        routes: [
          {
            provider: "codex",
            pattern: "^gpt-.*$",
            baseUrl: "https://chatgpt.com/backend-api/codex"
          }
        ],
        cooldowns: {},
        concurrency: {
          effectivePerSessionLimit: 2,
          activeSubagentThreads: 1,
          activeSessions: 1,
          denials: 0
        }
      },
      runtime: {
        schema: "autodev-control-runtime-v1",
        routerInstanceId: "router-uuid-test",
        lifecycle: { state: "ready", activeResponseRequests: 1 },
        concurrency: { limit: 2, active: 1 },
        inFlightRequestCount: 1
      }
    })
  );
  assert.match(markup, /data-section="configured-agents"/);
  assert.match(markup, /data-section="providers-routing"/);
  assert.match(markup, /data-section="runtime-health"/);
  assert.match(markup, /Providers &amp; Routing Policy/);
  assert.match(markup, /Runtime Concurrency &amp; Circuit Health/);
  assert.match(markup, /router-uuid-test/);
  assert.match(markup, /https:\/\/chatgpt\.com\/backend-api\/codex/);
  assert.match(markup, /In-Flight Requests/);
});

test("AgentDetailView renders provider routes and concurrency details when observed", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentDetailView, {
      agent: CONFIGURED_AGENT,
      routing: {
        schema: "autodev-control-routing-v1",
        runtime: {
          disabledOrchestratorProviders: [],
          disabledSubagentProviders: []
        },
        routes: [
          {
            provider: "codex",
            pattern: "^gpt-.*$",
            baseUrl: "https://chatgpt.com/backend-api/codex"
          }
        ],
        cooldowns: {},
        concurrency: {
          effectivePerSessionLimit: 2,
          activeSubagentThreads: 0
        }
      },
      providers: {
        schema: "autodev-control-providers-v1",
        providers: [
          {
            id: "codex",
            roles: {
              orchestrator: { enabled: true, mutable: true },
              subagent: { enabled: false, mutable: true }
            }
          }
        ],
        disabledOrchestratorProviders: [],
        disabledSubagentProviders: []
      }
    })
  );
  assert.match(markup, /data-section="agent-provider-routes"/);
  assert.match(markup, /data-section="agent-concurrency"/);
  assert.match(markup, /Provider Routing &amp; Circuit Endpoints/);
  assert.match(markup, /https:\/\/chatgpt\.com\/backend-api\/codex/);
  assert.match(markup, /Session concurrency limit/);
  assert.equal(markup.includes("<form"), false);
});

test("Agents provider roles remain not observed when provider configuration is missing", () => {
  const routing = {
    schema: "autodev-control-routing-v1" as const,
    runtime: {
      disabledOrchestratorProviders: [],
      disabledSubagentProviders: []
    },
    routes: [
      {
        provider: "codex",
        pattern: "^gpt-.*$",
        baseUrl: "https://chatgpt.com/backend-api/codex"
      }
    ],
    cooldowns: {},
    concurrency: {
      effectivePerSessionLimit: 2,
      activeSubagentThreads: 0
    }
  };
  const agentsMarkup = renderToStaticMarkup(
    React.createElement(AgentsView, {
      agents: [CONFIGURED_AGENT],
      routing
    })
  );
  const providersStart = agentsMarkup.indexOf(
    'data-section="providers-routing"'
  );
  const runtimeStart = agentsMarkup.indexOf('data-section="runtime-health"');
  const providerMarkup = agentsMarkup.slice(providersStart, runtimeStart);
  assert.equal(
    (providerMarkup.match(/data-status="not-observed"/gu) ?? []).length,
    2
  );
  assert.equal(providerMarkup.includes(">Disabled</span>"), false);
  assert.equal(providerMarkup.includes("<form"), false);

  const detailMarkup = renderToStaticMarkup(
    React.createElement(AgentDetailView, { agent: CONFIGURED_AGENT })
  );
  const detailsStart = detailMarkup.indexOf(
    'data-section="agent-provider-routes"'
  );
  const concurrencyStart = detailMarkup.indexOf(
    'data-section="agent-concurrency"'
  );
  const detailProviderMarkup = detailMarkup.slice(
    detailsStart,
    concurrencyStart
  );
  assert.match(detailProviderMarkup, /data-status="not-observed"/);
  assert.match(detailProviderMarkup, />Not observed</);
  assert.equal(detailProviderMarkup.includes(">Enabled</span>"), false);
  assert.equal(detailProviderMarkup.includes(">Disabled</span>"), false);
});

test("HooksView only renders hooks with valid action command lists", () => {
  const hooks = hooksFromControlApi({
    schema: "autodev-control-hooks-v1",
    source: "test",
    readOnly: true,
    valid: true,
    hooks: {
      sessionStart: [{ command: "echo hi", matcher: ".*" }]
    }
  });
  const markup = renderToStaticMarkup(
    React.createElement(HooksView, { hooks, sourceValidity: true })
  );
  assert.match(markup, /echo hi/);
  assert.match(markup, /Source validation/);
});

test("HooksView reports source validity as unknown when no validation is available", () => {
  const markup = renderToStaticMarkup(
    React.createElement(HooksView, { hooks: [] })
  );
  assert.match(markup, /data-hook-state="not-observed"/);
  assert.equal(markup.includes(">Valid<"), false);
});

test("HooksView distinguishes an invalid source from an absent one", () => {
  const markup = renderToStaticMarkup(
    React.createElement(HooksView, { hooks: [], sourceValidity: false })
  );
  assert.match(markup, /data-hook-state="invalid"/);
  assert.match(markup, /Hook source is invalid/);
});

test("View adapters translate Control API responses without inventing data", () => {
  const skillsResponse = {
    schema: "autodev-control-skills-v2" as const,
    source: ".rulesync/skills+execution-contract",
    readOnly: true,
    valid: true,
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
    unresolvedAssignments: [{ name: "missing", roles: ["worker"] }]
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
    schema: "autodev-control-prompt-detail-v2",
    name: "dry",
    type: "command",
    source: ".rulesync/commands/dry.md",
    content: "Exact source",
    revision: "b".repeat(64)
  });
  assert.deepEqual(promptDocument, {
    name: "dry",
    kind: "command",
    path: ".rulesync/commands/dry.md",
    content: "Exact source",
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
        approvals: "never"
      }
    }
  });
  assert.equal(perms.roleMatrices[0]?.sandboxMode, "workspace-write");
});

test("All 12 canonical Console route paths map to a canonical nav section", () => {
  for (const section of CANONICAL_NAVIGATION) {
    const path = canonicalNavPath(section);
    assert.equal(canonicalSectionFromPath(path), section);
  }
  assert.equal(canonicalSectionFromPath("/not-a-resource"), null);
});
test("Canonical nav order matches Configure/Observe/Operate grouping", () => {
  const expected: readonly CanonicalNavSection[] = [
    "Agents",
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
      totalCount: 1,
      scope: {
        workspaceId: "SimulatorLife/AutoDev",
        query: "",
        kind: "all",
        status: "all",
        occurredFrom: "2026-09-01T00:00:00Z",
        occurredUntil: "2026-10-01T00:00:00Z"
      }
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
    transitions: [
      {
        toStatus: "proposed" as const,
        actor: { id: "operator-1", authority: "operator" as const },
        reason: "Initial proposed claim",
        timestamp: "2026-10-02T00:00:00Z"
      }
    ]
  };

  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [sampleRecord],
      totalCount: 1,
      selectedRecord: sampleRecord,
      history: sampleHistory,
      scope: {
        workspaceId: "SimulatorLife/AutoDev",
        query: "",
        kind: "all",
        status: "all",
        occurredFrom: "2026-09-01T00:00:00Z",
        occurredUntil: "2026-10-01T00:00:00Z"
      }
    })
  );

  assert.match(markup, /data-selected-record-panel="mem-002"/);
  assert.match(markup, /Durable Claim/);
  assert.match(markup, /Validity State/);
  assert.match(markup, /Transition History/);
  assert.match(markup, /Verify &amp; Promote/);
  assert.match(markup, /Invalidate/);
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
      totalCount: 1,
      scope: {
        workspaceId: "SimulatorLife/AutoDev",
        query: "",
        kind: "all",
        status: "all",
        occurredFrom: "2026-09-01T00:00:00Z",
        occurredUntil: "2026-10-01T00:00:00Z"
      }
    })
  );

  assert.match(markup, /data-memory-experience-id="exp-001"/);
  assert.match(markup, /task-101/);
  assert.match(markup, /run-505/);
  assert.match(markup, /orchestrator/);
  assert.match(markup, /jit/);
  assert.match(markup, /success/);
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

test("MemoryView keeps an unavailable experience tab out of its successful-empty state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MemoryView, {
      content: {
        tab: "experiences",
        unavailable: React.createElement(
          "div",
          { role: "alert", "data-status": "unavailable" },
          "Memory experiences are unavailable; no list or count is inferred."
        )
      },
      summary: React.createElement(MemorySummary, {
        counts: { records: null, experiences: null, cohortSessions: null }
      }),
      scope: {
        workspaceId: "SimulatorLife/AutoDev",
        query: "",
        kind: "all",
        status: "all",
        occurredFrom: "2026-09-01T00:00:00Z",
        occurredUntil: "2026-10-01T00:00:00Z"
      },
      repositoryId: "SimulatorLife/AutoDev",
      workspaces: []
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
      content: { tab: "records", records: [], totalRecords: 0 },
      summary: React.createElement(MemorySummary, {
        counts: {
          records: { total: 0, inScope: 0, active: 0 },
          experiences: null,
          cohortSessions: null
        }
      }),
      scope: {
        workspaceId: "SimulatorLife/AutoDev",
        query: "fallback",
        kind: "procedure",
        status: "active",
        occurredFrom: "2026-09-01T00:00:00Z",
        occurredUntil: "2026-10-01T00:00:00Z"
      },
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
  assert.match(markup, /data-tab-item="portal"/);
  assert.match(markup, />External Memory UI</);
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
    ["query", "fallback"],
    ["kind", "procedure"],
    ["status", "active"]
  ]);
  assert.match(markup, /Durable Records/);
  assert.match(markup, /Active Claims/);

  const selectorStart = markup.indexOf('data-memory-workspace-form="true"');
  const formStart = markup.lastIndexOf("<form", selectorStart);
  const formEnd = markup.indexOf("</form>", formStart);
  assert.notEqual(selectorStart, -1);
  assert.notEqual(formStart, -1);
  assert.ok(formEnd > formStart);
  const workspaceForm = markup.slice(formStart, formEnd);
  assert.doesNotMatch(workspaceForm, /method="post"/iu);
  assert.match(workspaceForm, /action="\/memory"/);
  assert.match(workspaceForm, /name="workspaceId"/);
  assert.match(workspaceForm, /name="tab" value="records"/);
  assert.match(workspaceForm, /name="query" value="fallback"/);
  assert.match(workspaceForm, /name="kind" value="procedure"/);
  assert.match(workspaceForm, /name="status" value="active"/);
  assert.match(workspaceForm, /name="from" value="2026-09-01T00:00:00Z"/);
  assert.match(workspaceForm, /name="until" value="2026-10-01T00:00:00Z"/);
  assert.match(workspaceForm, /SimulatorLife\/Other/);
  assert.doesNotMatch(workspaceForm, /name="recordId"|name="experienceId"/);
});

test("Memory links and filter forms carry the full URL scope", () => {
  const scope: MemoryUrlScope = {
    workspaceId: "SimulatorLife/AutoDev",
    query: "fallback",
    kind: "procedural",
    status: "active",
    occurredFrom: "2026-09-01T00:00:00Z",
    occurredUntil: "2026-10-01T00:00:00Z"
  };
  const scopeEntries = [
    ["workspaceId", "SimulatorLife/AutoDev"],
    ["from", "2026-09-01T00:00:00Z"],
    ["until", "2026-10-01T00:00:00Z"],
    ["query", "fallback"],
    ["kind", "procedural"],
    ["status", "active"]
  ];
  const searchEntries = (href: string | undefined): string[][] => {
    assert.ok(href);
    const url = new URL(href.replaceAll("&amp;", "&"), "http://console.test");
    assert.equal(url.pathname, "/memory");
    return Array.from(url.searchParams.entries());
  };
  const firstForm = (markup: string): string => {
    const start = markup.indexOf("<form");
    assert.notEqual(start, -1);
    return markup.slice(start, markup.indexOf("</form>", start));
  };
  const hiddenNames = (form: string): string[] =>
    Array.from(
      form.matchAll(/<input type="hidden" name="([^"]+)"/gu),
      ([, name]) => name ?? ""
    );

  // Unfiltered values are left out of the URL instead of encoded as "all".
  assert.deepEqual(
    searchEntries(
      memoryHref({ ...scope, query: "", kind: "all", status: "all" }, "cohorts")
    ),
    [
      ["tab", "cohorts"],
      ["workspaceId", "SimulatorLife/AutoDev"],
      ["from", "2026-09-01T00:00:00Z"],
      ["until", "2026-10-01T00:00:00Z"]
    ]
  );

  const record: MemoryRecord = {
    id: "mem-010",
    kind: "procedural",
    status: "active",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: "Scoped claim.",
    validity: { state: "verified", evidence: [] },
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T00:00:00Z"
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z"
  };
  const records = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [record],
      totalCount: 1,
      scope
    })
  );
  // Selecting a record keeps the workspace, filters, and time window.
  assert.deepEqual(
    searchEntries(
      records
        .match(/<a[^>]*data-memory-record-id="mem-010"[^>]*>/u)?.[0]
        .match(/href="([^"]+)"/u)?.[1]
    ),
    [["tab", "records"], ...scopeEntries, ["recordId", "mem-010"]]
  );
  // The record filter edits query, kind, and status; the rest rides along.
  const recordFilter = firstForm(records);
  assert.deepEqual(hiddenNames(recordFilter), [
    "tab",
    "workspaceId",
    "from",
    "until"
  ]);
  assert.match(recordFilter, /name="query" value="fallback"/u);

  const experience: ExperienceEnvelope = {
    id: "exp-010",
    workspaceId: "SimulatorLife/AutoDev",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    agentRole: "orchestrator",
    startedAt: "2026-10-03T10:00:00Z",
    outcome: "success",
    memoryMode: "jit",
    trajectory: {
      format: "codex-v1",
      uri: "file:///tmp/transcripts/run-1.jsonl",
      sourceAdapter: "codex"
    },
    evidence: []
  };
  const experiences = renderToStaticMarkup(
    React.createElement(MemoryExperiencesView, {
      experiences: [experience],
      totalCount: 1,
      scope
    })
  );
  assert.deepEqual(
    searchEntries(
      experiences
        .match(/<a[^>]*data-memory-experience-id="exp-010"[^>]*>/u)?.[0]
        .match(/href="([^"]+)"/u)?.[1]
    ),
    [["tab", "experiences"], ...scopeEntries, ["experienceId", "exp-010"]]
  );
  // The experience filter edits only the search text; the record filters
  // stay in the URL so returning to Durable Records keeps them.
  assert.deepEqual(hiddenNames(firstForm(experiences)), [
    "tab",
    "workspaceId",
    "from",
    "until",
    "kind",
    "status"
  ]);
});

test("MemorySummary streams as pending, dims stale counts, and never synthesizes zero", () => {
  const pending = renderToStaticMarkup(React.createElement(MemorySummary));
  assert.match(pending, /data-memory-summary="pending"/u);
  assert.match(pending, /aria-busy="true"/u);
  assert.doesNotMatch(pending.replaceAll(/<[^>]*>/gu, " "), /\d/u);

  const unobserved = renderToStaticMarkup(
    React.createElement(MemorySummary, {
      counts: { records: null, experiences: null, cohortSessions: null }
    })
  );
  assert.match(unobserved, /data-memory-summary="observed"/u);
  assert.equal(unobserved.match(/Not observed/gu)?.length, 4);
  assert.doesNotMatch(unobserved.replaceAll(/<[^>]*>/gu, " "), /\d/u);

  const stale = renderToStaticMarkup(
    React.createElement(MemorySummary, {
      counts: { records: null, experiences: null, cohortSessions: 3 },
      stale: true
    })
  );
  assert.match(stale, /data-memory-summary="stale"/u);
  assert.match(stale, /aria-busy="true"/u);
  assert.match(stale, /opacity-60/u);

  // Until the streamed counts resolve on the client, the summary is pending.
  const streaming = renderToStaticMarkup(
    React.createElement(MemorySummaryStream, {
      counts: new Promise<MemorySummaryCounts>(() => {})
    })
  );
  assert.match(streaming, /data-memory-summary="pending"/u);

  const observed = renderToStaticMarkup(
    React.createElement(MemorySummary, {
      counts: {
        records: { total: 12, inScope: 10, active: 7 },
        experiences: { total: 40, inScope: 25 },
        cohortSessions: 3
      }
    })
  );
  const text = observed.replaceAll(/<[^>]*>/gu, " ").replaceAll(/\s+/gu, " ");
  assert.match(text, /Durable Records 12 10 in scope/u);
  assert.match(text, /Active Claims 7/u);
  assert.match(text, /Experiences 40 25 in scope/u);
  assert.match(text, /Cohort Sessions 3/u);
});

test("observeSummaryCounts settles from a React Flight thenable, reporting a failed stream as unobserved", async () => {
  // React Flight hands the client a thenable whose `then` returns nothing and
  // which has no `catch`.
  const flightThenable = (
    outcome:
      { readonly value: MemorySummaryCounts } | { readonly reason: Error }
  ): PromiseLike<MemorySummaryCounts> =>
    ({
      // eslint-disable-next-line unicorn/no-thenable -- models React Flight's client thenable.
      then(onFulfilled, onRejected) {
        if ("value" in outcome) onFulfilled?.(outcome.value);
        else onRejected?.(outcome.reason);
      }
    }) as PromiseLike<MemorySummaryCounts>;
  const counts: MemorySummaryCounts = {
    records: { total: 2, inScope: 1, active: 1 },
    experiences: null,
    cohortSessions: 4
  };

  const settled: MemorySummaryCounts[] = [];
  await observeSummaryCounts(flightThenable({ value: counts }), (value) =>
    settled.push(value)
  );
  await observeSummaryCounts(
    flightThenable({ reason: new Error("stream closed") }),
    (value) => settled.push(value)
  );
  assert.deepEqual(settled, [
    counts,
    { records: null, experiences: null, cohortSessions: null }
  ]);
});

test("MemoryView renders only the active tab's content", () => {
  const shared = {
    summary: null,
    scope: {
      workspaceId: "SimulatorLife/AutoDev",
      query: "",
      kind: "all",
      status: "all",
      occurredFrom: "2026-09-01T00:00:00Z",
      occurredUntil: "2026-10-01T00:00:00Z"
    },
    repositoryId: "SimulatorLife/AutoDev",
    workspaces: []
  };
  const experiences = renderToStaticMarkup(
    React.createElement(MemoryView, {
      ...shared,
      content: { tab: "experiences", experiences: [], totalExperiences: 0 }
    })
  );
  assert.match(experiences, /data-feature="memory-experiences"/u);
  assert.doesNotMatch(experiences, /data-feature="memory-records"/u);
  assert.match(
    experiences,
    /aria-current="page"[^>]*data-tab-item="experiences"/u
  );

  const portal = renderToStaticMarkup(
    React.createElement(MemoryView, {
      ...shared,
      content: { tab: "portal" },
      portalHref: "http://127.0.0.1:3000/memory"
    })
  );
  assert.match(portal, /data-feature="memory-portal"/u);

  // A failed tab read is reported in the tab body; tabs stay navigable.
  const failed = renderToStaticMarkup(
    React.createElement(MemoryView, {
      ...shared,
      content: {
        tab: "cohorts",
        unavailable: React.createElement(
          "p",
          { "data-probe": "unavailable" },
          "cohorts could not be loaded"
        )
      }
    })
  );
  assert.match(failed, /data-probe="unavailable"/u);
  assert.match(failed, /aria-current="page"[^>]*data-tab-item="cohorts"/u);
  assert.match(failed, /data-tab-item="records"/u);
  assert.doesNotMatch(failed, /data-feature="memory-cohorts"/u);
  assert.doesNotMatch(
    portal,
    /data-feature="memory-(?:records|experiences|cohorts)"/u
  );
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
      totalCount: 0,
      limit: 50,
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

test("Agents provider-role controls require observed mutable provider configuration", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentsView, {
      agents: [CONFIGURED_AGENT],
      providers: {
        schema: "autodev-control-providers-v1",
        providers: [
          {
            id: "codex",
            roles: {
              orchestrator: { enabled: true, mutable: true },
              subagent: { enabled: false, mutable: false }
            }
          },
          {
            id: "anthropic",
            roles: {
              orchestrator: { enabled: false, mutable: true },
              subagent: { enabled: true, mutable: false }
            }
          }
        ],
        disabledOrchestratorProviders: [],
        disabledSubagentProviders: []
      }
    })
  );

  const forms = Array.from(
    markup.matchAll(/<form\b[^>]*>/gu),
    (match) => match[0]
  );
  assert.equal(forms.length, 2);
  assert.ok(
    forms.every((form) =>
      form.includes('data-provider-role-form="orchestrator"')
    )
  );
  assert.ok(
    forms.some((form) => form.includes('data-provider-role-provider="codex"'))
  );
  assert.ok(
    forms.some((form) =>
      form.includes('data-provider-role-provider="anthropic"')
    )
  );
  assert.equal(markup.includes("Disable</button>"), true);
  assert.equal(markup.includes("Enable</button>"), true);
});

test("Agents provider-role feedback reports outcomes without optimistic state claims", () => {
  const failedMarkup = renderToStaticMarkup(
    React.createElement(AgentsView, {
      agents: [],
      providerRoleFailed: true
    })
  );
  assert.match(failedMarkup, /data-provider-role-outcome="failed"/);
  assert.match(failedMarkup, /could not be confirmed/);
  assert.match(failedMarkup, /Check the current role state before retrying/);
  assert.doesNotMatch(failedMarkup, /No change was made/);
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
      schema: "autodev-control-prompt-command-patch-v1",
      name: "dry",
      revision: "b".repeat(64),
      changed: true,
      projectionUpdated: true,
      restartRequired: true
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

test("provider-role Console route sends only a same-origin typed PATCH with server credentials", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBaseUrl = process.env.AUTODEV_CONTROL_API_BASE_URL;
  const token = "provider-role-route-server-token";
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
      schema: "autodev-control-provider-role-v1",
      provider: "codex",
      role: "orchestrator",
      enabled: false,
      previous: true,
      actor: LOCAL_CONTROL_API_ACTOR
    });
  };

  try {
    const request = new NextRequest(
      "http://console.test/api/providers/codex/roles/orchestrator",
      {
        method: "POST",
        headers: {
          origin: "http://console.test",
          host: "console.test",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          provider: "codex",
          role: "orchestrator",
          enabled: "false"
        }).toString()
      }
    );
    const response = await providerRoleRoute.POST(request, {
      params: Promise.resolve({ provider: "codex", role: "orchestrator" })
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/agents");
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.url,
      "http://127.0.0.1:4101/control/providers/codex/roles/orchestrator"
    );
    assert.equal(requests[0]?.method, "PATCH");
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer " + token);
    assert.equal(
      requests[0]?.headers.get("x-autodev-actor"),
      LOCAL_CONTROL_API_ACTOR
    );
    assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), { enabled: false });
    assert.equal(response.headers.get("location")?.includes(token), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
    if (previousBaseUrl === undefined) {
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    } else {
      process.env.AUTODEV_CONTROL_API_BASE_URL = previousBaseUrl;
    }
  }
});

test("provider-role Console route fails closed for CSRF and malformed or oversized forms", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "provider-role-no-fetch-token";
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({ error: "unexpected mutation" }, { status: 500 });
  };

  const validBody = new URLSearchParams({
    provider: "codex",
    role: "orchestrator",
    enabled: "true"
  }).toString();
  const cases = [
    {
      name: "cross-origin Origin",
      origin: "http://attacker.test",
      fetchSite: "cross-site",
      provider: "codex",
      role: "orchestrator",
      contentType: "application/x-www-form-urlencoded",
      body: validBody
    },
    {
      name: "same-site but not same-origin fetch",
      origin: "http://console.test",
      fetchSite: "same-site",
      provider: "codex",
      role: "orchestrator",
      contentType: "application/x-www-form-urlencoded",
      body: validBody
    },
    {
      name: "malformed Origin with a path",
      origin: "http://console.test/attacker",
      fetchSite: "same-origin",
      provider: "codex",
      role: "orchestrator",
      contentType: "application/x-www-form-urlencoded",
      body: validBody
    },
    {
      name: "content type prefix spoof",
      origin: "http://console.test",
      fetchSite: "same-origin",
      provider: "codex",
      role: "orchestrator",
      contentType: "application/x-www-form-urlencoded-evil",
      body: validBody
    },
    {
      name: "extra form field",
      origin: "http://console.test",
      fetchSite: "same-origin",
      provider: "codex",
      role: "orchestrator",
      contentType: "application/x-www-form-urlencoded",
      body: validBody + "&extra=value"
    },
    {
      name: "provider and role mismatch",
      origin: "http://console.test",
      fetchSite: "same-origin",
      provider: "codex",
      role: "subagent",
      contentType: "application/x-www-form-urlencoded",
      body: validBody
    },
    {
      name: "path traversal provider",
      origin: "http://console.test",
      fetchSite: "same-origin",
      provider: "..",
      role: "orchestrator",
      contentType: "application/x-www-form-urlencoded",
      body: validBody
    },
    {
      name: "oversized body",
      origin: "http://console.test",
      fetchSite: "same-origin",
      provider: "codex",
      role: "orchestrator",
      contentType: "application/x-www-form-urlencoded",
      body: "x".repeat(4097)
    }
  ];

  try {
    for (const testCase of cases) {
      const request = new NextRequest(
        "http://console.test/api/providers/" +
          testCase.provider +
          "/roles/" +
          testCase.role,
        {
          method: "POST",
          headers: {
            origin: testCase.origin,
            host: "console.test",
            "sec-fetch-site": testCase.fetchSite,
            "content-type": testCase.contentType
          },
          body: testCase.body
        }
      );
      const response = await providerRoleRoute.POST(request, {
        params: Promise.resolve({
          provider: testCase.provider,
          role: testCase.role
        })
      });
      assert.equal(response.status, 303, testCase.name);
      assert.equal(
        response.headers.get("location"),
        "/agents?providerRole=failed",
        testCase.name
      );
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

test("provider-role Console route exports no non-POST mutation methods", () => {
  assert.equal("GET" in providerRoleRoute, false);
  assert.equal("PATCH" in providerRoleRoute, false);
  assert.equal("PUT" in providerRoleRoute, false);
  assert.equal("DELETE" in providerRoleRoute, false);
});

test("provider-role Console route returns an unconfirmed failure when Runtime rejects the PATCH", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBaseUrl = process.env.AUTODEV_CONTROL_API_BASE_URL;
  process.env.AUTODEV_CONTROL_API_TOKEN = "provider-role-rejected-token";
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          code: "autodev_control_api_operator_required",
          message: "An operator actor is required.",
          status: 403
        }
      },
      { status: 403 }
    );

  try {
    const request = new NextRequest(
      "http://console.test/api/providers/codex/roles/orchestrator",
      {
        method: "POST",
        headers: {
          origin: "http://console.test",
          host: "console.test",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          provider: "codex",
          role: "orchestrator",
          enabled: "false"
        }).toString()
      }
    );
    const response = await providerRoleRoute.POST(request, {
      params: Promise.resolve({ provider: "codex", role: "orchestrator" })
    });

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "/agents?providerRole=failed"
    );
    assert.equal(
      response.headers.get("location")?.includes("rejected-token"),
      false
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
    if (previousBaseUrl === undefined) {
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    } else {
      process.env.AUTODEV_CONTROL_API_BASE_URL = previousBaseUrl;
    }
  }
});
