import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QUIET_BUTTON_CLASS } from "../src/components/forms/Button.ts";
import { CheckboxField } from "../src/components/forms/CheckboxField.ts";
import { SelectField } from "../src/components/forms/SelectField.ts";
import { TextField } from "../src/components/forms/TextField.ts";
import {
  CHECKBOX_CONTROL_CLASS,
  CHECKBOX_DESTRUCTIVE_CLASS,
  FIELD_CONTROL_CLASS,
  SELECT_CONTROL_CLASS,
  TEXT_CONTROL_CLASS
} from "../src/components/ui/field-classes.ts";

/**
 * Every feature source file, so a rule about feature views is checked against
 * all of them rather than against the ones somebody remembered.
 */
function featureSourceFiles(
  directory = fileURLToPath(new URL("../src/features/", import.meta.url))
): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...featureSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/u.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * The Console's control vocabulary.
 *
 * The Console fixed its buttons once -- "the cursor is the primary signal that a
 * thing is clickable" -- and left every other control spelling its own answer.
 * Every select in the product rendered with the default arrow while carrying
 * the Console's own drawn chevron and a border that reads as a target, so the
 * pointer contradicted the chrome on the page where an operator chooses a role
 * priority, a model, a workspace or a date range.
 *
 * The five checkboxes disagreed about everything: three sizes, two chromes, two
 * accents -- one of them `accent-error` on a box that was confirming rather
 * than destroying -- and not one of them showed the pointer. Two adjacent
 * checkboxes on different pages looked like two different products.
 *
 * Six buttons in the playtesting strand wore the *input* chrome, which reserves
 * 32px of right padding for a select chevron they never drew, so they were
 * neither a button nor an input. A control's chrome has to say what the control
 * does.
 *
 * The properties pinned here are the properties, not the class names: a select
 * shows the pointer, a text field shows the caret, a checkbox is one size with
 * one accent, and no button wears a form's chrome.
 */

/**
 * The shared chrome is chrome, not a cursor.
 *
 * One shared string can only ever spell one cursor, and spelling it for the
 * most common case gave the other two the wrong one. The chrome therefore
 * carries none of them, and each control role names its own.
 */
test("the shared control chrome carries no cursor of its own", () => {
  assert.doesNotMatch(
    FIELD_CONTROL_CLASS,
    /\bcursor-(?:pointer|text)\b/u,
    "the shared chrome cannot be one role's cursor"
  );
});

test("a select is a pointer target", () => {
  assert.match(
    SELECT_CONTROL_CLASS,
    /\bcursor-pointer\b/u,
    "a select opens a list, so it is a target"
  );
  assert.match(
    SELECT_CONTROL_CLASS,
    /disabled:cursor-not-allowed/u,
    "a disabled control is still a target, and says so"
  );
});

test("a text field shows the caret, not the pointer", () => {
  assert.match(
    TEXT_CONTROL_CLASS,
    /\bcursor-text\b/u,
    "a field that takes text is not a field that opens a list"
  );
  assert.doesNotMatch(TEXT_CONTROL_CLASS, /\bcursor-pointer\b/u);
});

test("a checkbox is one chrome, one size, one accent, and a pointer target", () => {
  assert.match(
    CHECKBOX_CONTROL_CLASS,
    /\bcursor-pointer\b/u,
    "a square that reads as a target has to answer with the pointer"
  );
  assert.match(
    CHECKBOX_CONTROL_CLASS,
    /\bsize-4\b/u,
    "one size for every checkbox in the product"
  );
  assert.match(
    CHECKBOX_CONTROL_CLASS,
    /\baccent-accent\b/u,
    "one accent for every checkbox in the product"
  );
  assert.match(CHECKBOX_CONTROL_CLASS, /disabled:cursor-not-allowed/u);
  assert.match(
    CHECKBOX_DESTRUCTIVE_CLASS,
    /\baccent-error\b/u,
    "the destructive accent is opt-in, for a box that confirms an irreversible action"
  );
});

