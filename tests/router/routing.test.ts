import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIGURED_ORCHESTRATOR_MODEL,
  ROUTING_POLICY,
  RoutingPolicy,
  type RoutingRuntime,
  validateRoutingConfig
} from "@simulatorlife/autodev-runtime/router/routing";

import { useNonDelegatingContract } from "./non-delegating-contract.ts";

const DISABLED_ASSIGNMENT = { priority: "disabled" as const, model: null };
const MINIMAX_TEST_MODEL = "MiniMax-test-model";
const CLAUDE_DEFAULT_TEST_MODEL = "claude-default-test-model";
const CLAUDE_SMART_TEST_MODEL = "claude-smart-test-model";
const MINIMAX_DEFAULT_TEST_MODEL = "MiniMax-default-test-model";

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
  const minimaxModels = new Set(
    Object.values(ROUTING_POLICY.config.providers.minimax?.models ?? {})
  );
  assert.ok(minimaxModels.size > 0);
  assert.equal(ROUTING_POLICY.roleForModel("autodev/explorer"), "explorer");
  assert.equal(
    ROUTING_POLICY.roleForModel(CONFIGURED_ORCHESTRATOR_MODEL),
    null
  );
  for (const model of minimaxModels) {
    assert.equal(ROUTING_POLICY.routeForModel(model)?.provider, "minimax");
  }
  assert.equal(ROUTING_POLICY.routeForModel("unknown-model"), null);
  const minimaxModel = minimaxModels.values().next().value as string;
  assert.equal(
    ROUTING_POLICY.routeCredentialAvailable(
      ROUTING_POLICY.routeForModel(minimaxModel),
      { MINIMAX_API_KEY: "key" }
    ),
    true
  );
  assert.equal(
    ROUTING_POLICY.routeCredentialAvailable(
      ROUTING_POLICY.routeForModel(minimaxModel),
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

test("provider IDs unify configured providers and route-only providers for discovery", () => {
  const expected = [
    ...new Set([
      ...Object.keys(ROUTING_POLICY.config.providers),
      ...ROUTING_POLICY.routes.map((route) => route.provider)
    ])
  ].sort(new Intl.Collator().compare);
  assert.deepEqual(ROUTING_POLICY.providerIds(), expected);
  assert.equal(
    new Set(ROUTING_POLICY.providerIds()).size,
    expected.length,
    "the provider inventory must contain each identifier once"
  );
});

test("MiniMax's configured smart assignment is reachable for the smart role", () => {
  const configuredModel = ROUTING_POLICY.configuredModel("minimax", "smart");
  assert.ok(configuredModel);

  const candidate = ROUTING_POLICY.roleCandidates("smart", seeded(1)).find(
    ({ provider }) => provider === "minimax"
  );
  assert.ok(candidate);
  assert.equal(candidate.model, configuredModel);
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

test("every configured provider link is an https URL and malformed links are rejected", () => {
  const valid = structuredClone(ROUTING_POLICY.config);
  for (const [provider, { links }] of Object.entries(valid.providers)) {
    for (const [kind, href] of Object.entries(links ?? {})) {
      assert.equal(
        new URL(String(href)).protocol,
        "https:",
        `${provider} ${kind} link must be https`
      );
    }
  }
  const claude = valid.providers.claude;
  assert.ok(claude);
  const withLinks = (links: unknown) => ({
    ...valid,
    providers: { ...valid.providers, claude: { ...claude, links } }
  });
  assert.doesNotThrow(() =>
    validateRoutingConfig(withLinks({ usage: "https://example.test/usage" }))
  );
  assert.throws(
    () => validateRoutingConfig(withLinks("https://example.test")),
    /provider claude links must be an object/
  );
  assert.throws(
    () =>
      validateRoutingConfig(withLinks({ usage: "http://example.test/usage" })),
    /provider claude link usage must be an https URL/
  );
  assert.throws(
    () => validateRoutingConfig(withLinks({ documentation: "not a url" })),
    /provider claude link documentation must be an https URL/
  );
  assert.throws(
    () => validateRoutingConfig(withLinks({ status: "https://example.test" })),
    /provider claude has unknown link status/
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
            models: {
              ...claudeProvider.models,
              default: MINIMAX_TEST_MODEL
            }
          }
        }
      }),
    new RegExp(
      `provider claude default model "${MINIMAX_TEST_MODEL}" routes to minimax`
    )
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
    disabledAgentRoles: [],
    agentEnablementRevisions: {},
    providerLimits: {}
  });
  policy.restoreRuntimeState({
    roleAssignments: { claude: { subagent: DISABLED_ASSIGNMENT } },
    disabledProviders: [],
    disabledModels: [],
    disabledAgentRoles: [],
    providerLimits: {}
  });
  assert.equal(policy.isProviderEnabledForRole("claude", "orchestrator"), true);
  assert.equal(policy.isProviderEnabledForRole("claude", "subagent"), false);
});

