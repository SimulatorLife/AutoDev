import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type {
  EvaluationResult,
  UsageTraceDetail,
  UsageTraceSpan
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatDurationMs,
  formatSpanDuration
} from "../src/components/ui/duration.ts";
import { EvaluationsView } from "../src/features/evaluations/EvaluationsView.ts";
import { UsageView } from "../src/features/usage/UsageView.ts";

const SPAN_ID = "0123456789abcdef";
const TRACE_ID = "0123456789abcdef0123456789abcdef";

/**
 * One span, at each magnitude the formatter has to choose a unit for.
 *
 * The first one is the case the two formatters disagreed about hardest: a
 * span of a third of a microsecond used to be rendered "0 µs" on the
 * Evaluations trace panel, which claims the span took no time at all.
 */
const SPANS: readonly (readonly [number, string])[] = [
  [300, "1 µs"],
  [940_000_000, "940 ms"],
  [1_500_000_000, "1.5 s"],
  [119_900_000_000, "2m 0s"]
];

function traceDetail(): UsageTraceDetail {
  return {
    schema: "autodev-openlit-trace-detail-v1",
    traceId: TRACE_ID,
    selectedSpanId: SPAN_ID,
    partial: false,
    spans: SPANS.map(([durationNs], index): UsageTraceSpan => ({
      spanId: `${index}`.padStart(16, "0"),
      parentSpanId: null,
      spanName: "autodev.logical_request",
      serviceName: "autodev-router",
      timestamp: "2026-10-07T12:00:00.000Z",
      durationNs,
      statusCode: "OK"
    }))
  };
}

const evaluation: EvaluationResult = {
  id: "run-1",
  spanId: SPAN_ID,
  agentRole: "orchestrator",
  promptName: "review",
  model: "gpt-6-luna",
  metrics: [],
  passed: null,
  timestamp: "2026-10-07T12:00:00.000Z"
};

test("a duration steps its unit and never rounds a real measurement to zero", () => {
  assert.equal(formatDurationMs(0), "0 ms");
  assert.equal(formatDurationMs(0.004), "4 µs");
  assert.equal(formatDurationMs(12.34), "12.3 ms");
  assert.equal(formatDurationMs(1250), "1.3 s");
  assert.equal(formatDurationMs(120_400), "2m 0s");
  // A minute boundary stays visible: two durations a second apart must not
  // read the same, which is what the split exists for.
  assert.equal(formatDurationMs(119_400), "1m 59s");
  assert.equal(formatDurationMs(119_900), "2m 0s");
  assert.equal(formatDurationMs(3_888_000), "1.1 h");

  // A span that took a third of a microsecond is below the display
  // resolution, but it is not zero, and the reading says so.
  assert.equal(formatSpanDuration(300), "1 µs");
  assert.equal(formatSpanDuration(300_000), "300 µs");
  // A span that took no time says exactly that.
  assert.equal(formatSpanDuration(0), "0 ms");
});

test("the same span duration reads the same on the Usage trace and the Evaluations trace", () => {
  // Both panels read the same source value -- a span's `durationNs` -- so
  // they have to render it the same way. They did not: the Evaluations
  // panel had a formatter of its own, and the two disagreed on every
  // magnitude, including rendering a span that took time as "0 µs".
  const detail = traceDetail();
  const usage = renderToStaticMarkup(
    React.createElement(UsageView, {
      selection: { range: "24H", values: {} },
      traceLookup: { kind: "observed", detail }
    })
  );
  const evaluations = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      evaluations: [evaluation],
      filters: {
        outcome: "all",
        role: "",
        model: "",
        prompt: "",
        from: "",
        until: ""
      },
      filterOptions: { roles: [], models: [], prompts: [] },
      selection: evaluation.id,
      spanId: SPAN_ID,
      traceLookup: { kind: "observed", detail }
    })
  );

  for (const [durationNs, expected] of SPANS) {
    assert.ok(
      usage.includes(expected),
      `the Usage trace reads ${expected} for ${durationNs}ns`
    );
    assert.ok(
      evaluations.includes(expected),
      `the Evaluations trace reads ${expected} for ${durationNs}ns`
    );
  }
  // The reading that claimed a span took no time is gone.
  assert.doesNotMatch(evaluations, /0 µs/u);
});

test("a duration has one owner, so no view can spell one of its own", () => {
  // A view that formats a duration itself is how the two spellings drifted
  // apart in the first place: a unit literal in a view is a second owner of
  // a quantity the Console renders in several places.
  const views = [
    join(import.meta.dirname, "../src/features/usage/UsageView.ts"),
    join(import.meta.dirname, "../src/features/evaluations/EvaluationsView.ts")
  ];
  for (const view of views) {
    const source = readFileSync(view, "utf8");
    assert.doesNotMatch(
      source,
      /µs/u,
      `${view} spells a microsecond, so it owns a duration of its own`
    );
    assert.doesNotMatch(
      source,
      /function formatDuration\w*\s*\(/u,
      `${view} defines a duration formatter of its own`
    );
  }
});
