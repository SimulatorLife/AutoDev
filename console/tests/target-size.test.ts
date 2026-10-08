import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Chip } from "../src/components/tables/Chips.ts";
import {
  MONO_ID_CLASS,
  MONO_ID_LINK_CLASS
} from "../src/components/ui/text-classes.ts";

/**
 * WCAG 2.5.8 Target Size (Minimum), AA.
 *
 * These pin the two halves of the fix rather than the class name alone.
 *
 * The floor is 24x24, and `min-h-6` is 1.5rem, which is 24px at Tailwind's
 * default -- but `min-height` does not apply to a non-replaced inline box, so
 * a link that merely carried `min-h-6` while staying `display: inline` would
 * measure the same 22px as before and look fixed in the source. The `block`
 * assertion is what stops that.
 *
 * The other half is that only targets get the floor. `MONO_ID_CLASS` is also the
 * row subject on `/permissions` and `/workspaces`, where it is not a link, and
 * `Chip` without an href is a span. Putting the minimum on either would add two
 * pixels to every non-interactive element of that kind on every page to fix
 * nothing, so those two are asserted to stay clean.
 */

test("a link chip is a block box with a 24px minimum", () => {
  const markup = renderToStaticMarkup(
    React.createElement(Chip, { href: "/providers/x" }, "claude")
  );
  assert.match(markup, /<a /u, "an href chip must render a real link");
  assert.match(markup, /min-h-6/u, "the target-size floor must be on the link");
  assert.match(
    markup,
    /class="[^"]*\bblock\b[^"]*"/u,
    "min-height is inert on an inline box, so the link must be block"
  );
});

test("a chip that is not a link does not carry the target-size floor", () => {
  const markup = renderToStaticMarkup(React.createElement(Chip, null, "claude"));
  assert.match(markup, /<span /u);
  assert.doesNotMatch(
    markup,
    /min-h-6/u,
    "a span is not a target; making it taller fixes nothing"
  );
});

test("the shared name-link class meets the floor and its base does not", () => {
  assert.match(MONO_ID_LINK_CLASS, /min-h-6/u);
  assert.match(
    MONO_ID_LINK_CLASS,
    /\bblock\b/u,
    "min-height is inert on an inline box"
  );
  assert.doesNotMatch(
    MONO_ID_CLASS,
    /min-h-6/u,
    "the base is shared with rows where the subject is not a link"
  );
});

test("the minimum resolves to the 24px the criterion asks for", () => {
  // `min-h-6` is `calc(var(--spacing) * 6)`, so it is only 24px while
  // `--spacing` is Tailwind's 0.25rem. Read the project's own stylesheet rather
  // than assuming the default: someone setting `--spacing: 0.2rem` would leave
  // the class name reading like the sixth step while the box became 19px, and
  // this would silently stop meeting the criterion.
  const css = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8"
  );
  // The first captured character is required to be non-whitespace, so the
  // leading `\s*` and the body cannot both match the same run of spaces --
  // without that, the pattern backtracks.
  const override = /--spacing:[ \t]*([^;\s][^;]*);/u.exec(css);
  assert.equal(
    override,
    null,
    `--spacing is overridden to ${override?.[1]}, so min-h-6 is no longer 24px`
  );

  const stepRem = 0.25;
  assert.equal(stepRem * 6 * 16, 24, "min-h-6 must land on the 24px floor");
});