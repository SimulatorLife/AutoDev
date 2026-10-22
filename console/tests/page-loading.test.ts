import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConsoleLoadingPage } from "../src/components/layout/AppShell.ts";

/**
 * The routes that read server-owned data, and therefore have a pending state
 * to show.
 */
const DATA_READING_ROUTES = [
  "agents/[id]/page.tsx",
  "agents/page.tsx",
  "evaluations/page.ts",
  "github/page.tsx",
  "hooks/page.tsx",
  "mcps/[name]/page.tsx",
  "mcps/page.tsx",
  "memory/page.ts",
  "permissions/page.tsx",
  "prompts/[name]/page.ts",
  "prompts/page.tsx",
  "providers/[id]/models/[model]/page.tsx",
  "providers/[id]/page.tsx",
  "providers/page.tsx",
  "skills/[name]/page.tsx",
  "skills/page.tsx",
  "tools/[name]/page.tsx",
  "tools/page.tsx",
  "usage/page.ts",
  "workspaces/[owner]/[repository]/page.tsx",
  "workspaces/page.tsx"
];

function routeSource(relativePath: string): string {
  return readFileSync(
    new URL(`../app/${relativePath}`, import.meta.url),
    "utf8"
  );
}

test("the pending shell keeps the active shell and announces pending data", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConsoleLoadingPage, { activeSection: "Providers" })
  );
  assert.match(markup, /<h1[^>]*title="Providers">Providers<\/h1>/u);
  assert.match(
    markup,
    /<a\b(?=[^>]*data-nav-item="providers")(?=[^>]*aria-current="page")[^>]*>/u
  );
  assert.match(markup, /data-console-loading="Providers" aria-busy="true"/u);
  assert.match(
    markup,
    /role="status" aria-live="polite"[^>]*>Loading providers…<\/p>/u
  );
  assert.match(
    markup,
    /aria-hidden="true" class="grid grid-cols-1 gap-4 sm:grid-cols-3"/u
  );
});

test("no route segment owns the pending state", () => {
  // A boundary inside a segment changes what that segment's model contains:
  // the model resolves before the content it waits for, so the segment a
  // navigation replaces is no longer the segment the browser holds. The
  // navigation then waits on a chunk the browser has not read, and it does not
  // commit -- the address bar stays where it was.
  assert.equal(
    existsSync(new URL("../app/loading.tsx", import.meta.url)),
    false,
    "a route-level loading boundary splits the route segment a navigation replaces"
  );
  for (const route of DATA_READING_ROUTES) {
    const source = routeSource(route);
    assert.doesNotMatch(
      source,
      /ConsoleLoadingShell|ConsolePendingPage/u,
      `${route} owns the Console's pending state; the page's model must arrive with its content`
    );
    // The page awaits its own read. A page that starts the read and hands the
    // promise to a content component answers in two pieces -- the page's model
    // now, its content later -- and a navigation to that page waits on the
    // second piece. A page that awaits the read answers in one piece, and the
    // navigation has a whole page to apply.
    assert.doesNotMatch(
      source,
      /=\s*(?:fetch[A-Z][A-Za-z]*|load[A-Z][A-Za-z]*)\(/u,
      `${route} starts a read it does not await; the page's answer would arrive in two pieces`
    );
    // A boundary inside the segment is the same split from the other side. The
    // server answers the segment's shell first and the content behind the
    // boundary later, so the navigation to that segment waits on a chunk the
    // browser has not read, and its commit -- the commit that moves the address
    // bar -- never happens. The page awaits its read instead, and the layout's
    // boundary is the only one the Console owns.
    assert.doesNotMatch(
      source,
      /React\.Suspense|<Suspense\b/u,
      `${route} owns a boundary; the page's answer would arrive in two pieces`
    );
  }
});

test("the page's pending state belongs to the layout", () => {
  const layout = readFileSync(
    new URL("../app/layout.tsx", import.meta.url),
    "utf8"
  );
  assert.match(layout, /ConsoleLoadingShell/u);
  assert.match(layout, /React\.Suspense/u);
  // The boundary has to be in the layout's own model, and it has to be there
  // for every request. A layout is the one segment an in-place navigation does
  // not replace: the navigation re-sends the page's own segment and leaves the
  // layout's segment, and the boundary inside it, exactly where they were. The
  // page's answer therefore arrives whole, and the address bar and the page
  // move together. A boundary that appeared for some requests and not others
  // would leave the browser holding a layout the next response does not match.
  assert.doesNotMatch(layout, /headers\(\)/u);
  assert.doesNotMatch(layout, /get\("rsc"\)/u);
});
