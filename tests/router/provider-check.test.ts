import assert from "node:assert/strict";
import test from "node:test";

import {
  providerHealthReadiness,
  providerSignInRequired
} from "@simulatorlife/autodev-core";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import { recordRouterEvent } from "@simulatorlife/autodev-runtime/router/events";
import {
  checkProvider,
  providerState,
  recordProviderSignIn
} from "@simulatorlife/autodev-runtime/router/http";
import { ROUTING_POLICY } from "@simulatorlife/autodev-runtime/router/routing";

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

test("a failed operator probe records health evidence without adding cooldown penalties", () =>
  withProbe(false, async () => {
    const result = await checkProvider(PROVIDER, null);
    assert.equal(result.check.ok, false);
    assert.equal(result.check.failureClass, "probe_unavailable");
    assert.equal(result.health?.cooldown, null);
    assert.equal(result.health?.failureStreak, 0);
    assert.equal(result.health?.probeFailureStreak, 0);
    assert.equal(providerHealthReadiness(result.health), "unavailable");
    assert.deepEqual(providerState(PROVIDER).lastCheck, result.check);
  }));

test("a failed operator probe preserves existing cooldowns and failure streaks", () =>
  withProbe(false, async () => {
    COOLDOWNS.cooldownProvider(PROVIDER, {
      failureClass: "probe_unavailable"
    });
    const cooldown = COOLDOWNS.get(PROVIDER);
    const failureStreak = COOLDOWNS.failureStreak(PROVIDER);
    const probeFailureStreak = COOLDOWNS.probeFailureStreak(PROVIDER);

    const result = await checkProvider(PROVIDER, null);
    assert.equal(result.check.ok, false);
    assert.deepEqual(COOLDOWNS.get(PROVIDER), cooldown);
    assert.equal(COOLDOWNS.failureStreak(PROVIDER), failureStreak);
    assert.equal(COOLDOWNS.probeFailureStreak(PROVIDER), probeFailureStreak);
  }));

test("request refusals remain visible as events without recording provider outages", () => {
  const state = providerState(PROVIDER);
  const before = {
    failures: state.failures,
    lastFailureAt: state.lastFailureAt,
    lastFailureClass: state.lastFailureClass,
    lastFailure: state.lastFailure
  };
  try {
    for (const failureClass of ["unsupported_request", "invalid_model"]) {
      const event = recordRouterEvent({
        phase: "result",
        provider: PROVIDER,
        model: "unsupported-fixture",
        outcome: "failure",
        status: 400,
        failureClass
      });
      assert.equal(event.failureClass, failureClass);
    }
    assert.equal(state.failures, before.failures);
    assert.equal(state.lastFailureAt, before.lastFailureAt);
    assert.equal(state.lastFailureClass, before.lastFailureClass);
    assert.deepEqual(state.lastFailure, before.lastFailure);
  } finally {
    Object.assign(state, before);
  }
});

test("a missing credential is reported without creating an outage cooldown", async () => {
  const originalCredential = process.env[CREDENTIAL];
  delete process.env[CREDENTIAL];
  COOLDOWNS.clear(PROVIDER);
  try {
    const result = await checkProvider(PROVIDER, null);
    assert.equal(result.check.ok, false);
    assert.equal(result.check.failureClass, "missing_credential");
    assert.match(result.check.detail, /Missing credential/u);
    assert.equal(result.health?.cooldown, null);
  } finally {
    if (originalCredential === undefined) delete process.env[CREDENTIAL];
    else process.env[CREDENTIAL] = originalCredential;
    COOLDOWNS.clear(PROVIDER);
    providerState(PROVIDER).lastCheck = null;
  }
});

