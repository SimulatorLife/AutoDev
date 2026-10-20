import assert from "node:assert/strict";
import test from "node:test";

import {
  providerUsagePath,
  summarizeProviderUsage
} from "../src/features/providers/provider-usage.ts";

test("provider usage summarizes only source-confirmed attempts for that provider", () => {
  assert.deepEqual(
    summarizeProviderUsage(
      {
        kind: "available",
        attemptsByProvider: [
          { provider: "claude", count: 7 },
          { provider: "codex", count: 11 },
          { provider: "claude", count: 2 }
        ],
        attemptErrorsByProvider: [
          { provider: "claude", count: 1 },
          { provider: "codex", count: 4 }
        ]
      },
      "claude"
    ),
    { status: "observed", attempts: 9, failures: 1 }
  );
});

test("observed empty provider breakdowns are zero; missing breakdowns stay unobserved", () => {
  assert.deepEqual(
    summarizeProviderUsage(
      {
        kind: "available",
        attemptsByProvider: [],
        attemptErrorsByProvider: []
      },
      "claude"
    ),
    { status: "observed", attempts: 0, failures: 0 }
  );
  assert.deepEqual(
    summarizeProviderUsage(
      {
        kind: "available",
        attemptsByProvider: null,
        attemptErrorsByProvider: null
      },
      "claude"
    ),
    { status: "not-observed" }
  );
});

test("provider usage preserves source availability and bounded failure evidence", () => {
  assert.deepEqual(
    summarizeProviderUsage({ kind: "not-configured" }, "claude"),
    { status: "not-configured" }
  );
  assert.deepEqual(summarizeProviderUsage({ kind: "unavailable" }, "claude"), {
    status: "unavailable"
  });
  assert.deepEqual(
    summarizeProviderUsage(
      {
        kind: "available",
        attemptsByProvider: [{ provider: "claude", count: 2.5 }],
        attemptErrorsByProvider: []
      },
      "claude"
    ),
    { status: "not-observed" }
  );
  assert.deepEqual(
    summarizeProviderUsage(
      {
        kind: "available",
        attemptsByProvider: [{ provider: "claude", count: 2 }],
        attemptErrorsByProvider: null
      },
      "claude"
    ),
    { status: "observed", attempts: 2, failures: null }
  );
});

test("provider usage link preserves the exact range and provider scope", () => {
  assert.equal(
    providerUsagePath("my/provider"),
    "/usage?range=7D&provider=my%2Fprovider"
  );
});