test("Agent enablement is persisted per configured alias without changing provider assignments", () => {
  const policy = new RoutingPolicy(
    ROUTING_POLICY.config,
    ROUTING_POLICY.configFile,
    process.env
  );
  assert.equal(policy.agentModelAlias("worker"), "autodev/worker");
  assert.equal(policy.agentModelAlias("orchestrator"), "autodev/orchestrator");
  assert.equal(policy.agentModelAlias("not-a-configured-agent"), null);
  assert.equal(policy.isAgentEnabled("worker"), true);
  assert.equal(policy.isAgentEnabled("not-a-configured-agent"), null);

  const assignmentsBefore = policy.runtimeState().roleAssignments;
  policy.setAgentEnabled("worker", false);
  policy.setAgentEnabled("orchestrator", false);
  assert.equal(policy.isAgentEnabled("worker"), false);
  assert.equal(policy.isAgentEnabled("orchestrator"), false);
  assert.deepEqual(policy.runtimeState().disabledAgentRoles, [
    "orchestrator",
    "worker"
  ]);
  assert.deepEqual(policy.runtimeState().agentEnablementRevisions, {
    orchestrator: 1,
    worker: 1
  });
  assert.deepEqual(policy.runtimeState().roleAssignments, assignmentsBefore);

  const restored = new RoutingPolicy(
    ROUTING_POLICY.config,
    ROUTING_POLICY.configFile,
    process.env
  );
  restored.restoreRuntimeState(policy.runtimeState());
  assert.equal(restored.isAgentEnabled("worker"), false);
  assert.equal(restored.isAgentEnabled("orchestrator"), false);

  // A Runtime state written before this policy field existed has no Agent
  // disables. That is the existing route behavior, not a fabricated state.
  restored.restoreRuntimeState({
    roleAssignments: {},
    disabledProviders: [],
    disabledModels: [],
    providerLimits: {}
  });
  assert.equal(restored.isAgentEnabled("worker"), true);
  assert.deepEqual(restored.runtimeState().disabledAgentRoles, []);
  assert.deepEqual(restored.runtimeState().agentEnablementRevisions, {});

  // Persisted entries must be configured aliases; stale and malformed entries
  // cannot disable a newly named Agent by accident.
  restored.restoreRuntimeState({
    roleAssignments: {},
    disabledProviders: [],
    disabledModels: [],
    disabledAgentRoles: ["not-a-configured-agent", 3],
    providerLimits: {}
  });
  assert.deepEqual(restored.runtimeState().disabledAgentRoles, []);
});

test("the orchestrator alias cannot collide with a named Agent alias", () => {
  const conflicting = {
    ...ROUTING_POLICY.config,
    orchestrator: {
      ...ROUTING_POLICY.config.orchestrator,
      alias: "autodev/worker"
    }
  };
  assert.throws(
    () => validateRoutingConfig(conflicting),
    /orchestrator\.alias conflicts with the configured role alias autodev\/worker/u
  );

  // RoutingPolicy is also defensive when constructed directly from an
  // unchecked configuration object rather than the normal loader.
  const policy = new RoutingPolicy(
    conflicting,
    ROUTING_POLICY.configFile,
    process.env
  );
  assert.equal(policy.agentModelAlias("worker"), null);
  assert.equal(policy.agentModelAlias("orchestrator"), null);
});

