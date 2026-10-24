import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterTools,
  readToolsFilters,
  toolDetailHref,
  toolsListHref,
  toolsRoleHref,
  toolsSourceHref
} from "../src/features/tools/tools-list-url.ts";
import { ToolsView } from "../src/features/tools/ToolsView.ts";

/**
 * The tool catalogue can be narrowed.
 *
 * The catalogue is the largest list in the Console -- 56 entries in the live
 * instance -- and it was the only catalogue that could not be searched. It
 * could be narrowed by source and by role, but only by clicking a facet: an
 * operator who already knew the tool they wanted still had to read the table
 * to find it.
 *
 * The narrowing is the product's own: a filter bar that submits a normal GET
 * navigation, so the narrowed list is addressable, bookmarkable and shareable
 * like every other filtered view.
 *
 * The three filters share one address, so each has to carry the other two.
 * That is the part the facet links used to get wrong -- they rebuilt the query
 * string by hand and dropped the query, so narrowing by search and then
 * clicking a source facet silently widened the list back to everything.
 */

const CATALOG = [
  {
    name: "lsp_goto_definition",
    source: "mcp" as const,
    sourceAuthority: "execution-contract" as const,
    server: "lsp",
    description: "Jump to symbol definition.",
    availability: "configured" as const,
    exposedRoles: ["worker", "default"]
  },
  {
    name: "web_search",
    source: "native" as const,
    sourceAuthority: "codex-native" as const,
    description: "Search the web.",
    availability: "configured" as const,
    exposedRoles: ["docs-researcher"]
  },
  {
    name: "request_user_input",
    source: "plugin" as const,
    sourceAuthority: "rulesync-plugin" as const,
    server: "codex_app",
    availability: "not-observed" as const,
    exposedRoles: ["orchestrator"]
  }
];

const NO_FILTERS = { source: "all", role: "", query: "" };

function renderTools(
  filters: { source?: string; role?: string; query?: string },
  tools: readonly (typeof CATALOG)[number][] = CATALOG
): string {
  return renderToStaticMarkup(
    React.createElement(ToolsView, {
      tools,
      coverage: "complete",
      validity: "valid",
      usageLink: "/usage",
      filters: {
        source: filters.source ?? "all",
        role: filters.role ?? "",
        ...(filters.query === undefined ? {} : { query: filters.query })
      }
    })
  );
}

test("a query narrows the catalogue by name, by server and by description", () => {
  const byName = filterTools(CATALOG, {
    ...NO_FILTERS,
    query: "goto"
  });
  assert.equal(byName.length, 1);
  assert.equal(byName[0]?.name, "lsp_goto_definition");

  // The server is one of the three ways a tool is known, and it is what the
  // operator reaches for when they know which MCP serves the tool.
  const byServer = filterTools(CATALOG, { ...NO_FILTERS, query: "codex_app" });
  assert.equal(byServer.length, 1);
  assert.equal(byServer[0]?.name, "request_user_input");

  // And the description is the sentence the catalogue describes the tool with.
  const byDescription = filterTools(CATALOG, {
    ...NO_FILTERS,
    query: "search the web"
  });
  assert.equal(byDescription.length, 1);
  assert.equal(byDescription[0]?.name, "web_search");

  assert.equal(filterTools(CATALOG, { ...NO_FILTERS, query: "nothing" }).length, 0);
});

test("a query ignores case, because a tool name is typed in lower case", () => {
  assert.equal(
    filterTools(CATALOG, { ...NO_FILTERS, query: "GOTO_DEFINITION" }).length,
    1
  );
  assert.equal(filterTools(CATALOG, { ...NO_FILTERS, query: "LSP" }).length, 1);
});

test("an empty query is the whole catalogue", () => {
  assert.equal(filterTools(CATALOG, { ...NO_FILTERS, query: "" }).length, 3);
  assert.equal(filterTools(CATALOG, { ...NO_FILTERS, query: "   " }).length, 3);
});

test("the source, the role and the query compose", () => {
  const bySource = filterTools(CATALOG, { ...NO_FILTERS, source: "mcp" });
  assert.equal(bySource.length, 1);
  assert.equal(bySource[0]?.name, "lsp_goto_definition");

  const byRole = filterTools(CATALOG, { ...NO_FILTERS, role: "orchestrator" });
  assert.equal(byRole.length, 1);
  assert.equal(byRole[0]?.name, "request_user_input");

  // All three at once: the entry that satisfies every one of them.
  const all = filterTools(CATALOG, {
    source: "mcp",
    role: "worker",
    query: "goto"
  });
  assert.equal(all.length, 1);
  assert.equal(all[0]?.name, "lsp_goto_definition");

  // And a combination that cannot be satisfied says so by matching nothing.
  const impossible = filterTools(CATALOG, {
    source: "native",
    role: "orchestrator",
    query: "goto"
  });
  assert.equal(impossible.length, 0);
});

test("the query does not match the facets", () => {
  // "worker" is a role and "mcp" is a source. Both are chosen by clicking
  // their facet, so a free-text query that matched them would return the
  // tools exposed to a role whenever the operator typed the role's name.
  assert.equal(filterTools(CATALOG, { ...NO_FILTERS, query: "worker" }).length, 0);
  assert.equal(filterTools(CATALOG, { ...NO_FILTERS, query: "mcp" }).length, 0);
});

