import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TraceStatus } from "../src/components/traces/TraceStatus.ts";

test("TraceStatus gives Usage and Evaluations one observed, semantic status label", () => {
  const expected = [
    ["OK", "text-success", "OK"],
    ["ERROR", "text-error", "ERROR"],
    ["UNSET", "text-fg-secondary", "Unset"],
    ["UNKNOWN", "text-fg-secondary", "UNKNOWN"]
  ] as const;

  for (const [statusCode, tone, label] of expected) {
    const markup = renderToStaticMarkup(
      React.createElement(TraceStatus, { statusCode })
    );
    assert.match(markup, new RegExp(`class="font-mono text-xs ${tone}"`));
    assert.match(markup, new RegExp(`data-trace-status="${statusCode}"`));
    assert.match(markup, new RegExp(`>${label}<`));
  }
});
