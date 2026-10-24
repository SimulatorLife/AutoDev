import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HooksView } from "../src/features/hooks/HooksView.ts";

/**
 * A read that failed says why.
 *
 * The hooks page makes two reads: the canonical declaration and the
 * projection the Runtime published. They answer different questions, so one
 * of them failing says nothing about the other -- and the page keeps the
 * declaration when the projection cannot be read, which is right. What was
 * wrong was the silence: the applied section said "could not be read" and
 * nothing else, so an operator was left with a gap on the page and no
 * explanation for it, while the declaration's own failure says exactly what
 * went wrong.
 *
 * The reason is the failure's own vocabulary: the Control API's code and its
 * message, the same pair the resource-level failure renders.
 */

const DECLARATION = {
  event: "preToolUse" as const,
  origin: "shared" as const,
  actions: [
    { type: "command" as const, command: "echo guarded", matcher: "Bash" }
  ]
};

function renderHooks(appliedUnavailable?: {
  readonly code: string;
  readonly message: string;
}): string {
  return renderToStaticMarkup(
    React.createElement(HooksView, {
      hooks: [DECLARATION],
      sourceValidity: true,
      validationIssues: [],
      revision: "a".repeat(64),
      applied: null,
      ...(appliedUnavailable === undefined ? {} : { appliedUnavailable })
    })
  );
}

test("an unreadable applied projection says why", () => {
  const markup = renderHooks({
    code: "autodev_control_api_timeout",
    message: "The AutoDev Control API did not answer within 5s."
  });

  // The gap is still stated as a gap: nothing is claimed about what the
  // Runtime published.
  assert.match(markup, /Applied hooks: Not observed/u);
  assert.match(
    markup,
    /applied hook projection could not be read/u
  );
  // And now the reason for it, in the Control API's own vocabulary.
  assert.match(markup, /autodev_control_api_timeout/u);
  assert.match(markup, /did not answer within 5s/u);
});

test("an unreadable applied projection with no reason still says the gap", () => {
  // The reason is carried when there is one. A page that rendered the
  // declaration and had no reason to carry still has to say what it does not
  // know.
  const markup = renderHooks();

  assert.match(markup, /Applied hooks: Not observed/u);
  assert.match(
    markup,
    /applied hook projection could not be read/u
  );
});
