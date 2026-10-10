import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ToolCatalogItem } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToolsView } from "../src/features/tools/ToolsView.ts";

/**
 * Same-origin internal links on `/tools` must go through the shared
 * NavigationLink (Next Link), so the filter clicks and the row/edit/usage
 * pivots are client-side transitions rather than full document loads.
 *
 * These guard the migration. Six categories of link live on this view --
 * the source filter buttons (All / Native / MCP / Plugin), the role filter
 * buttons, the role filter chips in the Exposed Roles column, the row link
 * to each tool's detail page, the canonical edit-surface link, and the
 * usage route -- and each one has to preserve the URL/query state it was
 * built to express, render the data-* marker an audit can hook onto, and
 * keep the styling the rest of the Console renders.
 */

const MCP_TOOL: ToolCatalogItem = {
  name: "do_thing",
  source: "mcp",
  sourceAuthority: "rulesync-mcp",
  server: "example",
  description: "Does a thing.",
  exposedRoles: ["default", "worker"],
  availability: "configured",
  canonicalEditSurface: { section: "mcps", identifier: "example" }
};

const NATIVE_TOOL: ToolCatalogItem = {
  name: "read_file",
  source: "native",
  sourceAuthority: "codex-native",
  exposedRoles: ["orchestrator"],
  availability: "configured"
};

const PROMPT_TOOL: ToolCatalogItem = {
  name: "summarize",
  source: "plugin",
  sourceAuthority: "rulesync-plugin",
  server: "prompts",
  exposedRoles: ["validator"],
  availability: "configured",
  canonicalEditSurface: { section: "prompts", identifier: "summarize" }
};

const AGENT_TOOL: ToolCatalogItem = {
  name: "route_request",
  source: "mcp",
  sourceAuthority: "execution-contract",
  server: "agents",
  exposedRoles: ["orchestrator"],
  availability: "configured",
  canonicalEditSurface: { section: "agents", identifier: "agents" }
};

const TOOLS: readonly ToolCatalogItem[] = [
  MCP_TOOL,
  NATIVE_TOOL,
  PROMPT_TOOL,
  AGENT_TOOL
];

function renderTools(
  filters: { source: string; role: string },
  usageLink = "/usage?tool=do_thing"
): string {
  return renderToStaticMarkup(
    React.createElement(ToolsView, {
      tools: TOOLS,
      coverage: "complete",
      validity: "valid",
      usageLink,
      filters
    })
  );
}

