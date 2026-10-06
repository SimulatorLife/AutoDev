import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIGURED_ORCHESTRATOR_MODEL,
  ROUTING_POLICY,
  RoutingPolicy,
  type RoutingRuntime,
  validateRoutingConfig
} from "@simulatorlife/autodev-runtime/router/routing";

const DISABLED_ASSIGNMENT = { priority: "disabled" as const, model: null };

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
  assert.equal(
    ROUTING_POLICY.roleForModel(CONFIGURED_ORCHESTRATOR_MODEL),
    null
  );
  assert.equal(ROUTING_POLICY.routeForModel("MiniMax-M3")?.provider, "minimax");
  assert.equal(
    ROUTING_POLICY.routeForModel("MiniMax-M3.1-Flash-Preview")?.provider,
    "minimax"
  );
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
      [
        { slug: CONFIGURED_ORCHESTRATOR_MODEL },
        { slug: CONFIGURED_ORCHESTRATOR_MODEL }
      ],
      ["autodev/explorer"]
    ),
    [CONFIGURED_ORCHESTRATOR_MODEL, "autodev/explorer"]
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

test("typed routing validation narrows providers, routes, and orchestrator blocks before use", () => {
  const valid = structuredClone(ROUTING_POLICY.config);

  assert.throws(
    () =>
      validateRoutingConfig({
        ...valid,
        providers: {
          ...valid.providers,
          claude: { models: { smart: "sonnet" } }
        }
      }),
    /provider claude must define a default model/
  );

  const claudeProvider = valid.providers.claude;
  assert.ok(claudeProvider);

  assert.throws(
    () =>
      validateRoutingConfig({
        ...valid,
        providers: {
          ...valid.providers,
          claude: {
            ...claudeProvider,
            models: { ...claudeProvider.models, default: "MiniMax-M3" }
          }
        }
      }),
    /provider claude default model "MiniMax-M3" routes to minimax/
  );

  assert.throws(
    () =>
      validateRoutingConfig({
        ...valid,
        routes: { ...valid.routes, claude: { baseUrl: "http://example" } }
      }),
    /provider claude must define a route with pattern and baseUrl/
  );

  assert.throws(
    () =>
      validateRoutingConfig({
        ...valid,
        orchestrator: { ...valid.orchestrator, alias: "not-an-alias" }
      }),
    /orchestrator\.alias must be an autodev\/<name> alias/
  );

  assert.throws(
    () =>
      validateRoutingConfig({
        ...valid,
        orchestrator: {
          ...valid.orchestrator,
          reasoningEffort: { "no-such-provider": "high" }
        }
      }),
    /orchestrator\.reasoningEffort references unknown provider no-such-provider/
  );

  assert.throws(
    () =>
      validateRoutingConfig({
        ...valid,
        orchestrator: {
          ...valid.orchestrator,
          reasoningEffort: { codex: "" }
        }
      }),
    /orchestrator\.reasoningEffort\.codex must be a non-empty string/
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
  policy.setProviderAssignment("claude", "subagent", DISABLED_ASSIGNMENT);
  assert.equal(
    policy
      .roleCandidates("default", seeded(0xc0_ff_ee))
      .some((candidate) => candidate.provider === "claude"),
    false
  );
  policy.resetRoleAssignment("subagent");
  policy.resetRoleAssignment("orchestrator");
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
  policy.setProviderAssignment(owner, "subagent", DISABLED_ASSIGNMENT);
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

  policy.setProviderAssignment("claude", "orchestrator", DISABLED_ASSIGNMENT);
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

  policy.setProviderAssignment("claude", "subagent", DISABLED_ASSIGNMENT);
  assert.deepEqual(policy.runtimeState(), {
    roleAssignments: {
      claude: {
        orchestrator: DISABLED_ASSIGNMENT,
        subagent: DISABLED_ASSIGNMENT
      }
    },
    disabledProviders: [],
    disabledModels: [],
    providerLimits: {}
  });
  policy.restoreRuntimeState({
    roleAssignments: { claude: { subagent: DISABLED_ASSIGNMENT } },
    disabledProviders: [],
    disabledModels: [],
    providerLimits: {}
  });
  assert.equal(policy.isProviderEnabledForRole("claude", "orchestrator"), true);
  assert.equal(policy.isProviderEnabledForRole("claude", "subagent"), false);
});

test("model enablement removes a model from every tier it serves and survives restore", () => {
  const config = validateRoutingConfig({
    providerGroups: {
      default: [["claude", "minimax"]],
      smart: [["claude"]],
      orchestrator: [["claude"], ["minimax"]]
    },
    providers: {
      claude: {
        models: {
          default: "sonnet",
          orchestrator: "claude-opus-5-5",
          smart: "claude-opus-5-5"
        }
      },
      minimax: { models: { default: "MiniMax-M3" } }
    },
    roles: {
      default: { tier: "default" },
      "docs-researcher": { tier: "default" },
      "browser-tester": { tier: "default" },
      explorer: { tier: "default" },
      worker: { tier: "default" },
      validator: { tier: "default" },
      smart: { tier: "smart" }
    },
    orchestrator: { alias: "autodev/orchestrator", tier: "orchestrator" }
  });
  const policy = new RoutingPolicy(config, "model-routing.json", {});

  assert.deepEqual(policy.configuredModels(), [
    { model: "sonnet", provider: "claude", tiers: ["default"] },
    {
      model: "claude-opus-5-5",
      provider: "claude",
      tiers: ["orchestrator", "smart"]
    },
    { model: "MiniMax-M3", provider: "minimax", tiers: ["default"] }
  ]);

  policy.setModelEnabled("claude-opus-5-5", false);
  assert.equal(policy.isModelEnabled("claude-opus-5-5"), false);
  assert.deepEqual(
    policy
      .orchestratorCandidates(seeded(3))
      .map(({ provider, model }) => [provider, model]),
    [["minimax", "MiniMax-M3"]]
  );
  assert.deepEqual(policy.roleCandidates("smart", seeded(3)), []);
  assert.ok(
    policy
      .roleCandidates("default", seeded(3))
      .some(
        ({ provider, model }) => provider === "claude" && model === "sonnet"
      )
  );
  assert.equal(
    policy.routeDisabledReason(
      { provider: "claude", model: "claude-opus-5-5" },
      "orchestrator"
    ),
    "model_disabled"
  );
  assert.equal(
    policy.routeDisabledReason(
      { provider: "claude", model: "sonnet" },
      "subagent"
    ),
    null
  );
  policy.setProviderAssignment("claude", "orchestrator", DISABLED_ASSIGNMENT);
  assert.equal(
    policy.routeDisabledReason(
      { provider: "claude", model: "claude-opus-5-5" },
      "orchestrator"
    ),
    "provider_disabled",
    "a disabled provider is reported before its model"
  );

  // Only configured models can be disabled or restored.
  policy.setModelEnabled("gpt-unconfigured", false);
  assert.equal(policy.isModelEnabled("gpt-unconfigured"), true);
  assert.deepEqual(policy.runtimeState().disabledModels, ["claude-opus-5-5"]);
  policy.restoreRuntimeState({
    roleAssignments: {},
    disabledProviders: [],
    disabledModels: ["sonnet", "gpt-unconfigured", 7],
    providerLimits: {}
  });
  assert.deepEqual(policy.runtimeState(), {
    roleAssignments: {},
    disabledProviders: [],
    disabledModels: ["sonnet"],
    providerLimits: {}
  });
  assert.equal(policy.isModelEnabled("claude-opus-5-5"), true);
});