test("the rendered select shows the pointer and the rendered field shows the caret", () => {
  const select = renderToStaticMarkup(
    React.createElement(SelectField, {
      name: "role",
      label: "Role",
      options: [{ value: "smart", label: "Smart" }]
    })
  );
  assert.match(select, /\bcursor-pointer\b/u);

  const text = renderToStaticMarkup(
    React.createElement(TextField, { name: "query", label: "Search" })
  );
  assert.match(text, /\bcursor-text\b/u);
  assert.doesNotMatch(text, /\bcursor-pointer\b/u);
});

test("the rendered checkbox is a pointer target whose name is the visible label", () => {
  const markup = renderToStaticMarkup(
    React.createElement(CheckboxField, {
      name: "confirm",
      value: "true",
      label: "Confirm clearing role overrides"
    })
  );
  assert.match(markup, /type="checkbox"/u);
  assert.match(markup, /\bcursor-pointer\b/u);
  assert.match(
    markup,
    />Confirm clearing role overrides</u,
    "the visible label is the accessible name"
  );
  assert.match(
    markup,
    /min-h-6/u,
    "the label is the target, so it meets the 24px floor the link chips meet"
  );
});

test("the destructive checkbox is the only one that wears the destructive accent", () => {
  const destructive = renderToStaticMarkup(
    React.createElement(CheckboxField, {
      name: "confirm",
      value: "purge",
      tone: "destructive",
      label: "I understand this permanently erases this envelope."
    })
  );
  assert.match(destructive, /\baccent-error\b/u);

  const ordinary = renderToStaticMarkup(
    React.createElement(CheckboxField, {
      name: "confirm",
      value: "true",
      label: "Confirm clearing role overrides"
    })
  );
  assert.doesNotMatch(ordinary, /\baccent-error\b/u);
});

test("two checkboxes under one field name do not share an id", () => {
  // The Skills page renders one checkbox per assignable role under the same
  // field name. A derived id would be on the page several times over, and a
  // duplicated id makes the label's `for` name the first control rather than
  // the one it belongs to.
  const markup = renderToStaticMarkup(
    React.createElement(
      "div",
      null,
      React.createElement(CheckboxField, {
        name: "roles",
        value: "worker",
        label: "worker"
      }),
      React.createElement(CheckboxField, {
        name: "roles",
        value: "auditor",
        label: "auditor"
      })
    )
  );
  const ids = Array.from(
    markup.matchAll(/\sid="([^"]*)"/gu),
    (match) => match[1]
  );
  assert.equal(
    new Set(ids).size,
    ids.length,
    "a duplicated id makes the label name the wrong control"
  );
});

test("the shared select draws the shared chevron", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SelectField, {
      name: "role",
      label: "Role",
      options: [{ value: "smart", label: "Smart" }]
    })
  );
  assert.match(markup, /\bcursor-pointer\b/u);
  assert.match(
    markup,
    /pointer-events-none/u,
    "the decoration never intercepts the click that opens the list"
  );
  assert.match(
    markup,
    /aria-hidden="true"/u,
    "the chevron is decoration, so it is hidden from the reader"
  );
});

