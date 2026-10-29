import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HooksView } from "../src/features/hooks/HooksView.ts";

/**
 * A count over the declared source is a number only when the source was read.
 *
 * The hooks page reads the canonical declaration, and an invalid or
 * unreadable one publishes an empty list of events. The cards above the table
 * counted that list: a target that declares no hooks and a target nobody read
 * are different claims, and only the first is a count. The card beside them
 * already said "Invalid" or "Not observed" -- the two cards that claimed a
 * number did not agree with it.
 */

const DECLARATION = {
  event: "preToolUse" as const,
  origin: "shared" as const,
  actions: [
    { type: "command" as const, command: "echo guarded", matcher: "Bash" }
  ]
};

function renderHooks(sourceValidity: boolean | null): string {
  return renderToStaticMarkup(
    React.createElement(HooksView, {
      hooks: [DECLARATION],
      sourceValidity,
      validationIssues: [],
      revision: "a".repeat(64),
      applied: null
    })
  );
}

test("the declaration's counts are numbers when the source was read", () => {
  const markup = renderHooks(true);

  assert.match(markup, /Hook Events<\/dt>[\s\S]*?>1</u);
  assert.match(markup, /Total Handlers<\/dt>[\s\S]*?>1</u);
});

test("an invalid declaration counts no hooks and says the source is invalid", () => {
  const markup = renderHooks(false);

  // Not "0": the declaration was read and found broken, and the list that came
  // back is empty because of that, not because the target declares nothing.
  assert.match(markup, /Hook Events<\/dt>[\s\S]*?>Invalid</u);
  assert.match(markup, /Total Handlers<\/dt>[\s\S]*?>Invalid</u);
  assert.doesNotMatch(markup, /Hook Events<\/dt>[\s\S]*?>0</u);
});

test("an unread declaration counts no hooks and says the source was not observed", () => {
  const markup = renderHooks(null);

  assert.match(markup, /Hook Events<\/dt>[\s\S]*?>Not observed</u);
  assert.match(markup, /Total Handlers<\/dt>[\s\S]*?>Not observed</u);
  assert.doesNotMatch(markup, /Hook Events<\/dt>[\s\S]*?>0</u);
});
