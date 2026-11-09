import assert from "node:assert/strict";
import test from "node:test";

import {
  type ControlApiProviderHealth,
  providerHealthReadiness
} from "../src/index.ts";

function health(
  overrides: Partial<ControlApiProviderHealth> = {}
): ControlApiProviderHealth {
  return {
    cooldown: null,
    failureStreak: 0,
    probeFailureStreak: 0,
    inFlightRequests: 0,
    activeAgents: 0,
    attempts: 0,
    successes: 0,
    failures: 0,
    lastSuccessAt: null,
    lastFailure: null,
    lastCheck: null,
    ...overrides
  };
}

test("provider readiness requires current positive evidence", () => {
  assert.equal(providerHealthReadiness(null), "not-observed");
  assert.equal(providerHealthReadiness(health()), "not-observed");
  assert.equal(
    providerHealthReadiness(
      health({ lastSuccessAt: "2026-10-19T12:00:00.000Z", successes: 1 })
    ),
    "ready"
  );
});

test("provider failure evidence overrides an older success", () => {
  assert.equal(
    providerHealthReadiness(
      health({
        lastSuccessAt: "2026-10-19T12:00:00.000Z",
        lastFailure: {
          at: "2026-10-19T12:01:00.000Z",
          failureClass: "upstream_error",
          status: 503
        }
      })
    ),
    "unavailable"
  );
  assert.equal(
    providerHealthReadiness(
      health({
        lastSuccessAt: "2026-10-19T12:01:00.000Z",
        lastFailure: {
          at: "2026-10-19T12:00:00.000Z",
          failureClass: "upstream_error",
          status: 503
        }
      })
    ),
    "ready"
  );
});

test("active cooldown remains unavailable while readiness does not depend on a sticky probe streak alone", () => {
  assert.equal(
    providerHealthReadiness(
      health({
        cooldown: {
          kind: "probe",
          failureClass: "probe_unavailable",
          until: "2026-10-19T12:05:00.000Z",
          resetsAt: null,
          lastResortEligible: false
        }
      })
    ),
    "unavailable"
  );
  // Readiness derives from live evidence (an active cooldown or a failure newer
  // than the last success), not from a probe streak that only a successful
  // request resets. Without an active cooldown or failure evidence, a provider
  // with a prior success is ready.
  assert.equal(
    providerHealthReadiness(
      health({
        lastSuccessAt: "2026-10-19T12:00:00.000Z",
        probeFailureStreak: 1
      })
    ),
    "ready"
  );
  assert.equal(
    providerHealthReadiness(health({ probeFailureStreak: 1 })),
    "not-observed"
  );
});

test("a passing check newer than the last failure counts as recovery", () => {
  const failure = {
    at: "2026-11-07T12:00:00.000Z",
    failureClass: "upstream_5xx",
    status: 502
  };
  assert.equal(
    providerHealthReadiness(
      health({
        lastSuccessAt: "2026-11-07T11:00:00.000Z",
        lastFailure: failure,
        lastCheck: {
          at: "2026-11-07T12:05:00.000Z",
          ok: true,
          failureClass: null,
          detail: "probe and listing answered"
        }
      })
    ),
    "ready"
  );
  // A check older than the failure says nothing about it.
  assert.equal(
    providerHealthReadiness(
      health({
        lastFailure: failure,
        lastCheck: {
          at: "2026-11-07T11:55:00.000Z",
          ok: true,
          failureClass: null,
          detail: "probe answered"
        }
      })
    ),
    "unavailable"
  );
  // A failing check is failure evidence, even with no request ever made.
  assert.equal(
    providerHealthReadiness(
      health({
        lastCheck: {
          at: "2026-11-07T12:05:00.000Z",
          ok: false,
          failureClass: "probe_unavailable",
          detail: "probe failed"
        }
      })
    ),
    "unavailable"
  );
  // A passing check cannot clear a cooldown the provider declared.
  assert.equal(
    providerHealthReadiness(
      health({
        cooldown: {
          kind: "quota",
          failureClass: "quota_exhausted",
          until: "2026-11-07T13:00:00.000Z",
          resetsAt: "2026-11-07T13:00:00.000Z",
          lastResortEligible: false
        },
        lastCheck: {
          at: "2026-11-07T12:05:00.000Z",
          ok: true,
          failureClass: null,
          detail: "probe answered"
        }
      })
    ),
    "unavailable"
  );
});

test("multi-pool provider stays ready when one subprovider pool is exhausted while another has remaining quota", () => {
  assert.equal(
    providerHealthReadiness(
      health({
        lastSuccessAt: "2026-11-09T12:00:00.000Z",
        lastFailure: {
          at: "2026-11-09T12:05:00.000Z",
          failureClass: "quota_exhausted",
          status: 429,
          pool: "third_party",
          model: "claude-opus-5-2-thinking"
        },
        poolCooldowns: {
          third_party: {
            kind: "quota",
            failureClass: "quota_exhausted",
            until: "2026-11-11T18:06:00.000Z",
            resetsAt: "2026-11-11T18:06:00.000Z",
            lastResortEligible: false,
            scope: "pool",
            pool: "third_party"
          }
        },
        quota: {
          provider: "antigravity",
          status: "ok",
          source: "antigravity-cloudcode-api",
          updatedAt: "2026-11-09T12:05:01.000Z",
          summaryStatus: "available",
          windows: [],
          pools: [
            {
              pool: "first_party",
              label: "Gemini (First-Party)",
              status: "available",
              usedPercent: 40,
              remainingPercent: 60,
              resetsAt: "2026-11-09T16:00:00.000Z",
              windows: [],
              models: ["gemini-3.8-flash-high"]
            },
            {
              pool: "third_party",
              label: "Claude (Third-Party)",
              status: "exhausted",
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt: "2026-11-11T18:06:00.000Z",
              windows: [],
              models: ["claude-opus-5-2-thinking"]
            }
          ]
        }
      })
    ),
    "ready"
  );
});

test("live quota observation with remaining usage counts as readiness evidence and exhausted quota marks unavailable", () => {
  assert.equal(
    providerHealthReadiness(
      health({
        quota: {
          provider: "minimax",
          status: "ok",
          source: "mmx quota --output json",
          updatedAt: "2026-11-09T12:00:00.000Z",
          summaryStatus: "available",
          windows: [
            {
              id: "minimax-5h",
              label: "5-hour limit",
              kind: "five_hour",
              status: "available",
              usedPercent: 10,
              remainingPercent: 90,
              resetsAt: "2026-11-09T15:00:00.000Z"
            }
          ]
        }
      })
    ),
    "ready"
  );

  assert.equal(
    providerHealthReadiness(
      health({
        lastSuccessAt: "2026-11-09T11:00:00.000Z",
        quota: {
          provider: "minimax",
          status: "ok",
          source: "mmx quota --output json",
          updatedAt: "2026-11-09T12:00:00.000Z",
          summaryStatus: "exhausted",
          windows: [
            {
              id: "minimax-5h",
              label: "5-hour limit",
              kind: "five_hour",
              status: "exhausted",
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt: "2026-11-09T15:00:00.000Z"
            }
          ]
        }
      })
    ),
    "unavailable"
  );
});

test("an expired rate-limit failure does not keep a previously observed provider unavailable after its cooldown ends", () => {
  assert.equal(
    providerHealthReadiness(
      health({
        lastSuccessAt: "2026-11-09T11:00:00.000Z",
        cooldown: null,
        lastFailure: {
          at: "2026-11-09T11:05:00.000Z",
          failureClass: "throttled",
          status: 429
        }
      })
    ),
    "ready"
  );
});
