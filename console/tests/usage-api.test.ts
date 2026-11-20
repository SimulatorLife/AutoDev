import assert from "node:assert/strict";
import test from "node:test";

import {
  parseUsageApiPayload,
  USAGE_API_SCHEMA
} from "../src/features/usage/usage-api.ts";

const countPayloads: ReadonlyArray<{
  readonly label: string;
  readonly payload: (count: unknown) => unknown;
}> = [
  {
    label: "provider attempts",
    payload: (count) => ({
      schema: USAGE_API_SCHEMA,
      scope: "provider-usage",
      provider: "codex",
      source: {
        kind: "available",
        attemptsByProvider: [{ provider: "codex", count }],
        attemptErrorsByProvider: []
      }
    })
  },
  {
    label: "tool calls",
    payload: (count) => ({
      schema: USAGE_API_SCHEMA,
      scope: "tool-usage",
      source: { kind: "available", callsByTool: [{ tool: "exec", count }] }
    })
  },
  {
    label: "workspace requests",
    payload: (count) => ({
      schema: USAGE_API_SCHEMA,
      scope: "workspace-requests",
      source: {
        kind: "observed",
        breakdown: { partial: false, rows: [{ workspace: null, count }] }
      }
    })
  }
];

test("all usage count rows accept zero and the largest safe integer", () => {
  for (const { label, payload } of countPayloads) {
    for (const count of [0, Number.MAX_SAFE_INTEGER]) {
      assert.notEqual(
        parseUsageApiPayload(payload(count)),
        null,
        `${label} should accept ${count}`
      );
    }
  }
});

test("all usage count rows reject negative, fractional, unsafe, and nonnumeric counts", () => {
  for (const { label, payload } of countPayloads) {
    for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", NaN]) {
      assert.equal(
        parseUsageApiPayload(payload(count)),
        null,
        `${label} should reject ${String(count)}`
      );
    }
  }
});
