import assert from "node:assert/strict";
import test from "node:test";

import type { PromptAsset, RuleSyncValidationIssue } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../src/components/layout/Callout.ts";
import { PromptsView } from "../src/features/prompts/PromptsView.ts";

/**
 * The command-source notice on `/prompts` carried its class as the literal
 * string `` "`${CALLOUT_ERROR_CLASS} mb-3`" `` -- a template literal wrapped in
 * plain quotes -- and the two constants were never imported at all. The element
 * still rendered its text and its `role`, so the page looked functional; it just
 * carried `class="${CALLOUT_ERROR_CLASS} mb-3"` instead of a toned callout,
 * where every other failure state on the Console is one.
 *
 * Nothing caught it because the branch only runs when `commandSourceValidity`
 * is `false` or `null`, and the page is normally valid. These force both
 * degraded states, which is the only way the class can be observed at all.
 */

const ISSUE: RuleSyncValidationIssue = {
  location: ".rulesync/commands/broken.md",
  message: "Missing frontmatter."
};

function render(validity: boolean | null): string {
  const commands: PromptAsset[] = [];
  return renderToStaticMarkup(
    React.createElement(PromptsView, {
      commands,
      commandSourceValidity: validity,
      validationIssues: validity === false ? [ISSUE] : []
    })
  );
}

test("an invalid command source renders a toned error callout, not a literal", () => {
  const markup = render(false);
  assert.match(
    markup,
    new RegExp(`class="${CALLOUT_ERROR_CLASS.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}`),
    "the error tone must be applied; a literal ${...} means the template was quoted"
  );
  assert.doesNotMatch(markup, /\$\{CALLOUT_/u, "no template source may leak into class");
  assert.match(markup, /role="alert"/u);
  assert.match(markup, /data-prompt-source-validity="invalid"/u);
  assert.match(markup, /RuleSync `.rulesync\/commands\/` is invalid/u);
});

test("an unobserved command source renders a toned warning callout", () => {
  const markup = render(null);
  assert.match(
    markup,
    new RegExp(`class="${CALLOUT_WARNING_CLASS.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}`)
  );
  assert.doesNotMatch(markup, /\$\{CALLOUT_/u);
  assert.match(markup, /role="status"/u);
  assert.match(markup, /data-prompt-source-validity="not-observed"/u);
});

test("a valid command source renders no source notice at all", () => {
  const markup = render(true);
  assert.doesNotMatch(markup, /data-prompt-source-validity/u);
});

test("the catalog panel carries its section hook", () => {
  // Every other list and detail view marks its panels; without it a browser
  // audit asking "did any section render empty?" finds zero sections here and
  // reports success for the wrong reason.
  assert.match(render(true), /data-section="prompts-catalog"/u);
});