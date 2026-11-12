import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  type RoutingConfig,
  RoutingPolicy,
  validateRoutingConfig
} from "@simulatorlife/autodev-runtime/router/routing";
import {
  antigravityProvider,
  isProviderRequestModel
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

const ROUTING_CONFIG = JSON.parse(
  readFileSync(new URL("../config/model-routing.json", import.meta.url), "utf8")
) as RoutingConfig;

const AGY_CLAUDE_IDS = [
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-high"
];

const policy = new RoutingPolicy(
  validateRoutingConfig(ROUTING_CONFIG),
  "config/model-routing.json"
);

// Two providers serve Claude, so the model id alone has to name which one.
// Without that, first-match routing sends `claude-opus-5-5-high` to the
// Anthropic bridge on :4000, which has no such model, and the turn fails
// against a provider that was never asked for.
test("an effort-suffixed Claude id routes to antigravity-claude-gpt, not the Claude bridge", () => {
  for (const model of AGY_CLAUDE_IDS) {
    const route = policy.routeForModel(model);
    assert.equal(
      route?.provider,
      "antigravity-claude-gpt",
      `${model} must route to antigravity-claude-gpt`
    );
    assert.equal(route.baseUrl, "http://127.0.0.1:4002/v1", model);
  }
});

// agy meters Gemini, Argon, and Claude/GPT-OSS separately, and each is its own
// provider, so every agy id names exactly one of them -- and a `gpt-oss-` id is
// agy's, never Codex's.
test("each agy model id routes to the Antigravity provider that meters it", () => {
  for (const [model, provider] of [
    ["gemini-3.8-flash-medium", "antigravity-gemini"],
    ["gemini-3.8-flash-high", "antigravity-gemini"],
    ["gemini-2.5-pro", "antigravity-gemini"],
    ["gemini-4-argon-low", "antigravity-argon"],
    ["gemini-4-argon-high", "antigravity-argon"],
    ["claude-opus-5-5-high", "antigravity-claude-gpt"],
    ["gpt-oss-120b-medium", "antigravity-claude-gpt"]
  ] as const) {
    assert.equal(policy.routeForModel(model)?.provider, provider, model);
    assert.equal(antigravityProvider(model), provider, model);
  }
  for (const model of ["gpt-6-luna", "gpt-5.6-terra", "claude-opus-5-5"])
    assert.equal(antigravityProvider(model), null, model);
  assert.equal(policy.routeForModel("gpt-6-luna")?.provider, "codex");
});

test("Anthropic's own Claude ids keep routing to the Claude bridge", () => {
  for (const model of ["claude-opus-5-5", "sonnet", "opus", "haiku"]) {
    assert.equal(
      policy.routeForModel(model)?.provider,
      "claude",
      `${model} must keep routing to claude`
    );
  }
});

// A model id the router would route nowhere must match no provider's lifecycle
// gate either, or a stale request would still boot an unrelated bridge.
test("a mistyped Claude id belongs to no provider at all", () => {
  assert.equal(policy.routeForModel("claude-opus-5.5"), null);
  assert.equal(
    isProviderRequestModel('{"model":"claude-opus-5.5"}', "antigravity"),
    false
  );
  assert.equal(
    isProviderRequestModel('{"model":"claude-opus-5.5"}', "claude"),
    false
  );
});

test("request model identification rejects malformed envelopes for every provider", () => {
  const malformed = [
    "",
    "{",
    "null",
    "[]",
    '"sonnet"',
    "42",
    "{}",
    '{"model":null}',
    '{"model":12}',
    '{"model":false}',
    '{"model":[]}',
    '{"model":{}}'
  ];
  for (const provider of ["antigravity", "claude", "minimax"] as const) {
    for (const input of malformed) {
      assert.equal(
        isProviderRequestModel(input, provider),
        false,
        provider + ": " + input
      );
    }
  }
});

test("Antigravity trims and lowercases models without claiming Claude bridge ids", () => {
  for (const model of [
    " GEMINI-3.8-FLASH-HIGH ",
    " CLAUDE-OPUS-5-5-HIGH ",
    " claude-sonnet-5-5-medium "
  ]) {
    const request = JSON.stringify({ model });
    assert.equal(isProviderRequestModel(request, "antigravity"), true, model);
    assert.equal(isProviderRequestModel(request, "claude"), false, model);
  }
  const claudeRequest = JSON.stringify({ model: " claude-opus-5-5 " });
  assert.equal(isProviderRequestModel(claudeRequest, "claude"), true);
  assert.equal(isProviderRequestModel(claudeRequest, "antigravity"), false);
});

// The two lifecycle gates must stay disjoint: the same request has to start
// exactly one bridge, and the wrong one is a connection refused on :4002.
test("the antigravity and claude lifecycle gates never both claim a model", () => {
  for (const model of [
    ...AGY_CLAUDE_IDS,
    "gemini-3.8-flash-high",
    "claude-opus-5-5",
    "sonnet",
    "MiniMax-M3"
  ]) {
    const agy = isProviderRequestModel(
      JSON.stringify({ model }),
      "antigravity"
    );
    const claude = isProviderRequestModel(JSON.stringify({ model }), "claude");
    assert.ok(
      agy === false || claude === false,
      `${model} must start at most one bridge`
    );
    const routed = policy.routeForModel(model)?.provider ?? null;
    if (agy)
      assert.equal(
        routed,
        antigravityProvider(model),
        `${model} starts agy but routes elsewhere`
      );
    if (claude)
      assert.equal(
        routed,
        "claude",
        `${model} starts claude but routes elsewhere`
      );
  }
});

// Selecting an agy Claude id as an antigravity tier must validate. This is the
// load-time throw that took the whole router down before the route patterns
// excluded effort-suffixed Claude ids from the claude provider.
test("each agy Claude id is accepted as an antigravity-claude-gpt routing model", () => {
  for (const model of AGY_CLAUDE_IDS) {
    const probe = structuredClone(ROUTING_CONFIG);
    probe.providers["antigravity-claude-gpt"]!.models.claude_probe = model;
    assert.doesNotThrow(
      () => validateRoutingConfig(probe),
      `${model} must validate under antigravity-claude-gpt`
    );
  }
});

test("antigravity-claude-gpt exposes the Claude 5.5 families as selectable models", () => {
  const configured = policy.configuredModels();
  for (const model of ["claude-opus-5-5-high", "claude-sonnet-5-5-medium"]) {
    const entry = configured.find((candidate) => candidate.model === model);
    assert.ok(entry, `${model} must be selectable`);
    assert.equal(entry.provider, "antigravity-claude-gpt");
    assert.ok(policy.isConfiguredModel(model), `${model} must be assignable`);
  }
});

test("every model the routing config assigns to an Antigravity provider has a catalog entry", () => {
  for (const provider of [
    "antigravity-gemini",
    "antigravity-argon",
    "antigravity-claude-gpt"
  ]) {
    const catalog = JSON.parse(
      readFileSync(
        new URL(
          `../config/catalogs/${provider}-model-catalog.json`,
          import.meta.url
        ),
        "utf8"
      )
    ) as { models: Array<{ slug: string; display_name: string }> };
    const slugs = new Set(catalog.models.map((model) => model.slug));
    const assigned = Object.values(ROUTING_CONFIG.providers[provider]!.models);
    assert.ok(assigned.length > 0, provider);
    for (const model of assigned) {
      assert.ok(
        slugs.has(model),
        `missing ${provider} catalog entry for "${model}"`
      );
    }
    for (const model of catalog.models) {
      // Each catalog names only models its own provider serves.
      assert.equal(antigravityProvider(model.slug), provider, model.slug);
      // A catalog entry with no display name renders as a bare id in the Console.
      assert.ok(
        model.display_name.trim().length > 0,
        `${model.slug} needs a display name`
      );
    }
  }
});
