import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterPrompts,
  promptsListHref,
  readPromptsQuery
} from "../src/features/prompts/prompts-list-url.ts";
import { PromptsView } from "../src/features/prompts/PromptsView.ts";

/**
 * The prompts list can be narrowed.
 *
 * The list is the whole RuleSync catalog -- every canonical command and role
 * prompt in the repository -- and it was the only large list in the Console
 * with no way to narrow it, while the Tools list beside it filtered by source
 * and role, the Evaluations list filtered and paginated, and the Memory list
 * filtered, searched and paginated. Measured against the live Console that is
 * 76 rows, and the operator had to scroll to reach the one they meant.
 *
 * The narrowing is the product's own: a filter bar that submits a normal GET
 * navigation, so the narrowed list is addressable, bookmarkable and shareable
 * like every other filtered view.
 */

const CATALOG = [
  {
    name: "code-review",
    path: ".rulesync/commands/code-review.md",
    kind: "command" as const,
    description: "Review a diff for defects."
  },
  {
    name: "release-notes",
    path: ".rulesync/commands/release-notes.md",
    kind: "command" as const,
    description: "Write the release notes for a version."
  },
  {
    name: "orchestrator",
    path: "agents/prompts/roles/orchestrator.md",
    kind: "role" as const,
    description: "The system prompt for the orchestrator role."
  }
];

test("a query narrows the catalog by name, by description and by path", () => {
  assert.equal(filterPrompts(CATALOG, "code-review").length, 1);
  assert.equal(filterPrompts(CATALOG, "release notes").length, 1);
  assert.equal(filterPrompts(CATALOG, "orchestrator").length, 1);
  assert.equal(filterPrompts(CATALOG, "agents/prompts").length, 1);
  assert.equal(filterPrompts(CATALOG, "nothing here").length, 0);
});

test("a query ignores case, because a command is typed in lower case", () => {
  assert.equal(filterPrompts(CATALOG, "CODE-REVIEW").length, 1);
  assert.equal(filterPrompts(CATALOG, "Release-Notes").length, 1);
});

test("an empty query is the whole catalog", () => {
  assert.equal(filterPrompts(CATALOG, "").length, CATALOG.length);
  assert.equal(filterPrompts(CATALOG, "   ").length, CATALOG.length);
});

test("the list's address carries the query, and reads it back", () => {
  assert.equal(promptsListHref(""), "/prompts");
  assert.equal(promptsListHref("  "), "/prompts");
  assert.equal(promptsListHref("code review"), "/prompts?q=code%20review");
  assert.equal(readPromptsQuery({ q: "code review" }), "code review");
  assert.equal(readPromptsQuery({ q: " code review " }), "code review");
  assert.equal(readPromptsQuery({ q: ["first", "second"] }), "first");
  assert.equal(readPromptsQuery({}), "");
});

test("the list offers the Console's own filter bar", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: CATALOG,
      query: "",
      commandSourceValidity: true,
      rolePromptsObserved: true,
      validationIssues: []
    })
  );

  // A named landmark, not an anonymous form.
  assert.match(markup, /<form[^>]*aria-label="Prompt filters"/u);
  // The search control carries the shared chrome and a name of its own: the
  // placeholder is not a substitute, because it disappears with a value.
  assert.match(markup, /data-filter-search="prompts-search"/u);
  assert.match(
    markup,
    /<label[^>]*class="sr-only"[^>]*>Search prompts and commands</u
  );
  assert.match(markup, /type="search"/u);
  // The submit is the shared vocabulary's.
  assert.match(markup, /data-button="prompts-filter"/u);
  // An unfiltered list has one number, so it has no summary to give.
  assert.doesNotMatch(markup, /of 76 prompts and commands/u);
});

test("a narrowed list says how much of the catalog is in view", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: CATALOG,
      query: "code-review",
      commandSourceValidity: true,
      rolePromptsObserved: true,
      validationIssues: []
    })
  );

  assert.match(markup, /1 of 3 prompts and commands/u);
  // The search control keeps what the operator typed, so the second narrowing
  // starts from the first rather than from nothing.
  assert.match(markup, /value="code-review"/u);
});

test("the stat row counts the catalog, not the narrowed view of it", () => {
  // The narrowing is applied in the view, so the view holds both the
  // catalogue and the query. The cards above the table are about the
  // catalogue: a page that narrowed the list before handing it over made the
  // "Canonical Prompts" card report the narrowed count for a catalogue of
  // seventy-six, while the navigation badge beside it said seventy-six.
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: CATALOG,
      query: "code-review",
      commandSourceValidity: true,
      rolePromptsObserved: true,
      validationIssues: []
    })
  );

  assert.match(
    markup,
    /Canonical Prompts<\/dt>[\s\S]*?>3</u,
    "the catalogue holds three entries, and the query narrowed the rows below"
  );
  assert.match(markup, /RuleSync Commands<\/dt>[\s\S]*?>2</u);
  assert.match(markup, /Agent Role Prompts<\/dt>[\s\S]*?>1</u);
  // And the rows are what the query selected.
  assert.match(markup, /code-review/u);
  assert.doesNotMatch(markup, /release-notes/u);
});

test("a catalogue whose role prompts were not read states no count", () => {
  // The catalogue is two independent reads, and the role prompts' read failed.
  // The entries that arrived are the commands, and their number is exactly
  // right for what arrived and incomplete for what the unread source would
  // have contributed, so the page states no total.
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: CATALOG,
      query: "",
      commandSourceValidity: true,
      rolePromptsObserved: false,
      validationIssues: []
    })
  );

  assert.match(markup, /data-prompts-observed="false"/u);
  assert.match(markup, /data-prompts-role-source-observed="false"/u);
  assert.match(
    markup,
    /Canonical Prompts<\/dt>[\s\S]*?>Not observed</u,
    "the catalogue's size is not known"
  );
  assert.match(
    markup,
    /Agent Role Prompts<\/dt>[\s\S]*?>Not observed</u,
    "the role prompts were not read, so their count is not known"
  );
  // The command catalogue was read, so its own count is a measurement.
  assert.match(markup, /RuleSync Commands<\/dt>[\s\S]*?>2</u);
  assert.match(
    markup,
    /The canonical role prompts were not observed/u,
    "the page says which read did not happen"
  );
});

test("an empty narrowed list says the query excluded everything", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: CATALOG,
      query: "nothing here",
      commandSourceValidity: true,
      rolePromptsObserved: true,
      validationIssues: []
    })
  );

  assert.match(
    markup,
    /No canonical prompts or commands found matching the current criteria\./u
  );
  // Not "no prompts are configured": the catalog holds 76 of them, and the
  // query is what removed them.
  assert.doesNotMatch(
    markup,
    /No canonical prompts or commands are configured\./u
  );
});

test("an empty catalog still says the catalog is empty", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: [],
      commandSourceValidity: true,
      rolePromptsObserved: true,
      validationIssues: []
    })
  );

  assert.match(markup, /No canonical prompts or commands are configured\./u);
});
