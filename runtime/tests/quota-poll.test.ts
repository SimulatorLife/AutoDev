import assert from "node:assert/strict";
import test from "node:test";

import type { QuotaAxiResponse } from "quota-axi";

import {
  deferredQuotaProviders,
  dueQuotaProviders,
  mergeQuotaReports
} from "../src/router/quota-poll.ts";

type QuotaProvider = QuotaAxiResponse["providers"][number];

function report(
  providers: readonly QuotaProvider[],
  generatedAt = "2026-11-15T16:40:18.000Z"
): QuotaAxiResponse {
  return { generatedAt, schemaVersion: 5, providers: [...providers] };
}

function provider(
  name: string,
  overrides: Partial<QuotaProvider> = {}
): QuotaProvider {
  return {
    provider: name,
    windows: [],
    state: { status: "fresh", stale: false },
    ...overrides
  } as QuotaProvider;
}

const NOW = Date.parse("2026-11-15T16:40:18.000Z");

test("a provider that was refused is not read again before its retry moment", () => {
  const snapshot = report([
    provider("claude", {
      state: {
        status: "rate_limited",
        stale: false,
        error: "Claude quota endpoint rate limited",
        retryAfter: "2026-11-15T17:38:15.000Z"
      }
    }),
    provider("codex")
  ]);

  const deferred = deferredQuotaProviders(snapshot, NOW);
  assert.deepEqual([...deferred], ["claude"]);
  assert.deepEqual(dueQuotaProviders(snapshot, deferred), ["codex"]);
});

test("a retry moment that has passed is asked again", () => {
  const snapshot = report([
    provider("claude", {
      state: {
        status: "rate_limited",
        stale: false,
        retryAfter: "2026-11-15T16:39:00.000Z"
      }
    })
  ]);

  const deferred = deferredQuotaProviders(snapshot, NOW);
  assert.equal(deferred.size, 0);
  assert.deepEqual(dueQuotaProviders(snapshot, deferred), ["claude"]);
});

test("a refusal that names no retry moment gives no instruction about when", () => {
  const snapshot = report([
    provider("claude", {
      state: { status: "rate_limited", stale: false }
    })
  ]);

  const deferred = deferredQuotaProviders(snapshot, NOW);
  assert.equal(deferred.size, 0);
  assert.deepEqual(dueQuotaProviders(snapshot, deferred), ["claude"]);
});

test("a reading that was not refused is never deferred", () => {
  const snapshot = report([
    provider("codex"),
    provider("copilot", {
      state: { status: "unavailable", stale: false }
    }),
    provider("minimax", {
      state: { status: "auth_required", stale: false }
    })
  ]);

  assert.equal(deferredQuotaProviders(snapshot, NOW).size, 0);
});

test("a deferred provider keeps its own entry while it waits", () => {
  // The entry is the report's own: its state, its error and its retry moment
  // are carried forward unchanged, so the Console can keep saying why the
  // usage is missing instead of the provider vanishing from the report.
  const previous = report([
    provider("claude", {
      state: {
        status: "rate_limited",
        stale: false,
        error: "Claude quota endpoint rate limited",
        retryAfter: "2026-11-15T17:38:15.000Z"
      }
    }),
    provider("codex")
  ]);
  const next = report([provider("codex")], "2026-11-15T16:41:18.000Z");
  const deferred = deferredQuotaProviders(previous, NOW);

  const merged = mergeQuotaReports(previous, next, deferred);
  assert.deepEqual(
    merged.providers.map((entry) => entry.provider),
    ["codex", "claude"]
  );
  const claude = merged.providers.find((entry) => entry.provider === "claude");
  assert.equal(claude?.state.status, "rate_limited");
  assert.equal(claude?.state.error, "Claude quota endpoint rate limited");
  assert.equal(claude?.state.retryAfter, "2026-11-15T17:38:15.000Z");
  assert.equal(merged.generatedAt, "2026-11-15T16:41:18.000Z");
});

test("a report with nothing deferred is the report that was read", () => {
  const previous = report([provider("claude")]);
  const next = report([provider("codex")], "2026-11-15T16:41:18.000Z");

  const merged = mergeQuotaReports(previous, next, new Set());
  assert.deepEqual(merged, next);
});

test("the first read asks every provider", () => {
  assert.deepEqual(dueQuotaProviders(null, new Set()), []);
  assert.deepEqual(
    mergeQuotaReports(null, report([provider("claude")]), new Set(["claude"])),
    report([provider("claude")])
  );
});
