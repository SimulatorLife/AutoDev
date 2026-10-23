import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppNav } from "../src/components/navigation/AppNav.ts";

const CONSOLE_ROOT = join(import.meta.dirname, "..");
const STYLESHEET = join(CONSOLE_ROOT, "app", "globals.css");

/**
 * The navigation's narrow-viewport default.
 *
 * The sidebar's default depends on the viewport: a rail on a narrow screen, the
 * full navigation on a wide one. That default was decided in a post-hydration
 * effect, so the server-rendered page painted the *expanded* navigation first.
 * Measured in Chromium at 390x844, that first paint is 256px of opaque panel
 * over a 390px viewport -- 66% of the screen -- with the page's own `h1` at
 * x=175, underneath it. The stat cards were cut in half, and without
 * JavaScript the panel stayed: 134px of page visible, and the page's title
 * unreachable.
 *
 * The default is a stylesheet decision now. JavaScript carries only the
 * operator's explicit choice, and the stylesheet decides the rest at first
 * paint -- so there is no flash on a phone, and the page is usable without
 * JavaScript at all.
 */
test("the server-rendered navigation says the viewport decides, not the component", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AppNav, { activeSection: "Agents" })
  );

  assert.match(
    markup,
    /data-nav-preference="auto"/u,
    "the default must be the viewport's decision, so the stylesheet can make it at first paint"
  );
  assert.match(
    markup,
    /data-nav-label="true"/u,
    "the labels must be reachable by the stylesheet that hides them in the rail"
  );
  assert.match(
    markup,
    /data-nav-rail-only="true"/u,
    "the rail's short brand mark must be reachable by the stylesheet that shows it"
  );
  assert.match(
    markup,
    /data-nav-collapsed="false"/u,
    "the component's own state is observable, so a test can tell it from the stylesheet's"
  );
});

test("the narrow-viewport default is a stylesheet rule, so the first paint is already right", () => {
  const css = readFileSync(STYLESHEET, "utf8");
  const narrowStart = css.indexOf("@media (max-width: 1279px)");
  assert.ok(
    narrowStart !== -1,
    "the stylesheet must state the narrow viewport's default"
  );
  const narrow = css.slice(narrowStart);

  assert.match(
    narrow,
    /nav\[data-nav-preference="auto"\]/u,
    "the rule must apply to the default, and only to the default"
  );
  assert.match(
    narrow,
    /position: relative/u,
    "the navigation must sit beside the page, not over it"
  );
  assert.match(
    narrow,
    /width: 3\.5rem/u,
    "the narrow default is the rail, not the full navigation"
  );
  assert.match(
    narrow,
    /\[data-nav-label\][^}]*display: none/u,
    "the rail shows icons, and the labels belong to the expanded navigation"
  );
  assert.match(
    narrow,
    /\[data-nav-rail-only\][^}]*display: inline/u,
    "the rail's short brand mark belongs to the rail"
  );
  assert.doesNotMatch(
    narrow,
    /nav\[data-nav-preference="(collapsed|expanded)"\]/u,
    "the operator's explicit choice is the component's business, not the stylesheet's"
  );
});

test("the wide viewport keeps the full navigation beside the page", () => {
  const css = readFileSync(STYLESHEET, "utf8");
  const narrowStart = css.indexOf("@media (max-width: 1279px)");
  const narrow = css.slice(narrowStart);
  assert.doesNotMatch(
    narrow,
    /@media \(min-width: 1280px\)/u,
    "the wide viewport is the expanded navigation by default, and needs no rule of its own"
  );
});
