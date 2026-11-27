import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_EVALUATIONS_SCHEMA_ID,
  controlApiEvaluationsResponseSchema
} from "../src/control-api/evaluations.ts";

/**
The Evaluations response contract.

The Runtime produces this response, the Console reads it, and the Console's
startup preflight checks the Runtime speaks it. One Core schema answers for
all three, so these tests are the contract: a reader that accepts a response
the preflight would refuse is a bug in the reader.
*/
const METRIC = { name: "relevance", value: 0.95, pass: true };

const ROW = {
  id: "evaluation-1",
  agentRole: "orchestrator",
  promptName: "dry",
  model: "gpt-5.6-terra",
  metrics: [METRIC],
  passed: true,
  timestamp: "2026-10-05T12:00:00.000Z"
};

function envelope(
  evaluations: readonly unknown[],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: CONTROL_API_EVALUATIONS_SCHEMA_ID,
    source: "openlit_evaluation",
    readOnly: true,
    totalEvaluations: evaluations.length,
    truncated: false,
    evaluations,
    ...overrides
  };
}

function isAccepted(value: unknown): boolean {
  return controlApiEvaluationsResponseSchema.safeParse(value).success;
}

/**
Whether one response carrying these rows, under these envelope claims, is
accepted.
*/
function isRowsAccepted(
  rows: readonly unknown[],
  overrides: Record<string, unknown> = {}
): boolean {
  return isAccepted(envelope(rows, overrides));
}

/**
Whether a single row, the default row with these fields replaced, is accepted.
*/
function isRowAccepted(overrides: Record<string, unknown>): boolean {
  return isRowsAccepted([{ ...ROW, ...overrides }]);
}

function isMetricsAccepted(metrics: readonly unknown[]): boolean {
  return isRowAccepted({ metrics });
}

const { promptName: _promptName, ...ROW_WITHOUT_PROMPT } = ROW;
const { passed: _passed, ...ROW_WITHOUT_VERDICT } = ROW;
const SECOND_ROW = { ...ROW, id: "evaluation-2" };

test("accepts the responses the Runtime produces", () => {
  assert.equal(isRowsAccepted([ROW]), true);
  assert.equal(isRowsAccepted([]), true);
  assert.equal(isRowsAccepted([ROW_WITHOUT_PROMPT]), true);
  assert.equal(
    isRowsAccepted([ROW], { totalEvaluations: 5000, truncated: true }),
    true,
    "a capped window that says it is capped"
  );
  assert.equal(
    isRowAccepted({ spanId: "span-1", passed: null }),
    true,
    "an optional span and a three-state verdict"
  );
  assert.equal(
    isMetricsAccepted([
      { name: "latency_ms", value: 12, threshold: 50, pass: null }
    ]),
    true,
    "an optional threshold and a metric without a verdict"
  );
});

test("refuses an envelope that will not say whether it is capped", () => {
  const { truncated: _truncated, ...withoutFlag } = envelope([ROW]);
  assert.equal(isAccepted(withoutFlag), false);
  assert.equal(
    isRowsAccepted([], { schema: "autodev-control-evaluations-v0" }),
    false
  );
});

test("refuses size claims that contradict the rows", () => {
  assert.equal(
    isRowsAccepted([ROW, SECOND_ROW], { totalEvaluations: 1 }),
    false,
    "a total smaller than the rows it totals"
  );
  assert.equal(
    isRowsAccepted([ROW], { totalEvaluations: 120, truncated: false }),
    false,
    "a capped window describing itself as the whole history"
  );
  assert.equal(
    isRowsAccepted([ROW], { truncated: true }),
    false,
    "a complete history describing itself as capped"
  );
});

test("refuses a row whose verdict or identity is unreadable", () => {
  assert.equal(isRowsAccepted([ROW_WITHOUT_VERDICT]), false);
  assert.equal(isRowAccepted({ passed: "yes" }), false);
  assert.equal(isRowAccepted({ id: "  " }), false);
});

const UNREADABLE_METRICS: readonly unknown[] = [
  null,
  {},
  { name: "latency_ms", value: null, pass: true },
  { name: "tool_calls", value: "12", pass: true },
  { name: "relevance", value: 0.5 },
  { name: "relevance", value: 0.5, threshold: "0.7", pass: true },
  { name: "relevance", value: Infinity, pass: true },
  { name: "relevance", value: NaN, pass: true },
  { name: "relevance", value: JSON.parse("1e999") as number, pass: true }
];

test("refuses unreadable and non-finite measurements", () => {
  for (const metric of UNREADABLE_METRICS) {
    assert.equal(isMetricsAccepted([metric]), false, String(metric));
  }
  assert.equal(
    isMetricsAccepted([METRIC, METRIC]),
    false,
    "one metric named twice"
  );
});
