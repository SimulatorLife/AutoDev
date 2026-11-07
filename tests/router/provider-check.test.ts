import assert from "node:assert/strict";
import test from "node:test";

import { providerHealthReadiness } from "@simulatorlife/autodev-core";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  checkProvider,
  providerState
} from "@simulatorlife/autodev-runtime/router/http";

/**
 * An operator's provider check re-runs what routing would before using a
 * provider -- its live probe, then its model listing -- and records the
 * result as health evidence. Copilot is the fixture: its route has a health
 * endpoint and a bridge credential, so the probe is a real HTTP check.
 */
const PROVIDER = "copilot";
const CREDENTIAL = "CODEX_ROUTER_COPILOT_API_KEY";

function withProbe(answers: boolean, body: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalCredential = process.env[CREDENTIAL];
  process.env[CREDENTIAL] = "test-bridge-key";
  globalThis.fetch = (async () => {
    if (!answers) throw new TypeError("fetch failed");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  COOLDOWNS.clear(PROVIDER);
  return body().finally(() => {
    globalThis.fetch = originalFetch;
    if (originalCredential === undefined) delete process.env[CREDENTIAL];
    else process.env[CREDENTIAL] = originalCredential;
    COOLDOWNS.clear(PROVIDER);
    providerState(PROVIDER).lastCheck = null;
  });
}

test("a failed probe cools the provider down and records a failing check", () =>
  withProbe(false, async () => {
    const result = await checkProvider(PROVIDER, null);
    assert.equal(result.check.ok, false);
    assert.equal(result.check.failureClass, "probe_unavailable");
    assert.equal(result.health?.cooldown?.kind, "probe");
    assert.equal(providerHealthReadiness(result.health), "unavailable");
    assert.deepEqual(providerState(PROVIDER).lastCheck, result.check);
  }));

test("a passing check clears a probe cooldown and outranks an older request failure", () =>
  withProbe(true, async () => {
    COOLDOWNS.cooldownProvider(PROVIDER, { failureClass: "probe_unavailable" });
    providerState(PROVIDER).lastFailure = {
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      class: "upstream_5xx",
      status: 502
    };
    const result = await checkProvider(PROVIDER, async () => ({
      status: "observed",
      source: "fixture",
      observedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      models: []
    }));
    assert.equal(result.check.ok, true);
    assert.match(result.check.detail, /listed 0 model/u);
    assert.equal(result.health?.cooldown, null);
    assert.equal(result.health?.probeFailureStreak, 0);
    assert.equal(providerHealthReadiness(result.health), "ready");
    providerState(PROVIDER).lastFailure = null;
  }));

test("a passing probe cannot clear a cooldown the provider declared", () =>
  withProbe(true, async () => {
    COOLDOWNS.cooldownProvider(PROVIDER, {
      failureClass: "quota_exhausted",
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      structured: true
    });
    const before = COOLDOWNS.get(PROVIDER);
    assert.ok(before && before.kind !== "probe");
    const result = await checkProvider(PROVIDER, null);
    assert.equal(result.check.ok, true);
    assert.equal(result.health?.cooldown?.kind, before.kind);
    assert.equal(providerHealthReadiness(result.health), "unavailable");
  }));

test("a model listing that is unavailable fails the check", () =>
  withProbe(true, async () => {
    const result = await checkProvider(PROVIDER, async () => ({
      status: "unavailable",
      source: "fixture",
      lastAttemptAt: new Date().toISOString(),
      reason: "fetch failed"
    }));
    assert.equal(result.check.ok, false);
    assert.equal(result.check.failureClass, "model_listing_unavailable");
    assert.match(result.check.detail, /fetch failed/u);
  }));