function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** Reverse the HTML escaping the renderer applied to attribute values. */
function unescapeAttr(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/** Every href paired with the data-* marker that names this anchor. */
function anchorsWith(
  markup: string,
  marker: string
): { href: string; value: string }[] {
  const out: { href: string; value: string }[] = [];
  const reHrefFirst = new RegExp(
    String.raw`<a\b[^>]*\bhref="([^"]+)"[^>]*\b${marker}=(?:"([^"]*)"|([^\s>]+))(?=[\s>])[^>]*>`,
    "gu"
  );
  for (const m of markup.matchAll(reHrefFirst)) {
    out.push({ href: unescapeAttr(m[1]!), value: unescapeAttr(m[2] ?? m[3]!) });
  }
  const reMarkerFirst = new RegExp(
    String.raw`<a\b[^>]*\b${marker}=(?:"([^"]*)"|([^\s>]+))(?=[\s>])[^>]*\bhref="([^"]+)"[^>]*>`,
    "gu"
  );
  for (const m of markup.matchAll(reMarkerFirst)) {
    out.push({ href: unescapeAttr(m[3]!), value: unescapeAttr(m[1] ?? m[2]!) });
  }
  return out;
}

test("the source filter keeps the active role and resets to /tools when 'all' is chosen", () => {
  const markup = renderTools({ source: "mcp", role: "worker" });

  const sources = anchorsWith(markup, "data-source-filter");
  assert.deepEqual(
    sources.map((entry) => entry.value).sort(),
    ["all", "mcp", "native", "plugin"],
    `expected one button per source, got: ${sources.map((entry) => `${entry.value}->${entry.href}`).join(", ")}`
  );

  // `all` strips the source query param so the URL is the unfiltered one; the
  // role must be preserved through that change.
  const all = sources.find((entry) => entry.value === "all");
  assert.equal(all?.href, "/tools?role=worker", "all -> tools + role");
  // The non-'all' buttons carry their source and keep the role.
  const mcp = sources.find((entry) => entry.value === "mcp");
  assert.equal(mcp?.href, "/tools?source=mcp&role=worker");
  const native = sources.find((entry) => entry.value === "native");
  assert.equal(native?.href, "/tools?source=native&role=worker");
  const plugin = sources.find((entry) => entry.value === "plugin");
  assert.equal(plugin?.href, "/tools?source=plugin&role=worker");
});

test("the role filter keeps the active source and clears the role when 'all' is chosen", () => {
  const markup = renderTools({ source: "mcp", role: "worker" });

  const roles = anchorsWith(markup, "data-role-filter");
  // The role list is built from every catalog entry, so the role filter stays
  // a complete vocabulary even when a source filter is active -- picking a
  // role from a neighbouring source has to be reachable from this view.
  assert.deepEqual(
    roles.map((entry) => entry.value).sort(),
    ["all", "default", "orchestrator", "validator", "worker"],
    `expected an 'all' chip plus one per observed role, got: ${roles.map((entry) => `${entry.value}->${entry.href}`).join(", ")}`
  );

  const all = roles.find((entry) => entry.value === "all");
  assert.equal(all?.href, "/tools?source=mcp", "all strips the role only");
  const worker = roles.find((entry) => entry.value === "worker");
  assert.equal(worker?.href, "/tools?source=mcp&role=worker");
  const validator = roles.find((entry) => entry.value === "validator");
  assert.equal(
    validator?.href,
    "/tools?source=mcp&role=validator",
    "every observed role is offered, even ones the source filter would not show"
  );
});

test("a clean URL still renders four source buttons and an 'all' role chip", () => {
  const markup = renderTools({ source: "all", role: "" });

  const sources = anchorsWith(markup, "data-source-filter");
  assert.deepEqual(sources.map((entry) => entry.value).sort(), [
    "all",
    "mcp",
    "native",
    "plugin"
  ]);
  // Without an active role, every source filter's URL is just `/tools` plus
  // its own source query param -- no leftover `role=` to mislead the reader.
  for (const entry of sources) {
    if (entry.value === "all") {
      assert.equal(entry.href, "/tools");
    } else {
      assert.equal(entry.href, `/tools?source=${entry.value}`);
    }
  }

  const roles = anchorsWith(markup, "data-role-filter");
  assert.deepEqual(roles.map((entry) => entry.value).sort(), [
    "all",
    "default",
    "orchestrator",
    "validator",
    "worker"
  ]);
  const allRole = roles.find((entry) => entry.value === "all");
  assert.equal(allRole?.href, "/tools?source=all");
});

test("the tool detail links point at the encoded wire id for each row", () => {
  const markup = renderTools({ source: "all", role: "" });
  // The wire id is `mcp__<server>__<name>` for MCP entries, or just `name`
  // for non-server tools; `toolId` URL-encodes that value. Every detail link
  // must use the same encoded form so the URL is stable across rows.
  const links = anchorsWith(markup, "data-tool-detail-link");
  assert.equal(links.length, TOOLS.length);
  const expected = new Map<string, string>();
  for (const tool of TOOLS) {
    const wireId = tool.server
      ? `mcp__${tool.server}__${tool.name}`
      : tool.name;
    expected.set(encodeURIComponent(wireId), wireId);
  }
  for (const link of links) {
    const expectedPath = `/tools/${link.value}`;
    assert.equal(link.href, expectedPath);
    assert.ok(expected.has(link.value), `unexpected detail link ${link.value}`);
    const wireId = expected.get(link.value)!;
    assert.match(markup, new RegExp(`title="${escapeForRegex(wireId)}"`));
  }
});

test("the canonical edit-surface link reflects the section's owner and preserves its label", () => {
  const markup = renderTools({ source: "all", role: "" });
  const edits = anchorsWith(markup, "data-edit-surface");
  // Three of the four fixtures carry a canonical edit surface; the native
  // tool does not, so the edit column renders the "Not cataloged" muted text
  // for that row rather than a link.
  assert.deepEqual(
    edits.map((entry) => entry.value).sort(),
    ["agents", "mcps", "prompts"],
    `expected one edit link per surface, got: ${edits.map((entry) => `${entry.value}->${entry.href}`).join(", ")}`
  );
  const mcps = edits.find((entry) => entry.value === "mcps");
  assert.equal(mcps?.href, "/mcps/example");
  const prompts = edits.find((entry) => entry.value === "prompts");
  assert.equal(prompts?.href, "/prompts");
  const agents = edits.find((entry) => entry.value === "agents");
  assert.equal(agents?.href, "/agents");
  // The visible text comes from the surface's `label` when one is set, so the
  // MCP edit link here reads the explicit label rather than the fallback.
  assert.match(markup, />MCP example</);
});

test("the usage link uses the page's usage route and renders exactly once", () => {
  const usageLink = "/usage?tool=do_thing&workspaceId=owner%2Fgame";
  const markup = renderTools({ source: "all", role: "" }, usageLink);
  const usages = anchorsWith(markup, "data-tools-usage-link");
  assert.equal(
    usages.length,
    1,
    `expected one usage link, got: ${usages.length}`
  );
  assert.equal(usages[0]?.href, usageLink);
  assert.match(markup, />View tool-call usage →</);
});

test("role filter chips preserve their role href and accessibility label", () => {
  const markup = renderTools({ source: "mcp", role: "worker" });
  const chips = anchorsWith(markup, "data-role-chip");
  // Two chips, one per role the MCP tool exposes. The agent-source MCP tool
  // has no role chip in the rendered scope here because the source filter
  // narrows the table to MCP entries that match -- both fixtures happen to
  // be MCP, but only the first exposes `default` and `worker`.
  assert.deepEqual(chips.map((entry) => entry.value).sort(), [
    "default",
    "worker"
  ]);
  for (const entry of chips) {
    assert.equal(
      entry.href,
      `/tools?source=mcp&role=${entry.value}`,
      `chip ${entry.value} href`
    );
    const label = `Filter tools exposed to ${entry.value}`;
    // aria-label and title both echo the same description, so a screen
    // reader and a truncated chip agree on what the link does.
    assert.match(markup, new RegExp(`aria-label="${escapeForRegex(label)}"`));
    assert.match(markup, new RegExp(`title="${escapeForRegex(label)}"`));
  }
});

test("no same-origin link in ToolsView is rendered through a raw anchor element", () => {
  // The Next Link the NavigationLink wraps renders an `<a>` after the data is
  // hydrated, so the only way a *bare* anchor gets into the markup is if
  // ToolsView created one directly. The pattern guarded here is what the
  // migration replaced; a regression here is the original defect.
  //
  // Source-level rather than rendered-level: a future test that mounts the
  // view in a DOM could miss a stray direct anchor because Next's render-time
  // is not what `React.createElement` returned, and reading the source
  // catches the cause rather than the symptom.
  const source = readFileSync(
    new URL("../src/features/tools/ToolsView.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /React\.createElement\(\s*["']a["']/u,
    "ToolsView must not create raw <a> elements; use NavigationLink instead"
  );
});

test("ToolsView imports the shared NavigationLink rather than reaching into next/link directly", () => {
  // The dynamic-route prefetch, intent handlers and `dataAttributes` contract
  // all live on the shared NavigationLink; bypassing it loses every one of
  // those and reintroduces the full-document navigation this guard is about.
  const source = readFileSync(
    new URL("../src/features/tools/ToolsView.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /from\s+["']\.\.\/\.\.\/components\/navigation\/NavigationLink\.ts["']/u
  );
  assert.doesNotMatch(
    source,
    /from\s+["']next\/link/u,
    "ToolsView must use NavigationLink, not next/link directly"
  );
});