test("model enablement removes a model from every tier it serves and survives restore", () => {
  const config = validateRoutingConfig({
    providerGroups: {
      default: [["claude", "minimax"]],
      smart: [["claude"]],
      // The orchestrator fallback must be a provider that can delegate.
      orchestrator: [["claude"], ["copilot"]]
    },
    providers: {
      claude: {
        models: {
          default: CLAUDE_DEFAULT_TEST_MODEL,
          orchestrator: CLAUDE_SMART_TEST_MODEL,
          smart: CLAUDE_SMART_TEST_MODEL
        }
      },
      minimax: { models: { default: MINIMAX_DEFAULT_TEST_MODEL } },
      copilot: { models: { default: "copilot", orchestrator: "copilot" } }
    },
    roles: {
      default: { tier: "default" },
      "docs-researcher": { tier: "default" },
      "browser-tester": { tier: "default" },
      explorer: { tier: "default" },
      worker: { tier: "default" },
      validator: { tier: "default" },
      smart: { tier: "smart" },
      playtester: { tier: "default" },
      "playtest-analyst": { tier: "default" }
    },
    orchestrator: { alias: "autodev/orchestrator", tier: "orchestrator" }
  });
  const policy = new RoutingPolicy(config, "model-routing.json", {});

  assert.deepEqual(policy.configuredModels(), [
    {
      model: CLAUDE_DEFAULT_TEST_MODEL,
      provider: "claude",
      tiers: ["default"]
    },
    {
      model: CLAUDE_SMART_TEST_MODEL,
      provider: "claude",
      tiers: ["orchestrator", "smart"]
    },
    {
      model: MINIMAX_DEFAULT_TEST_MODEL,
      provider: "minimax",
      tiers: ["default"]
    },
    {
      model: "copilot",
      provider: "copilot",
      tiers: ["default", "orchestrator"]
    }
  ]);

  policy.setModelEnabled(CLAUDE_SMART_TEST_MODEL, false);
  assert.equal(policy.isModelEnabled(CLAUDE_SMART_TEST_MODEL), false);
  assert.deepEqual(
    policy
      .orchestratorCandidates(seeded(3))
      .map(({ provider, model }) => [provider, model]),
    [["copilot", "copilot"]]
  );
  assert.deepEqual(policy.roleCandidates("smart", seeded(3)), []);
  assert.ok(
    policy
      .roleCandidates("default", seeded(3))
      .some(
        ({ provider, model }) =>
          provider === "claude" && model === CLAUDE_DEFAULT_TEST_MODEL
      )
  );
  assert.equal(
    policy.routeDisabledReason(
      { provider: "claude", model: CLAUDE_SMART_TEST_MODEL },
      "orchestrator"
    ),
    "model_disabled"
  );
  assert.equal(
    policy.routeDisabledReason(
      { provider: "claude", model: CLAUDE_DEFAULT_TEST_MODEL },
      "subagent"
    ),
    null
  );
  policy.setProviderAssignment("claude", "orchestrator", DISABLED_ASSIGNMENT);
  assert.equal(
    policy.routeDisabledReason(
      { provider: "claude", model: CLAUDE_SMART_TEST_MODEL },
      "orchestrator"
    ),
    "provider_disabled",
    "a disabled provider is reported before its model"
  );

  // Interactive changes require a configured or observed-routeable model.
  policy.setModelEnabled("gpt-unconfigured", false);
  assert.equal(policy.isModelEnabled("gpt-unconfigured"), true);
  assert.deepEqual(policy.runtimeState().disabledModels, [
    CLAUDE_SMART_TEST_MODEL
  ]);

  // Persisted disabled IDs must survive startup before background provider
  // discovery completes, otherwise an observed model could briefly re-enable.
  policy.restoreRuntimeState({
    roleAssignments: {},
    disabledProviders: [],
    disabledModels: [CLAUDE_DEFAULT_TEST_MODEL, "gpt-unconfigured", 7],
    providerLimits: {}
  });
  assert.deepEqual(policy.runtimeState(), {
    roleAssignments: {},
    disabledProviders: [],
    disabledModels: [CLAUDE_DEFAULT_TEST_MODEL, "gpt-unconfigured"],
    disabledAgentRoles: [],
    agentEnablementRevisions: {},
    providerLimits: {}
  });
  assert.equal(policy.isModelEnabled(CLAUDE_SMART_TEST_MODEL), true);
});

