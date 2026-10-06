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
  type ControlApiModelsResponse,
  type ControlApiPromptDetailResponse,
  type ControlApiProvidersResponse,
  type ExperienceEnvelope,
  type GithubWorkflowDefinition,
  LOCAL_CONTROL_API_ACTOR,
  type McpServerResource,
  type MemoryRecord,
  type MemorySessionOutcomeCohortPage,
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
import * as providerRoleRoute from "../app/api/providers/[provider]/roles/[role]/route.ts";
import EvaluationsPage from "../app/evaluations/page.ts";
import MemoryPage from "../app/memory/page.ts";
import { NAV_ICONS, navIcon } from "../src/components/icons/Icon.ts";
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
  DataTable,
  type DataTableProps,
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
  MCP_DETAIL_TABS,
  McpDetailView,
  McpsView,
  MemoryCohortsView,
  MemoryExperiencesView,
  MemoryRecordsView,
  MemoryView,
  ModelDetailView,
  PromptDetailView,
  PromptsView,
  ProviderDetailView,
  ProvidersView,
  resolveActiveTabId,
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
  fetchMemoryExperiences,
  fetchMemoryHistory,
  fetchMemoryRecord,
  fetchMemoryRecords,
  fetchModels,
  fetchPromptDetail,
  fetchPrompts,
  fetchPromptVersion,
  fetchPromptVersions,
  fetchProviders,
  fetchRuntime,
  fetchSkills,
  fetchTools,
  fetchWorkspaces,
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
  }
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
      keyExtractor: (r: TestRow) => r.id
    })
  );
  assert.ok(markup.includes("Alpha"));
  assert.ok(markup.includes("Beta"));
  assert.ok(markup.includes("<table"));
  assert.match(markup, /<td[^>]*class="[^"]*truncate[^"]*"[^>]*>1<\/td>/);
  // A `tokens` column wraps between items and never splits a token, and it
  // claims a larger share of the width than a plain label so the browser
  // cannot collapse it to one chip per line.
  assert.match(markup, /class="[^"]*whitespace-normal break-normal[^"]*"/);
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
      keyExtractor: (r: TestRow) => r.id
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
      keyExtractor: (r: TestRow) => r.id
    })
  );
  // Relative widths shrink proportionally on a narrower viewport, so a header
  // that runs out of room wraps. Truncating it would render "CONVERGEN…" and
  // hide which column it labels.
  assert.match(
    markup,
    /<th [^>]*class="[^"]*break-words[^"]*"[^>]*>Convergence<\/th>/
  );
  assert.doesNotMatch(markup, /<th [^>]*class="[^"]*truncate[^"]*"/);
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
      keyExtractor: (r: TestRow) => r.id
    })
  );
  // `-webkit-line-clamp` needs a box display, so the clamp belongs on a wrapper
  // inside the cell; clamping the `<td>` itself breaks its table-cell layout.
  assert.match(
    markup,
    /<td[^>]*class="[^"]*whitespace-normal break-words[^"]*"[^>]*><div class="line-clamp-2">/
  );
});

test("DataTable keeps a truncated cell's full value reachable, and titles nothing else", () => {
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
      keyExtractor: (r: { v: string }) => r.v
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

  // A cell built from elements owns its own recovery, so titling the cell as
  // well would either duplicate the element's title or invent text that does
  // not match what the cell shows.
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
      keyExtractor: (r: { v: string }) => r.v
    })
  );
  assert.doesNotMatch(
    elementCell,
    /<td[^>]*title=/,
    `an element cell must leave its recovery to the element, got: ${elementCell}`
  );
  assert.ok(elementCell.includes(`title="${value}"`));
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

