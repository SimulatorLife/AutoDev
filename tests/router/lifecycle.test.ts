import assert from 'node:assert/strict';
import test from 'node:test';
import { RouterLifecycle } from '../../src/router/lifecycle.ts';

test('RouterLifecycle initializes in ready state and tracks status', () => {
  const lifecycle = new RouterLifecycle({
    startedAt: '2026-09-16T12:00:00.000Z',
    drainTimeoutMs: 1000,
    routerInstanceId: 'test-instance',
  });

  assert.equal(lifecycle.state, 'ready');
  assert.equal(lifecycle.isDraining(), false);
  const status = lifecycle.getLifecycleStatus();
  assert.deepEqual(status, {
    state: 'ready',
    draining: false,
    changedAt: '2026-09-16T12:00:00.000Z',
    activeResponseRequests: 0,
  });
});

test('RouterLifecycle registers, tracks, and aborts active requests', () => {
  const lifecycle = new RouterLifecycle({ routerInstanceId: 'test-instance' });
  const controller1 = new AbortController();
  const controller2 = new AbortController();

  lifecycle.registerActiveRequest(controller1);
  lifecycle.registerActiveRequest(controller2);
  assert.equal(lifecycle.activeRequestCount, 2);

  lifecycle.unregisterActiveRequest(controller1);
  assert.equal(lifecycle.activeRequestCount, 1);

  assert.equal(controller2.signal.aborted, false);
  lifecycle.abortActiveResponseRequests();
  assert.equal(controller2.signal.aborted, true);
});

test('RouterLifecycle transitions to draining and drains requests during shutdown', async () => {
  const lifecycle = new RouterLifecycle({ routerInstanceId: 'test-instance', drainTimeoutMs: 50 });
  const controller = new AbortController();
  lifecycle.registerActiveRequest(controller);

  let persisted = false;
  let closed = false;

  const server = {
    close(cb: (err?: Error) => void) {
      closed = true;
      cb();
    },
  };

  const drainTimeoutMs = 200;
  const unregisterAfterMs = 20;
  const shutdownPromise = lifecycle.beginShutdown({
    signal: 'SIGTERM',
    server,
    drainTimeoutMs,
    noExit: true,
    persistState: async () => {
      persisted = true;
    },
  });

  assert.equal(lifecycle.isDraining(), true);
  assert.equal(lifecycle.state, 'draining');

  // Simulate in-flight request completion after the loop has had a chance to
  // observe at least one non-empty in-flight tick. Drain checks every 50ms;
  // finishing inside that window is what proves a graceful drain rather
  // than the timeout-driven abort path.
  await new Promise((resolve) => setTimeout(resolve, Math.max(unregisterAfterMs, 10)));
  lifecycle.unregisterActiveRequest(controller);

  await shutdownPromise;

  assert.equal(persisted, true);
  assert.equal(closed, true);
  assert.equal(controller.signal.aborted, false); // completed before timeout, so not aborted
});

test('RouterLifecycle resets state for tests', () => {
  const lifecycle = new RouterLifecycle({ routerInstanceId: 'test-instance' });
  lifecycle.setLifecycleState('draining');
  lifecycle.registerActiveRequest(new AbortController());
  assert.equal(lifecycle.isDraining(), true);

  lifecycle.resetLifecycleForTests();
  assert.equal(lifecycle.isDraining(), false);
  assert.equal(lifecycle.activeRequestCount, 0);
});