test("the list's address carries the filters, and reads them back", () => {
  assert.equal(toolsListHref(NO_FILTERS), "/tools");
  assert.equal(
    toolsListHref({ ...NO_FILTERS, source: "mcp" }),
    "/tools?source=mcp"
  );
  assert.equal(
    toolsListHref({ ...NO_FILTERS, role: "worker" }),
    "/tools?role=worker"
  );
  assert.equal(
    toolsListHref({ ...NO_FILTERS, query: "goto" }),
    "/tools?q=goto"
  );
  // "all" is the absence of a source filter, not a filter of its own, so it
  // is not written out: the unfiltered list has one address.
  assert.equal(toolsListHref({ ...NO_FILTERS, source: "all" }), "/tools");

  assert.deepEqual(readToolsFilters({ source: "mcp", role: "worker", q: "goto" }), {
    source: "mcp",
    role: "worker",
    query: "goto"
  });
  // An address that says nothing asks for no filter at all. The source is
  // resolved by the page that renders it, because a source the page cannot
  // honour is that page's fact to report.
  assert.deepEqual(readToolsFilters({}), { source: "", role: "", query: "" });
  // A repeated parameter takes its first value, which is what the browser's
  // own form submission produces.
  assert.deepEqual(readToolsFilters({ q: ["first", "second"] }), {
    source: "",
    role: "",
    query: "first"
  });
});

test("a facet keeps the query, and a query keeps the facets", () => {
  const narrowed = { source: "mcp", role: "worker", query: "goto" };

  // Clicking a source from a narrowed list must not drop the query: that was
  // the list silently widening back to everything the operator had just
  // excluded.
  assert.equal(
    toolsSourceHref(narrowed, "native"),
    "/tools?source=native&role=worker&q=goto"
  );
  // Choosing "all" clears the source and keeps the rest.
  assert.equal(
    toolsSourceHref(narrowed, "all"),
    "/tools?role=worker&q=goto"
  );
  // And the same in the other direction: choosing a role keeps the source and
  // the query.
  assert.equal(
    toolsRoleHref(narrowed, "orchestrator"),
    "/tools?source=mcp&role=orchestrator&q=goto"
  );
  assert.equal(toolsRoleHref(narrowed, ""), "/tools?source=mcp&q=goto");
});

test("the list offers the Console's own filter bar", () => {
  const markup = renderTools({});

  // A named landmark, not an anonymous form.
  assert.match(markup, /<form[^>]*aria-label="Tool filters"/u);
  // The search control carries the shared chrome and a name of its own: the
  // placeholder is not a substitute, because it disappears with a value.
  assert.match(markup, /data-filter-search="tools-search"/u);
  assert.match(
    markup,
    /<label[^>]*class="sr-only"[^>]*>Search tools</u
  );
  assert.match(markup, /type="search"/u);
  // The submit is the shared vocabulary's.
  assert.match(markup, /data-button="tools-filter"/u);
  // An unfiltered list has one number, so it has no summary to give: the
  // catalogue's size is already in the stat row above it.
  assert.doesNotMatch(markup, /Showing 3 of 3 tool entries/u);
});

test("a search submitted from a narrowed list keeps the facets", () => {
  const markup = renderTools({ source: "mcp", role: "worker" });

  // The form rebuilds the query string from its own controls, so the facets
  // the operator already chose have to be carried through it.
  assert.match(markup, /<input[^>]*name="source"[^>]*value="mcp"/u);
  assert.match(markup, /<input[^>]*name="role"[^>]*value="worker"/u);
  // The search control keeps what the operator typed, so the second narrowing
  // starts from the first rather than from nothing.
  assert.match(markup, /value=""/u);
});

test("a narrowed list says how much of the catalogue is in view", () => {
  const markup = renderTools({ source: "mcp" });

  assert.match(markup, /Showing 1 of 3 tool entries/u);
});

test("an empty narrowed list says the query excluded everything", () => {
  const markup = renderTools({ query: "nothing here" });

  assert.match(
    markup,
    /No tool entries found matching the current criteria\./u
  );
  // Not "no tool entries are configured": the catalogue holds three of them,
  // and the query is what removed them.
  assert.doesNotMatch(markup, /No tool entries are configured\./u);
});

test("an empty catalogue still says the catalogue is empty", () => {
  const markup = renderTools({}, []);

  assert.match(markup, /No tool entries are configured\./u);
});

test("an entry's address carries the list's state", () => {
  // The detail route is a path, so the narrowing travels beside it and the
  // breadcrumb returns the operator to the list they came from.
  assert.equal(
    toolDetailHref({ source: "mcp", role: "worker", query: "goto" }, "lsp_goto"),
    "/tools/lsp_goto?source=mcp&role=worker&q=goto"
  );
  assert.equal(
    toolDetailHref(NO_FILTERS, "lsp_goto"),
    "/tools/lsp_goto"
  );
});

test("the list's rows link to the entry with the list's state", () => {
  const markup = renderTools({ source: "mcp", query: "goto" });

  // The entry is addressed by its qualified name, and the list's narrowing
  // travels beside it.
  assert.match(
    markup,
    /href="\/tools\/mcp__lsp__lsp_goto_definition\?source=mcp&amp;q=goto"/u
  );
});

test("an unobserved entry is counted over the entries on screen", () => {
  // The note sits beside the table, so it has to describe the table. It used
  // to count the whole catalogue and then sit next to a narrowed count, so
  // the two numbers on the line were about different sets.
  const narrowed = renderTools({ source: "plugin" });
  assert.match(narrowed, /1 entry rendered as Not observed/u);

  const wider = renderTools({ source: "all" });
  assert.match(wider, /1 entry rendered as Not observed/u);
});