function assignmentTestPolicy(): RoutingPolicy {
  return new RoutingPolicy(
    validateRoutingConfig({
      providerGroups: {
        default: [["claude"], ["copilot"]],
        smart: [["claude"]],
        "browser-tester": [["claude"]],
        orchestrator: [["claude"]]
      },
      providers: {
        claude: {
          models: {
            default: CLAUDE_DEFAULT_TEST_MODEL,
            smart: CLAUDE_SMART_TEST_MODEL
          }
        },
        copilot: { models: { default: "copilot" } },
        minimax: { models: { default: MINIMAX_DEFAULT_TEST_MODEL } },
        "opencli-gemini": { models: { default: "opencli-gemini-3.8-flash" } }
      },
      roles: {
        default: { tier: "default" },
        "docs-researcher": { tier: "default" },
        "browser-tester": { tier: "browser-tester" },
        explorer: { tier: "default" },
        worker: { tier: "default" },
        validator: { tier: "default" },
        smart: { tier: "smart" },
        playtester: { tier: "default" },
        "playtest-analyst": { tier: "default" }
      },
      orchestrator: { alias: "autodev/orchestrator", tier: "orchestrator" }
    }),
    "model-routing.json",
    {}
  );
}

test("operator priorities rank providers within a tier and override the configured groups", () => {
  const policy = assignmentTestPolicy();
  assert.deepEqual(policy.effectiveProviderGroups("default", "subagent"), [
    ["claude"],
    ["copilot"]
  ]);
  // Copilot promoted ahead of Claude, which is demoted to P3.
  policy.setProviderAssignment("copilot", "default", {
    priority: 1,
    model: null
  });
  policy.setProviderAssignment("claude", "default", {
    priority: 3,
    model: null
  });
  assert.deepEqual(policy.effectiveProviderGroups("default", "subagent"), [
    ["copilot"],
    ["claude"]
  ]);
  assert.deepEqual(
    policy.roleCandidates("default", seeded(1)).map(({ provider }) => provider),
    ["copilot", "claude"]
  );
});

test("an unlisted provider enters a tier only when the operator assigns it a priority", () => {
  const policy = assignmentTestPolicy();
  const providers = (tier: string) =>
    policy.effectiveProviderGroups(tier, "subagent").flat();
  // opencli-gemini is configured but in no group: opt-in.
  assert.equal(providers("default").includes("opencli-gemini"), false);
  policy.setProviderAssignment("opencli-gemini", "default", {
    priority: 2,
    model: "opencli-gemini-3.1-pro"
  });
  assert.deepEqual(policy.effectiveProviderGroups("default", "subagent"), [
    ["claude"],
    ["copilot", "opencli-gemini"]
  ]);
  const candidate = policy
    .roleCandidates("default", seeded(1))
    .find(({ provider }) => provider === "opencli-gemini");
  assert.equal(candidate?.model, "opencli-gemini-3.1-pro");
  // The `default` assignment governs only the default tier.
  assert.equal(providers("smart").includes("opencli-gemini"), false);
  assert.equal(providers("browser-tester").includes("opencli-gemini"), false);
  // `subagent` governs the other subagent tiers.
  policy.setProviderAssignment("opencli-gemini", "subagent", {
    priority: 1,
    model: null
  });
  assert.deepEqual(
    policy.effectiveProviderGroups("browser-tester", "subagent"),
    [["claude", "opencli-gemini"]]
  );
});

test("a disabled tier assignment removes the provider from that tier only", () => {
  const policy = assignmentTestPolicy();
  policy.setProviderAssignment("claude", "smart", DISABLED_ASSIGNMENT);
  assert.deepEqual(policy.roleCandidates("smart", seeded(1)), []);
  assert.ok(
    policy
      .roleCandidates("default", seeded(1))
      .some(({ provider }) => provider === "claude")
  );
  // Disabling the subagent execution role switches every subagent tier off.
  policy.setProviderAssignment("claude", "subagent", DISABLED_ASSIGNMENT);
  assert.equal(
    policy
      .roleCandidates("default", seeded(1))
      .some(({ provider }) => provider === "claude"),
    false
  );
});

