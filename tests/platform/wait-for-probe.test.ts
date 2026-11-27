import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  type ProbeWaitDeps,
  waitForProbe
} from "@simulatorlife/autodev-runtime/platform/wait-for-probe";

interface ProbeRecorder extends ProbeWaitDeps {
  readonly sleeps: number[];
  readonly probes: number;
}

/**
Build deps whose probe reports `readyAfter`-th success, recording every call.
*/
function recorder(
  readyAfter: number,
  overrides: Partial<ProbeWaitDeps> = {}
): ProbeRecorder {
  let probes = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    get probes() {
      return probes;
    },
    probe: async () => ++probes >= readyAfter,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides
  };
}

test("a healthy service resolves without sleeping", async () => {
  const dependencies = recorder(1);
  assert.equal(await waitForProbe(dependencies, 1000), true);
  assert.equal(dependencies.probes, 1);
  assert.deepEqual(dependencies.sleeps, []);
});

test("the wait polls on a fixed interval until the service answers", async () => {
  const dependencies = recorder(3);
  assert.equal(await waitForProbe(dependencies, 1000), true);
  assert.equal(dependencies.probes, 3);
  assert.deepEqual(dependencies.sleeps, [100, 100]);
});

test("an elapsed deadline still probes once, so a service ready at the timeout counts", async () => {
  // The drifted Console copy returned false at the deadline without asking, so a
  // service that came up during the final sleep was ready for every other ensure
  // step and failed for Console alone. A zero timeout must still observe the
  // service rather than assume it is down.
  const dependencies = recorder(1);
  assert.equal(await waitForProbe(dependencies, 0), true);
  assert.equal(dependencies.probes, 1);
  assert.deepEqual(dependencies.sleeps, []);
});

test("a service that never answers reports the final probe once, not forever", async () => {
  const dependencies = recorder(Number.MAX_SAFE_INTEGER);
  assert.equal(await waitForProbe(dependencies, 0), false);
  assert.equal(dependencies.probes, 1);
  assert.deepEqual(dependencies.sleeps, []);
});

test("the wait stops at its timeout and returns the last probe's result", async () => {
  const started = performance.now();
  const sleeps: number[] = [];
  const dependencies = recorder(Number.MAX_SAFE_INTEGER, {
    sleep: async (ms) => {
      sleeps.push(ms);
      await delay(ms);
    }
  });
  assert.equal(await waitForProbe(dependencies, 40), false);
  assert.ok(
    performance.now() - started >= 39,
    "the wait must honour its timeout instead of returning immediately"
  );
  assert.ok(dependencies.probes >= 1);
  assert.ok(
    sleeps.every((ms) => ms <= 40),
    "sleep cannot exceed the wait budget"
  );
});

test("invalid readiness budgets fail instead of polling indefinitely", async () => {
  const dependencies = recorder(1);
  for (const timeout of [NaN, Infinity, -1]) {
    await assert.rejects(waitForProbe(dependencies, timeout), RangeError);
  }
  assert.equal(dependencies.probes, 0);
});
