import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ResourceUnavailable } from "../app/_console.ts";
import { catalogueDetailOutcome } from "../src/lib/server/catalogue-detail.ts";

/**
 * A slow read is not a misconfigured integration.
 *
 * The Control API distinguishes the two already: a read abandoned at the
 * Console's own deadline carries `autodev_control_api_timeout`, because the
 * service is reachable and holding the connection open. Telling the operator to
 * "configure the required server-side integration" in that case sends them to
 * reconfigure a credential that is working, instead of looking at why the query
 * is slow.
 *
 * `/evaluations` draws the distinction for itself. Every other route that
 * reads the Control API -- twenty of them -- renders the shared shell, so the
 * shell has to carry the advice once rather than each route having to
 * remember it.
 */
test("a read abandoned at the deadline is not told to reconfigure the integration", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ResourceUnavailable, {
      title: "Providers could not be loaded",
      code: "autodev_control_api_timeout",
      message: "The AutoDev Control API did not answer within 5s."
    })
  );
  assert.match(markup, /did not answer before the Console gave up/u);
  assert.doesNotMatch(
    markup,
    /Configure the required server-side integration/u,
    "a slow read is not a misconfigured integration"
  );
});

test("a service that is not there is still told to configure the integration", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ResourceUnavailable, {
      title: "Providers could not be loaded",
      code: "autodev_unreachable",
      message: "The AutoDev Control API could not be reached."
    })
  );
  assert.match(
    markup,
    /Configure the required server-side integration/u,
    "a service that is not there is the case the default advice is for"
  );
});

test("a route that knows better than the shell keeps its own advice", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ResourceUnavailable, {
      title: "Evaluations timed out",
      code: "autodev_control_api_timeout",
      message: "The AutoDev Control API did not answer within 5s.",
      hint: "Check whether the evaluations query is slow against the telemetry store."
    })
  );
  assert.match(markup, /evaluations query is slow/u);
  assert.doesNotMatch(
    markup,
    /Configure the required server-side integration/u,
    "an explicit hint wins over the shell's default"
  );
});

test("a declaration that could not be applied is not a missing integration", () => {
  // The Runtime published the declaration and could not apply it. The service
  // answered, so the advice "configure the required server-side integration"
  // sends the operator to repair a credential that is working.
  const markup = renderToStaticMarkup(
    React.createElement(ResourceUnavailable, {
      title: "Hook event could not be read",
      code: "autodev_console_hooks_catalogue_invalid",
      message: "The hook declaration could not be applied."
    })
  );
  assert.doesNotMatch(
    markup,
    /Configure the required server-side integration/u,
    "the service answered, so its configuration is not what is broken"
  );
  assert.match(
    markup,
    /The reason above is what to act on/u,
    "the shell says what is true of a read it could not complete"
  );
});

test("a catalogue nobody read is not a missing integration either", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ResourceUnavailable, {
      title: "Hook event could not be read",
      code: "autodev_console_hooks_catalogue_not_observed",
      message: "The canonical hook declaration was not observed."
    })
  );
  assert.doesNotMatch(
    markup,
    /Configure the required server-side integration/u,
    "nothing was read, which is not a thing an operator configures away"
  );
  assert.match(markup, /The reason above is what to act on/u);
});

test("a catalogue refusal carries the advice the catalogue knows", () => {
  // The catalogue knows which of the two happened -- a declaration that could
  // not be applied, or a read that did not answer -- and the two have
  // different remedies.
  const applied = catalogueDetailOutcome({
    subject: "Hook event",
    source: "canonical hook declaration",
    invalidCode: "autodev_console_hooks_catalogue_invalid",
    unobservedCode: "autodev_console_hooks_catalogue_not_observed",
    observation: { kind: "invalid", reason: null }
  });
  assert.equal(applied.kind, "unavailable");
  assert.match(
    applied.kind === "unavailable" ? applied.hint : "",
    /could not apply/u
  );
  assert.doesNotMatch(
    applied.kind === "unavailable" ? applied.hint : "",
    /Configure the required server-side integration/u
  );

  const notObserved = catalogueDetailOutcome({
    subject: "Hook event",
    source: "canonical hook declaration",
    invalidCode: "autodev_console_hooks_catalogue_invalid",
    unobservedCode: "autodev_console_hooks_catalogue_not_observed",
    observation: { kind: "not-observed", reason: null }
  });
  assert.equal(notObserved.kind, "unavailable");
  assert.match(
    notObserved.kind === "unavailable" ? notObserved.hint : "",
    /Nothing was read/u
  );
});
