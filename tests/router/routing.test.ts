import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROUTING_POLICY,
  RoutingPolicy,
  validateRoutingConfig,
  type RoutingRuntime,
} from '../../src/router/routing.ts';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('typed routing policy resolves aliases, concrete models, credentials, and catalog ids', () => {
  assert.equal(ROUTING_POLICY.roleForModel('autodev/explorer'), 'explorer');
  assert.equal(ROUTING_POLICY.roleForModel('gpt-5.6-luna'), null);
  assert.equal(ROUTING_POLICY.routeForModel('MiniMax-M3')?.provider, 'minimax');
  assert.equal(ROUTING_POLICY.routeForModel('unknown-model'), null);
  assert.equal(ROUTING_POLICY.routeCredentialAvailable(ROUTING_POLICY.routeForModel('MiniMax-M3'), { MINIMAX_API_KEY: 'key' }), true);
  assert.equal(ROUTING_POLICY.routeCredentialAvailable(ROUTING_POLICY.routeForModel('MiniMax-M3'), {}), false);
  assert.deepEqual(
    ROUTING_POLICY.catalogModelIds([{ slug: 'gpt-5.6-luna' }, { slug: 'gpt-5.6-luna' }], ['autodev/explorer']),
    ['gpt-5.6-luna', 'autodev/explorer'],
  );
});

test('typed routing validation rejects malformed tiers and unknown providers', () => {
  const valid = ROUTING_POLICY.config;
  assert.doesNotThrow(() => validateRoutingConfig(valid));
  assert.throws(
    () => validateRoutingConfig({ ...valid, providerGroups: { ...valid.providerGroups, default: [['missing']] } }),
    /references unknown provider/,
  );
  assert.throws(
    () => validateRoutingConfig({ ...valid, roles: { ...valid.roles, explorer: { tier: '' } } }),
    /role explorer must define a tier/,
  );
});

test('routing policy preserves seeded ordering while honoring load and disabled-provider state', () => {
  const runtime: RoutingRuntime = {
    providerFailureStreak: (provider) => provider === 'claude' ? 2 : 0,
    liveProviderCount: (provider) => provider === 'antigravity' ? 1 : 0,
  };
  const policy = new RoutingPolicy(ROUTING_POLICY.config, ROUTING_POLICY.configFile, process.env, runtime);
  const baseline = policy.roleCandidates('default', seeded(0xC0FFEE));
  assert.ok(baseline.length > 0);
  policy.setProviderEnabled('claude', false);
  assert.equal(policy.roleCandidates('default', seeded(0xC0FFEE)).some((candidate) => candidate.provider === 'claude'), false);
  policy.resetDisabledProviders();
  const preferred = policy.orchestratorCandidates(seeded(0xC0FFEE), 'claude');
  assert.equal(preferred[0]?.provider, 'claude');
});