test("a select wears the shared chrome and draws the shared chevron", () => {
  for (const source of [
    "../src/features/playtesting/PlaytestingRunControls.tsx",
    "../src/features/playtesting/PlaytestingRunDashboard.tsx",
    "../src/features/playtesting/PlaytestComparisonDecisionForm.ts",
    "../src/features/workspaces/WorkspaceVisualPlaytestTargetManager.ts"
  ]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.match(
      text,
      /SELECT_CONTROL_CLASS/u,
      `${source} must use the shared select chrome`
    );
    assert.match(
      text,
      /SelectChevron/u,
      `${source} must draw the shared chevron`
    );
    // The shared chrome reserves 32px of right padding for the chevron. A
    // select that spells its own chrome has no chevron, so it reads as a text
    // field with a gap in it -- and it carries a second focus treatment, which
    // the product's one canonical focus ring forbids.
    for (const match of text.matchAll(
      /createElement\(\s*"select",\s*\{[\s\S]{0,400}?className:\s*([^,\n]+)/gu
    )) {
      assert.match(
        match[1] ?? "",
        /SELECT_CONTROL_CLASS/u,
        `${source} must not spell a select's chrome itself`
      );
    }
  }
});

test("a text control wears the shared chrome and no second focus ring", () => {
  for (const source of [
    "../src/features/playtesting/PlaytestingRunDashboard.tsx",
    "../src/features/playtesting/PlaytestComparisonDecisionForm.ts"
  ]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.match(
      text,
      /TEXT_CONTROL_CLASS/u,
      `${source} must use the shared text chrome`
    );
    assert.doesNotMatch(
      text,
      /focus:ring-accent/u,
      `${source} must not declare a second focus treatment; the product has one canonical focus ring`
    );
  }
});

test("the features do not spell the checkbox chrome themselves", () => {
  for (const source of [
    "../src/features/memory/MemoryExperiencesView.ts",
    "../src/features/skills/SkillRoleAssignmentControl.ts",
    "../src/features/workspaces/WorkspaceVisualPlaytestTargetManager.ts",
    "../src/features/playtesting/PlaytestingSessionsWorkspace.ts"
  ]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.doesNotMatch(
      text,
      /accent-(?:accent|error)/u,
      `${source} must not spell a checkbox accent itself`
    );
    assert.match(
      text,
      /CheckboxField|CHECKBOX_CONTROL_CLASS/u,
      `${source} must use the shared checkbox vocabulary`
    );
  }
});

test("a button does not wear the form input chrome", () => {
  for (const source of [
    "../src/features/playtesting/PlaytestingActiveRunsPanel.ts",
    "../src/features/playtesting/PlaytestingSelectionPanel.ts"
  ]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.doesNotMatch(
      text,
      /FIELD_CONTROL_CLASS/u,
      `${source} must not put a form's chrome on a button`
    );
    assert.match(
      text,
      /components\/forms\/Button\.ts/u,
      `${source} must use the shared button vocabulary`
    );
  }
});

/**
 * The quiet button, and the one focus ring.
 *
 * The quiet chrome was spelled out seven times across the playtesting strand
 * before it became a member of the button family, and the copies had drifted:
 * two carried a hover surface, one carried a hover that named a token the
 * theme has never had -- so its hover never happened -- and the rest had no
 * hover at all, which is why a quiet button in one panel answered the pointer
 * and the same button in another panel did not.
 *
 * The focus ring is the other half of the same rule. The product has one
 * canonical focus ring, in `app/globals.css`, and a feature view that declares
 * a focus treatment of its own has replaced it: `focus:ring-1 focus:ring-accent`
 * on a text field is a second ring in a different colour, and `focus:outline-none`
 * suppresses the canonical one before it does.
 */
test("a quiet button wears the shared chrome", () => {
  assert.match(
    QUIET_BUTTON_CLASS,
    /hover:bg-hover/u,
    "the quiet button shows the product's hover surface"
  );
  assert.match(QUIET_BUTTON_CLASS, /cursor-pointer/u);

  for (const source of [
    "../src/features/playtesting/PlaytestingRunControls.tsx",
    "../src/features/playtesting/PlaytestingRunDashboard.tsx",
    "../src/features/playtesting/PlaytestingReadiness.tsx"
  ]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.doesNotMatch(
      text,
      /rounded-md border border-border px-3 py-2/u,
      `${source} must not spell a quiet button's chrome itself`
    );
    assert.match(
      text,
      /variant[:=]\s*"quiet"/u,
      `${source} must use the shared quiet button`
    );
  }
});

test("no feature view declares a focus ring of its own", () => {
  const featureFiles = featureSourceFiles();
  assert.ok(featureFiles.length > 0, "the feature sources must be readable");
  for (const file of featureFiles) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /focus(?:-visible)?:(?:ring|outline)-/u,
      `${file} must not declare a second focus treatment; the product has one canonical focus ring`
    );
    assert.doesNotMatch(
      text,
      /focus:outline-none/u,
      `${file} must not suppress the canonical focus ring`
    );
  }
});
