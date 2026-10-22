import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ControlFailureNotice } from "../src/components/status/ControlFailureNotice.ts";

/**
 * The page's own refusal notice.
 *
 * The Console has one owner for the countdown that ends a result: the root
 * feedback owner, which announces a write's outcome, counts the five seconds
 * down, and sends the operator here for the reason -- "The server could not
 * save these changes. Review the notice on this page."
 *
 * This notice is that reason, so it stays while the operator acts on it. A
 * second countdown here would end the notice before the reason could be read,
 * leave the root feedback pointing at nothing, and give the Console two sets
 * of words for one behaviour.
 */
test("the refusal notice names the reason the route observed", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ControlFailureNotice, {
      refusal: "confirmation_missing"
    })
  );

  assert.match(
    markup,
    /data-control-outcome="failed"/u,
    "the notice must say the change did not land"
  );
  assert.match(
    markup,
    /data-control-refusal="confirmation_missing"/u,
    "the notice must carry the reason the route observed"
  );
  const detail =
    /data-control-refusal-detail[^>]*>([^<]+)/u.exec(markup)?.[1] ?? "";
  assert.ok(
    detail.length > 30,
    `the reason must be spelled out, got: ${JSON.stringify(detail)}`
  );
});

test("the notice carries no countdown of its own", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ControlFailureNotice, {
      refusal: "confirmation_missing"
    })
  );

  // The countdown belongs to the root feedback owner. The notice is the
  // reason that owner points at, so it has to still be there when the owner
  // has gone.
  assert.doesNotMatch(
    markup,
    /data-feedback-countdown/u,
    "the root feedback owner owns the countdown; a second one would end the reason"
  );
  assert.doesNotMatch(
    markup,
    /Dismisses in|Dismissing in/u,
    "the countdown is written one way, by the owner that owns it"
  );
  assert.doesNotMatch(
    markup,
    /Dismiss/u,
    "the notice is not dismissed by a second close control; the owner has one"
  );
});

test("the notice is announced once, with its reason", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ControlFailureNotice, {
      refusal: "confirmation_missing"
    })
  );

  assert.match(markup, /role="status"/u, "the notice must be announced");
  assert.equal(
    markup.match(/role="status"/gu)?.length,
    1,
    "the notice must not announce itself through two live regions"
  );
  assert.match(
    markup,
    /could not be confirmed/u,
    "the notice must say the change is unconfirmed"
  );
});

test("a notice with no reason does not grow a detail line", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ControlFailureNotice)
  );
  assert.doesNotMatch(
    markup,
    /data-control-refusal-detail/u,
    "the shared notice must not grow a detail line it has no reason for"
  );
  assert.match(markup, /could not be confirmed/u);
});