test("a transient timeout is retried before marking a provider unavailable", () =>
  withProbe(true, async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new DOMException("timed out", "TimeoutError");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await checkProvider(PROVIDER, null);
    assert.equal(result.check.ok, true);
    assert.equal(attempts, 2);
    assert.equal(result.health?.cooldown, null);
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
    assert.equal(result.models?.status, "observed");
    assert.equal(result.check.models?.status, "observed");
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

test("unavailable model discovery is reported separately from successful provider health", () =>
  withProbe(true, async () => {
    const result = await checkProvider(PROVIDER, async () => ({
      status: "unavailable",
      source: "fixture",
      lastAttemptAt: new Date().toISOString(),
      reason: "fetch failed"
    }));
    assert.equal(result.check.ok, true);
    assert.equal(result.check.failureClass, null);
    assert.equal(result.models?.status, "unavailable");
    assert.equal(result.check.models?.status, "unavailable");
    assert.match(result.check.detail, /fetch failed/u);
    assert.equal(result.health?.cooldown, null);
    assert.equal(providerHealthReadiness(result.health), "ready");
  }));

/**
 * A provider can be configured without a route: it is listed, it holds
 * priorities, models and limits, and no request can reach it.
 *
 * The Console's re-check control is on every verdict, so the Runtime has to
 * answer for such a provider rather than throw and leave the operator with a
 * failed request that says nothing about the provider.
 */
test("a provider with no route answers its check instead of throwing", async () => {
  const ROUTELESS = "routeless-fixture";
  ROUTING_POLICY.config.providers[ROUTELESS] = { models: {} };
  try {
    const result = await checkProvider(ROUTELESS, null);
    assert.equal(result.check.ok, false);
    assert.equal(result.check.failureClass, "missing_route");
    assert.match(result.check.detail, /no route/u);
    assert.deepEqual(providerState(ROUTELESS).lastCheck, result.check);
  } finally {
    delete ROUTING_POLICY.config.providers[ROUTELESS];
    providerState(ROUTELESS).lastCheck = null;
  }
});

test("a provider the Runtime does not know at all still fails the check", async () => {
  await assert.rejects(
    () => checkProvider("no-such-provider", null),
    /Unknown provider/u
  );
});

test("a bridge whose account is signed out fails its check as a sign-in", async () => {
  // A web-chat bridge answers its health check with `sign_in_required` while
  // the site is signed out in the browser it drives. That is an action for
  // the operator, and the check says so instead of "the probe failed".
  const originalFetch = globalThis.fetch;
  const originalCredential = process.env[CREDENTIAL];
  process.env[CREDENTIAL] = "test-bridge-key";
  globalThis.fetch = (async () =>
    Response.json(
      {
        error: {
          type: "authentication_error",
          code: "sign_in_required",
          message: "Not logged in to copilot"
        }
      },
      { status: 401 }
    )) as typeof fetch;
  COOLDOWNS.clear(PROVIDER);
  try {
    const result = await checkProvider(PROVIDER, null);
    assert.equal(result.check.ok, false);
    assert.equal(result.check.failureClass, "sign_in_required");
    assert.equal(result.check.detail, "Not logged in to copilot");
    assert.equal(providerSignInRequired(result.health), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCredential === undefined) delete process.env[CREDENTIAL];
    else process.env[CREDENTIAL] = originalCredential;
    COOLDOWNS.clear(PROVIDER);
    providerState(PROVIDER).lastCheck = null;
  }
});

test("a listing that finds the account signed out is health evidence until it lists again", () => {
  const state = providerState(PROVIDER);
  const saved = { ...state };
  try {
    state.lastSuccessAt = "2026-11-12T12:00:00.000Z";
    state.lastFailure = null;
    recordProviderSignIn(
      PROVIDER,
      "Not logged in to copilot",
      "2026-11-12T13:00:00.000Z"
    );
    assert.equal(
      providerState(PROVIDER).lastFailure?.class,
      "sign_in_required"
    );
    // A later listing that succeeds withdraws the sign-in, and only it.
    recordProviderSignIn(PROVIDER, null);
    assert.equal(providerState(PROVIDER).lastFailure, null);
    state.lastFailure = {
      timestamp: "2026-11-12T13:00:00.000Z",
      class: "upstream_error",
      status: 502
    };
    recordProviderSignIn(PROVIDER, null);
    assert.equal(providerState(PROVIDER).lastFailure?.class, "upstream_error");
  } finally {
    Object.assign(state, saved);
  }
});
