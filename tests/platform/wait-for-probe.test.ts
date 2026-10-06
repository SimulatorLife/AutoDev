import assert from "node:assert/strict";
import test from "node:test";

import {
  type ProbeWaitDeps,
  waitForProbe
} from "@simulatorlife/autodev-runtime/platform/wait-for-probe";

interface ProbeRecorder extends ProbeWaitDeps {
  readonly sleeps: number[];
  readonly probes: number;
}

/** Build deps whose probe reports `readyAfter`-th success, recording every call. */
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
  const deps = recorder(1);
  assert.equal(await waitForProbe(deps, 1000), true);
  assert.equal(deps.probes, 1);
  assert.deepEqual(deps.sleeps, []);
});

test("the wait polls on a fixed interval until the service answers", async () => {
  const deps = recorder(3);
  assert.equal(await waitForProbe(deps, 1000), true);
  assert.equal(deps.probes, 3);
  assert.deepEqual(deps.sleeps, [100, 100]);
});

test("an elapsed deadline still probes once, so a service ready at the timeout counts", async () => {
  // The drifted Console copy returned false at the deadline without asking, so a
  // service that came up during the final sleep was ready for every other ensure
  // step and failed for Console alone. A zero timeout must still observe the
  // service rather than assume it is down.
  const deps = recorder(1);
  assert.equal(await waitForProbe(deps, 0), true);
  assert.equal(deps.probes, 1);
  assert.deepEqual(deps.sleeps, []);
});

test("a service that never answers reports the final probe once, not forever", async () => {
  const deps = recorder(Number.MAX_SAFE_INTEGER);
  assert.equal(await waitForProbe(deps, 0), false);
  assert.equal(deps.probes, 1);
  assert.deepEqual(deps.sleeps, []);
});

test("the wait stops at its timeout and returns the last probe's result", async () => {
  const started = Date.now();
  const deps = recorder(Number.MAX_SAFE_INTEGER);
  assert.equal(await waitForProbe(deps, 40), false);
  assert.ok(
    Date.now() - started >= 35,
    "the wait must honour its timeout instead of returning immediately"
  );
  assert.ok(deps.probes >= 1);
});
