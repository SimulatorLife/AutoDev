import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authStatus,
  isLoopbackAddress,
  isRouterAuthEnabled,
  resolveRouterAuthToken,
  routerAuthorizationValid,
  setRouterAuthTokenForTests,
} from '../../src/router/auth.ts';

test('isLoopbackAddress identifies loopback IPv4, IPv6, and localhost', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('localhost'), true);

  assert.equal(isLoopbackAddress('192.168.1.1'), false);
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress('8.8.8.8'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('resolveRouterAuthToken reads CODEX_ROUTER_AUTH_TOKEN from environment', () => {
  assert.equal(resolveRouterAuthToken({}), '');
  assert.equal(resolveRouterAuthToken({ CODEX_ROUTER_AUTH_TOKEN: 'test-secret-token' }), 'test-secret-token');
});

test('routerAuthorizationValid validates Bearer tokens against configured token', () => {
  // When no token is configured, all requests are admitted
  assert.equal(routerAuthorizationValid({ headers: {} }, ''), true);
  assert.equal(routerAuthorizationValid({ headers: { authorization: 'Bearer wrong' } }, ''), true);

  // When a token is configured
  const token = 'my-secret-token';
  assert.equal(routerAuthorizationValid({ headers: {} }, token), false);
  assert.equal(routerAuthorizationValid({ headers: { authorization: 'Bearer wrong' } }, token), false);
  assert.equal(routerAuthorizationValid({ headers: { authorization: 'my-secret-token' } }, token), false);
  assert.equal(routerAuthorizationValid({ headers: { authorization: 'Bearer my-secret-token' } }, token), true);

  // Array header handling
  assert.equal(routerAuthorizationValid({ headers: { authorization: ['Bearer my-secret-token'] } }, token), true);
  assert.equal(routerAuthorizationValid({ headers: { authorization: ['Bearer wrong'] } }, token), false);
});

test('setRouterAuthTokenForTests dynamically updates configured token and status', () => {
  try {
    setRouterAuthTokenForTests('dynamic-test-token');
    assert.equal(isRouterAuthEnabled(), true);
    assert.deepEqual(authStatus(), { responseRequests: true });
    assert.equal(routerAuthorizationValid({ headers: { authorization: 'Bearer dynamic-test-token' } }), true);
    assert.equal(routerAuthorizationValid({ headers: { authorization: 'Bearer wrong' } }), false);

    setRouterAuthTokenForTests('');
    assert.equal(isRouterAuthEnabled(), false);
    assert.deepEqual(authStatus(), { responseRequests: false });
    assert.equal(routerAuthorizationValid({ headers: {} }), true);
  } finally {
    setRouterAuthTokenForTests('');
  }
});
