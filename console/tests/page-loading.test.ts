import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConsoleLoadingPage } from "../src/components/layout/AppShell.ts";

test("route loading fallback keeps the active shell and announces pending data", () => {
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

test("the Console route loading boundary renders the shared shell", () => {
  const source = readFileSync(
    new URL("../app/loading.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /ConsoleLoadingShell/u);
});