test("a provider enabled for subagents serves the tier their subagents run in", () => {
  // The `default` tier holds the subagent roles (explorer, worker, validator),
  // and the operator's `subagent` role is the one that says "use this
  // provider for subagent work". Reading the tier's rank from the tier's own
  // role alone left such a provider enabled for subagents and never asked:
  // the Console reported it as enabled for them and no subagent ever reached
  // it.
  const policy = assignmentTestPolicy();
  policy.setProviderAssignment("opencli-gemini", "subagent", {
    priority: 1,
    model: "opencli-gemini-3.8-flash"
  });
  // A priority is a group, not a place in front of the group: P1 is the tier's
  // first group, which the configured providers are in as well.
  assert.deepEqual(policy.effectiveProviderGroups("default", "subagent"), [
    ["claude", "opencli-gemini"],
    ["copilot"]
  ]);
  assert.deepEqual(
    new Set(
      policy
        .roleCandidates("explorer", seeded(1))
        .map(({ provider }) => provider)
    ),
    new Set(["claude", "copilot", "opencli-gemini"])
  );
  // The tier's own role still governs it when the operator sets one.
  policy.setProviderAssignment("opencli-gemini", "default", {
    priority: 3,
    model: "opencli-gemini-3.8-flash"
  });
  assert.deepEqual(policy.effectiveProviderGroups("default", "subagent"), [
    ["claude"],
    ["copilot"],
    ["opencli-gemini"]
  ]);
  // And a role disabled for the tier keeps the provider out of it, while the
  // subagent role still governs the tiers that have no role of their own.
  policy.setProviderAssignment(
    "opencli-gemini",
    "default",
    DISABLED_ASSIGNMENT
  );
  assert.equal(
    policy
      .effectiveProviderGroups("default", "subagent")
      .flat()
      .includes("opencli-gemini"),
    false
  );
  assert.ok(
    policy
      .effectiveProviderGroups("browser-tester", "subagent")
      .flat()
      .includes("opencli-gemini")
  );
});

test("the providers a tier cannot use are named, and why", () => {
  // A provider that is switched off, or disabled for the role, never becomes
  // a candidate, and the refusal that follows named only the providers that
  // were tried. An operator who had enabled a provider for the role could not
  // see why it was never asked.
  const policy = assignmentTestPolicy();
  policy.setProviderAssignment("opencli-gemini", "subagent", {
    priority: 1,
    model: "opencli-gemini-3.8-flash"
  });
  assert.deepEqual(policy.excludedProviders("default", "subagent"), []);
  policy.setProviderAssignment(
    "opencli-gemini",
    "subagent",
    DISABLED_ASSIGNMENT
  );
  assert.deepEqual(policy.excludedProviders("default", "subagent"), [
    { provider: "opencli-gemini", reason: "its subagent role is disabled" }
  ]);
  policy.setProviderAssignment("opencli-gemini", "subagent", {
    priority: 1,
    model: "opencli-gemini-3.8-flash"
  });
  policy.setProviderAssignment(
    "opencli-gemini",
    "default",
    DISABLED_ASSIGNMENT
  );
  assert.deepEqual(policy.excludedProviders("default", "subagent"), [
    { provider: "opencli-gemini", reason: "its default role is disabled" }
  ]);
  // A provider the operator never configured is not excluded from a tier: it
  // was never in it.
  assert.deepEqual(
    policy
      .excludedProviders("default", "subagent")
      .filter(({ provider }) => provider === "minimax"),
    []
  );
});

test("the orchestrator tier admits only providers that can delegate, however they are ranked", (t) => {
  // Every shipped provider can delegate; this contract says MiniMax cannot.
  t.after(useNonDelegatingContract("minimax"));
  const policy = assignmentTestPolicy();
  policy.setProviderAssignment("minimax", "orchestrator", {
    priority: 1,
    model: MINIMAX_DEFAULT_TEST_MODEL
  });
  policy.setProviderAssignment("copilot", "orchestrator", {
    priority: 2,
    model: "copilot"
  });
  assert.deepEqual(
    policy.orchestratorCandidates(seeded(1)).map(({ provider }) => provider),
    ["claude", "copilot"]
  );
  // opencli delegates through Codex's own exec tool, so it may orchestrate.
  policy.setProviderAssignment("opencli-gemini", "orchestrator", {
    priority: 3,
    model: "opencli-gemini-3.1-pro"
  });
  assert.deepEqual(
    policy.orchestratorCandidates(seeded(1)).map(({ provider }) => provider),
    ["claude", "copilot", "opencli-gemini"]
  );
});
