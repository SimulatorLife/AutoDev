import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ResourceUnavailable } from "../app/_console.ts";

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
