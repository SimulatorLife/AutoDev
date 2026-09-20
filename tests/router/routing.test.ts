import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTING_POLICY,
  RoutingPolicy,
  type RoutingRuntime,
  validateRoutingConfig
} from "../../src/router/routing.ts";

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test("typed routing policy resolves aliases, concrete models, credentials, and catalog ids", () => {
  assert.equal(ROUTING_POLICY.roleForModel("autodev/explorer"), "explorer");
  assert.equal(ROUTING_POLICY.roleForModel("gpt-5.6-luna"), null);
  assert.equal(ROUTING_POLICY.routeForModel("MiniMax-M3")?.provider, "minimax");
  assert.equal(ROUTING_POLICY.routeForModel("unknown-model"), null);
  assert.equal(
    ROUTING_POLICY.routeCredentialAvailable(
      ROUTING_POLICY.routeForModel("MiniMax-M3"),
      { MINIMAX_API_KEY: "key" }
    ),
    true
  );
  assert.equal(
    ROUTING_POLICY.routeCredentialAvailable(
      ROUTING_POLICY.routeForModel("MiniMax-M3"),
      {}
    ),
    false
  );
  assert.deepEqual(
    ROUTING_POLICY.catalogModelIds(
      [{ slug: "gpt-5.6-luna" }, { slug: "gpt-5.6-luna" }],
      ["autodev/explorer"]
    ),
    ["gpt-5.6-luna", "autodev/explorer"]
  );
});

test("typed routing validation rejects malformed tiers and unknown providers", () => {
  const valid = ROUTING_POLICY.config;
  assert.doesNotThrow(() => validateRoutingConfig(valid));
  assert.throws(
    () =>
      validateRoutingConfig({
        ...valid,
        providerGroups: { ...valid.providerGroups, default: [["missing"]] }
      }),
    /references unknown provider/
  );
  assert.throws(
    () =>
      validateRoutingConfig({
        ...valid,
        roles: { ...valid.roles, explorer: { tier: "" } }
      }),
    /role explorer must define a tier/
  );
});

test("routing policy preserves seeded ordering while honoring load and disabled-provider state", () => {
  const runtime: RoutingRuntime = {
    providerFailureStreak: (provider) => (provider === "claude" ? 2 : 0),
    liveProviderCount: (provider) => (provider === "antigravity" ? 1 : 0)
  };
  const policy = new RoutingPolicy(
    ROUTING_POLICY.config,
    ROUTING_POLICY.configFile,
    process.env,
    runtime
  );
  const baseline = policy.roleCandidates("default", seeded(0xc0_ff_ee));
  assert.ok(baseline.length > 0);
  policy.setProviderEnabledForRole("claude", "subagent", false);
  assert.equal(
    policy
      .roleCandidates("default", seeded(0xc0_ff_ee))
      .some((candidate) => candidate.provider === "claude"),
    false
  );
  policy.resetDisabledProvidersForRole("subagent");
  policy.resetDisabledProvidersForRole("orchestrator");
  const preferred = policy.orchestratorCandidates(seeded(0xc0_ff_ee), "claude");
  assert.equal(preferred[0]?.provider, "claude");
});

test("a role turn prefers the provider whose tool calls it is answering", () => {
  const policy = new RoutingPolicy(
    ROUTING_POLICY.config,
    ROUTING_POLICY.configFile,
    process.env
  );
  const baseline = policy
    .roleCandidates("worker", seeded(7))
    .map((candidate) => candidate.provider);
  const owner = baseline.at(-1)!;
  const preferred = policy
    .roleCandidates("worker", seeded(7), owner)
    .map((candidate) => candidate.provider);
  assert.equal(preferred[0], owner);
  assert.deepEqual(
    preferred.slice(1),
    baseline.filter((provider) => provider !== owner),
    "the rest keep their order"
  );
  // A disabled owner is skipped like any other provider; the history replays elsewhere.
  policy.setProviderEnabledForRole(owner, "subagent", false);
  assert.equal(
    policy
      .roleCandidates("worker", seeded(7), owner)
      .some((candidate) => candidate.provider === owner),
    false
  );
});

test("provider role administration is independent", () => {
  const policy = new RoutingPolicy(
    ROUTING_POLICY.config,
    ROUTING_POLICY.configFile,
    process.env
  );

  policy.setProviderEnabledForRole("claude", "orchestrator", false);
  assert.equal(
    policy.isProviderEnabledForRole("claude", "orchestrator"),
    false
  );
  assert.equal(policy.isProviderEnabledForRole("claude", "subagent"), true);
  assert.ok(
    !policy
      .orchestratorCandidates(seeded(7))
      .some((candidate) => candidate.provider === "claude")
  );
  assert.ok(
    policy
      .roleCandidates("worker", seeded(7))
      .some((candidate) => candidate.provider === "claude")
  );

  policy.setProviderEnabledForRole("claude", "subagent", false);
  assert.deepEqual(policy.runtimeState(), {
    disabledOrchestratorProviders: ["claude"],
    disabledSubagentProviders: ["claude"]
  });
  policy.restoreRuntimeState({
    disabledOrchestratorProviders: [],
    disabledSubagentProviders: ["claude"]
  });
  assert.equal(policy.isProviderEnabledForRole("claude", "orchestrator"), true);
  assert.equal(policy.isProviderEnabledForRole("claude", "subagent"), false);
});