test("ToolsView renders explicit availability per tool with the catalog coverage banner", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolsView, {
      coverage: "partial",
      validity: "valid",
      totalTools: 1,
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
      totalTools: 0,
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
      totalTools: 1,
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
      totalTools: 1,
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
      route: {
        pattern: "^(sonnet|claude-[a-z0-9-]*[a-z0-9])$",
        baseUrl: "http://127.0.0.1:4000/v1",
        healthUrl: "http://127.0.0.1:4000/health/liveliness"
      },
      credential: { envKey: "LITELLM_API_KEY", configured: false },
      roles: {
        orchestrator: {
          enabled: true,
          mutable: true,
          convergence: {
            convergence: "converged",
            desiredGeneration: "orchestrator:enabled=true",
            observedGeneration: "orchestrator:enabled=true",
            lastApplyAt: "2026-10-05T15:00:00.000Z",
            lastObservationAt: "2026-10-05T15:00:00.000Z",
            lastError: null,
            explanation: "Converged."
          }
        },
        subagent: {
          enabled: true,
          mutable: true,
          convergence: {
            convergence: "converged",
            desiredGeneration: "subagent:enabled=true",
            observedGeneration: "subagent:enabled=true",
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
      route: {
        pattern: "^gpt-.*$",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        healthUrl: null
      },
      credential: { envKey: null, configured: true },
      roles: {
        orchestrator: {
          enabled: false,
          mutable: true,
          convergence: {
            convergence: "pending",
            desiredGeneration: "orchestrator:enabled=false",
            observedGeneration: null,
            lastApplyAt: "2026-10-05T15:30:00.000Z",
            lastObservationAt: null,
            lastError: null,
            explanation: "Pending observation."
          }
        },
        subagent: {
          enabled: false,
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
      currentWorkspaceId: "SimulatorLife/AutoDev"
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
      total: 1,
      selectedRecord: sampleRecord,
      history: sampleHistory,
      currentWorkspaceId: "SimulatorLife/AutoDev"
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
      total: 1,
      currentWorkspaceId: "SimulatorLife/AutoDev"
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
      currentWorkspaceId: "SimulatorLife/AutoDev"
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
      activeTab: "experiences",
      records: [],
      totalRecords: 0,
      experiences: [],
      totalExperiences: null,
      sessionCohorts: null,
      useCohorts: null,
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      workspaces: [],
      occurredFrom: "2026-09-01T00:00:00Z",
      occurredUntil: "2026-10-01T00:00:00Z"
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
      activeTab: "records",
      records: [],
      totalRecords: 0,
      experiences: [],
      totalExperiences: null,
      sessionCohorts: null,
      useCohorts: null,
      currentWorkspaceId: "SimulatorLife/AutoDev",
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
      ],
      query: "fallback",
      kind: "procedure",
      status: "active",
      occurredFrom: "2026-09-01T00:00:00Z",
      occurredUntil: "2026-10-01T00:00:00Z"
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
  assert.match(workspaceForm, /method="GET"/);
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
  const mcps = {
    schema: "autodev-control-mcps-v1",
    source: ".rulesync/mcp.jsonc",
    readOnly: true,
    valid: true,
    servers: [{ name: "lsp", enabled: true, declared: true, roles: [] }]
  };
  assert.equal((await fetchMcps(config, serve(mcps))).kind, "ok");
  for (const broken of [
    { ...mcps, schema: "autodev-control-mcps-v0" },
    { ...mcps, servers: {} },
    { ...mcps, servers: [{ enabled: true }] },
    { ...mcps, valid: "yes" }
  ]) {
    assert.equal(
      (await fetchMcps(config, serve(broken))).kind,
      "invalid-response",
      JSON.stringify(broken)
    );
  }

  const tools = {
    schema: "autodev-control-tools-v2",
    source: "catalog",
    readOnly: true,
    coverage: "complete",
    validity: "valid",
    totalTools: 1,
    usageLink: "/usage",
    tools: [{ name: "web_search", source: "native", exposedRoles: [] }]
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
    hooks: { pre_tool_use: [] }
  };
  assert.equal((await fetchHooks(config, serve(hooks))).kind, "ok");
  assert.equal(
    (await fetchHooks(config, serve({ ...hooks, hooks: [] }))).kind,
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

test("Memory detail and the workspace catalog fail closed on unreadable responses", async () => {
  const config = { baseUrl: "http://127.0.0.1:4101", serviceToken: "t" };
  const serve = (body: unknown) => ({
    fetchImpl: async () => Response.json(body)
  });
  const workspaceId = "SimulatorLife/AutoDev";

  const record = { schema: "autodev-memory-record-v1", memory: { id: "r1" } };
  assert.equal(
    (await fetchMemoryRecord("r1", workspaceId, config, serve(record))).kind,
    "ok"
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
    memory: { id: "r1" },
    transitions: []
  };
  assert.equal(
    (await fetchMemoryHistory("r1", workspaceId, config, serve(history))).kind,
    "ok"
  );
  for (const broken of [
    { schema: "autodev-memory-history-v1", memory: { id: "r1" } },
    { ...history, transitions: {} },
    { ...history, memory: null }
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

test("ProvidersView puts each provider's role toggles in its own row", () => {
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

  const forms = formTags(markup);
  assert.equal(forms.length, 4);
  assert.ok(
    forms.every((form) => form.includes('data-enablement-form="provider-role"'))
  );
  for (const provider of ["claude", "codex"]) {
    for (const role of ["orchestrator", "subagent"]) {
      const form = forms.find((tag) =>
        tag.includes(`action="/api/providers/${provider}/roles/${role}"`)
      );
      assert.ok(form, `${provider} ${role} toggle must be in its row`);
      assert.equal(hiddenValue(markup, form, "returnTo"), "/providers");
      assert.equal(hiddenValue(markup, form, "provider"), provider);
    }
  }
  // The read-only codex subagent control stays in place, disabled, with why.
  // The control's state, target, and unavailable reason all live on the one
  // button, so the owning tag is the button's own opening tag.
  const codexSubagentIndex = markup.indexOf(
    'data-enablement-target="codex/subagent"'
  );
  assert.ok(codexSubagentIndex > 0, "codex subagent control must render");
  const codexSubagentMarkup = markup.slice(
    markup.lastIndexOf("<button", codexSubagentIndex)
  );
  const codexSubagentTagEnd = codexSubagentMarkup.indexOf(">");
  const codexSubagentTag =
    codexSubagentTagEnd === -1
      ? ""
      : codexSubagentMarkup.slice(0, codexSubagentTagEnd);
  assert.ok(codexSubagentTag.length > 0);
  assert.ok(codexSubagentTag.includes('type="submit"'));
  assert.match(codexSubagentTag, /disabled=""/);
  assert.match(codexSubagentTag, /data-enablement-unavailable="true"/);
  assert.match(
    codexSubagentTag,
    /title="Runtime reports this setting as read-only\."/
  );

  assert.match(markup, /Cooling down \(session_limit\)/);
  assert.match(markup, /Missing LITELLM_API_KEY/);
  assert.match(markup, />Not required</);
  assert.match(markup, />Not observed</);
  assert.match(markup, /href="\/providers\/claude\/models\/sonnet"/);
  assert.match(markup, /data-section="routing-priority"/);
  assert.match(markup, /orchestrator \(root\)/);
  assert.equal(markup.includes('data-enablement-form="model"'), false);
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
  const roleForms = forms.filter((form) =>
    form.includes('data-enablement-form="provider-role"')
  );
  const modelForms = forms.filter((form) =>
    form.includes('data-enablement-form="model"')
  );
  assert.equal(roleForms.length, 2);
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
  assert.match(markup, /orchestrator: enabled/);
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
        schema: "autodev-control-provider-role-v2",
        provider: "codex",
        role: "orchestrator",
        enabled: false,
        previous: true,
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
            enabled: "false",
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
        enabled: false
      });
    }
  );
});

test("provider-role Console route fails closed for CSRF, foreign return paths, and malformed or oversized forms", async () => {
  let fetchCalls = 0;
  const validFields = {
    provider: "codex",
    role: "orchestrator",
    enabled: "true",
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
  for (const route of [providerRoleRoute, modelRoute]) {
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
      totalTools: 4,
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
      totalTools: 1,
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
      totalTools: 0,
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
    assert.equal(
      response.headers.get("location"),
      "/memory?tab=experiences&workspaceId=SimulatorLife%2FAutoDev&control=failed"
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
    assert.equal(
      response.headers.get("location"),
      "/memory?tab=experiences&workspaceId=SimulatorLife%2FAutoDev&control=failed"
    );
    assert.equal(requests.length, 0);
  });
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
      keyExtractor: (r: TestRow) => r.id
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
      keyExtractor: (r: TestRow) => r.id
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

test("the resource failure shell keeps its error tint and lets a long error code wrap", () => {
  // The failure shell is what every route renders when a resource cannot be
  // loaded, so it is the one place a page must never look healthy by accident.
  //
  // Two failure modes are guarded here, both invisible to the type checker:
  // composing `${DETAIL_PANEL_CLASS} bg-error/10` silently keeps `bg-surface`,
  // because Tailwind resolves two utilities on the same property by
  // stylesheet order rather than by class-attribute order; and a shape
  // constant that set `whitespace-nowrap` could not be relaxed to `normal`
  // by appending another utility, which left the long unbroken error code
  // unable to wrap on a narrow viewport.
  const markup = renderToStaticMarkup(
    React.createElement(ResourceUnavailable, {
      title: "Permissions could not be loaded",
      code: "autodev_control_api_invalid_permissions_response",
      message: "The Control API returned an incompatible response."
    })
  );

  assert.match(
    markup,
    /data-error-code="autodev_control_api_invalid_permissions_response"/
  );
  assert.match(markup, /bg-error\/10/);
  assert.doesNotMatch(
    markup,
    /bg-surface/,
    "the default panel surface must not win over the error tint"
  );
  assert.match(markup, /break-all/);
  assert.doesNotMatch(markup, /whitespace-nowrap/);
  assert.match(markup, /rounded-lg border shadow p-6/);
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
        currentWorkspaceId: "SimulatorLife/AutoDev",
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
  const roots = ["app", "src"].map((root) =>
    join(import.meta.dirname, "..", root)
  );
  const offenders: string[] = [];
  for (const root of roots) {
    for (const relative of readdirSync(root, { recursive: true })) {
      const file = join(root, relative.toString());
      if (!file.endsWith(".ts") || !statSync(file).isFile()) continue;
      const source = readFileSync(file, "utf8");
      for (let at = source.indexOf("React.createElement("); at !== -1;) {
        const propsStart = source.indexOf(
          "{",
          at + "React.createElement(".length
        );
        const propsEnd = matchingBrace(source, propsStart);
        if (propsStart === -1 || propsEnd === -1) break;
        const props = source.slice(propsStart, propsEnd + 1);
        const line = source.slice(0, at).split("\n").length;
        // Only a bare `truncate` counts. `truncate` inside an arbitrary-length
        // bracket value, or as part of another utility name, is not the
        // single-line ellipsis this rule is about.
        const className = props.match(/className:\s*(["'`])([\s\S]*?)\1/);
        if (
          className !== null &&
          /(^|\s)truncate(\s|$)/u.test(className[2] ?? "") &&
          !/\btitle:/u.test(props)
        ) {
          offenders.push(`${relative}:${line}`);
        }
        at = propsEnd + 1;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These elements truncate their text with nothing to give it back. Add a title, or use Chip/DataTable, which do it for you:\n${offenders.join("\n")}`
  );
});

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
      currentWorkspaceId: "SimulatorLife/AutoDev",
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
        transitions: [
          {
            fromStatus: "proposed",
            toStatus: "active",
            actor: { id: "operator" },
            timestamp: "2026-10-02T00:00:00Z",
            reason: "verified"
          },
          {
            fromStatus: "active",
            toStatus: "invalidated",
            actor: { id: "operator" },
            timestamp: "2026-10-03T00:00:00Z",
            reason: null
          }
        ]
      } as never
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
      keyExtractor: (r) => r.id
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
      onRowClick: () => undefined
    })
  );
  assert.match(withClick, /cursor-pointer/);
});
