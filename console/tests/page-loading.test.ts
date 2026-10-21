import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConsoleLoadingBody } from "../src/components/layout/ConsoleLoadingBody.ts";

test("the page's loading placeholder announces pending data", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConsoleLoadingBody, { activeSection: "Providers" })
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

test("no Console route owns a route-level loading boundary", () => {
  // A route-level boundary splits the route segment itself: the shell and
  // the page arrive as two answers, the segment is replaced in the middle of
  // the navigation, and the navigation's commit -- the one that moves the
  // address bar -- goes with it. The pending state belongs to the page, so
  // the route segment stays whole.
  assert.equal(
    existsSync(new URL("../app/loading.tsx", import.meta.url)),
    false
  );
});

test("the pending state belongs to the page, and the page renders it", () => {
  const source = readFileSync(
    new URL("../app/_console.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /export function ConsolePendingPage/u);
  // The pending shell is the boundary's fallback: the operator sees the
  // surface they asked for while the page's own read is on its way, and the
  // final page replaces it with the confirmed content and counts.
  assert.match(
    source,
    /fallback: React\.createElement\(ConsoleLoadingShell\)/u
  );

  const page = readFileSync(
    new URL("../app/providers/page.tsx", import.meta.url),
    "utf8"
  );
  assert.match(page, /ConsolePendingPage/u);
  assert.doesNotMatch(page, /ConsolePage\b(?!Shell)/u);
});
