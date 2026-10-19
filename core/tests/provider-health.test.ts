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

test("active cooldown and failed health probes remain unavailable", () => {
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
  assert.equal(
    providerHealthReadiness(health({ probeFailureStreak: 1 })),
    "unavailable"
  );
});
