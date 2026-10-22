import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Button,
  DESTRUCTIVE_BUTTON_CLASS,
  OUTLINE_BUTTON_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from "../src/components/forms/Button.ts";
import {
  STATE_PILL_BUTTON_CLASS,
  STATE_PILL_TONE_CLASS
} from "../src/components/ui/state-pill.ts";

/**
 * The Console's control affordances.
 *
 * Two properties are pinned here, and both are the kind that look fine in the
 * source and wrong on the page.
 *
 * The pointer is the primary signal that a control is clickable. Every button
 * in the Console -- "Apply filters", "Reset to defaults", the provider row's
 * limit steppers -- rendered with the default arrow while looking and behaving
 * like a button, so the cursor contradicted the chrome on every page. The
 * Console's own newer surfaces spelled `cursor-pointer` inline instead, which
 * left the same role with two spellings and the shared vocabulary with none.
 *
 * A table header is a label, and the shared table contract says a column's
 * weight must be large enough for its own header. Two headers were smaller
 * than their own names: "Active Agents" wrapped to two lines, and "Requests"
 * pushed its help marker onto a line of its own, under the label it explains.
 * The same table header then measured 35.5px on twelve pages and 50.5px on
 * those two, so the header rhythm was not the Console's rhythm.
 */

const BUTTON_VARIANT_CLASSES = [
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  DESTRUCTIVE_BUTTON_CLASS,
  OUTLINE_BUTTON_CLASS
];

test("every button variant is a pointer target", () => {
  for (const variantClass of BUTTON_VARIANT_CLASSES) {
    assert.match(
      variantClass,
      /\bcursor-pointer\b/u,
      "a button that looks clickable must not show the default arrow"
    );
  }
});

test("a disabled button keeps the not-allowed cursor", () => {
  for (const variantClass of BUTTON_VARIANT_CLASSES) {
    assert.match(
      variantClass,
      /disabled:cursor-not-allowed/u,
      "a disabled control is still a target, and says so"
    );
  }
});

test("the rendered button carries the pointer and its own variant's class", () => {
  for (const [variant, variantClass] of [
    ["primary", PRIMARY_BUTTON_CLASS],
    ["secondary", SECONDARY_BUTTON_CLASS],
    ["destructive", DESTRUCTIVE_BUTTON_CLASS],
    ["outline", OUTLINE_BUTTON_CLASS]
  ] as const) {
    const markup = renderToStaticMarkup(
      React.createElement(Button, { variant }, "Apply filters")
    );
    assert.match(markup, /\bcursor-pointer\b/u);
    for (const token of variantClass.split(" ")) {
      assert.ok(
        markup.includes(token),
        `the ${variant} button must carry "${token}"`
      );
    }
  }
});

/**
 * A control that shows a state and can change it is one control, not two.
 *
 * The agent enablement pill and the model enablement pill were the same
 * control written twice -- the same chrome string, the same three tones, and
 * the same paragraph explaining why the hover strengthens the border instead
 * of tinting the fill. Two features changing the same vocabulary is how they
 * drift apart, and they had already drifted: neither spelling carried a
 * pointer cursor, so a control that shows a state and takes a click still
 * pointed at nothing.
 */
test("the state-coloured button is one vocabulary, and it is a pointer target", () => {
  assert.match(
    STATE_PILL_BUTTON_CLASS,
    /\bcursor-pointer\b/u,
    "a pill that applies a change is a pointer target"
  );
  assert.match(STATE_PILL_BUTTON_CLASS, /disabled:cursor-not-allowed/u);

  // The two features must not spell the vocabulary themselves.
  for (const source of [
    "../src/features/agents/AgentEnablementControl.ts",
    "../src/features/providers/ModelToggle.ts"
  ]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.match(
      text,
      /STATE_PILL_BUTTON_CLASS/u,
      `${source} must use the shared state-pill vocabulary`
    );
    assert.doesNotMatch(
      text,
      /bg-success\/15 text-success border-success\/60/u,
      `${source} must not spell the tones itself`
    );
  }
});

test("the three state tones are the ones the pill has always had", () => {
  assert.deepEqual(Object.keys(STATE_PILL_TONE_CLASS).sort(), [
    "off",
    "on",
    "unknown"
  ]);
  assert.match(STATE_PILL_TONE_CLASS.on, /text-success/u);
  assert.match(STATE_PILL_TONE_CLASS.off, /text-warning/u);
  assert.match(STATE_PILL_TONE_CLASS.unknown, /text-fg-muted/u);
});

/**
 * The help marker explains the label it sits beside, so the two are one unit.
 *
 * They were two inline spans, which left the line break as the only thing
 * between them: when a column was a few pixels too narrow the marker dropped
 * onto a line of its own. A flex row keeps them together -- the label still
 * wraps inside itself, and the marker stays beside it.
 */
test("a column help marker is bound to its label rather than floating after it", () => {
  const source = readFileSync(
    new URL("../src/components/tables/DataTable.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /data-column-header/u,
    "the header label and its marker must share a group"
  );
  assert.match(source, /"flex items-start gap-1\.5"/u);
  assert.doesNotMatch(
    source,
    /"ml-1\.5 inline-flex cursor-help/u,
    "the marker's spacing is the group's gap now, not a margin that can separate it"
  );
  assert.match(
    source,
    /shrink-0/u,
    "the marker must not be the part that shrinks"
  );
});
