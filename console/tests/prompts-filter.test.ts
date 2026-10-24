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
      totalCommands: 76,
      query: "",
      commandSourceValidity: true,
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
      commands: [CATALOG[0]!],
      totalCommands: 76,
      query: "code-review",
      commandSourceValidity: true,
      validationIssues: []
    })
  );

  assert.match(markup, /1 of 76 prompts and commands/u);
  // The search control keeps what the operator typed, so the second narrowing
  // starts from the first rather than from nothing.
  assert.match(markup, /value="code-review"/u);
});

test("an empty narrowed list says the query excluded everything", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands: [],
      totalCommands: 76,
      query: "nothing here",
      commandSourceValidity: true,
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
      totalCommands: 0,
      commandSourceValidity: true,
      validationIssues: []
    })
  );

  assert.match(markup, /No canonical prompts or commands are configured\./u);
});
