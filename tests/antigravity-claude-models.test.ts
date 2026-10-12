import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isAntigravityModel } from "@simulatorlife/autodev-runtime/platform/antigravity-ensure";
import { isClaudeModel } from "@simulatorlife/autodev-runtime/platform/claude-ensure";
import {
  type RoutingConfig,
  RoutingPolicy,
  validateRoutingConfig
} from "@simulatorlife/autodev-runtime/router/routing";

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
test("an effort-suffixed Claude id routes to antigravity, not the Claude bridge", () => {
  for (const model of AGY_CLAUDE_IDS) {
    const route = policy.routeForModel(model);
    assert.equal(
      route?.provider,
      "antigravity",
      `${model} must route to antigravity`
    );
    assert.equal(route.baseUrl, "http://127.0.0.1:4002/v1", model);
  }
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
  assert.equal(isAntigravityModel('{"model":"claude-opus-5.5"}'), false);
  assert.equal(isClaudeModel('{"model":"claude-opus-5.5"}'), false);
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
    const agy = isAntigravityModel(JSON.stringify({ model }));
    const claude = isClaudeModel(JSON.stringify({ model }));
    assert.ok(
      agy === false || claude === false,
      `${model} must start at most one bridge`
    );
    const routed = policy.routeForModel(model)?.provider ?? null;
    if (agy)
      assert.equal(
        routed,
        "antigravity",
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
test("each agy Claude id is accepted as an antigravity routing model", () => {
  for (const model of AGY_CLAUDE_IDS) {
    const probe = structuredClone(ROUTING_CONFIG);
    probe.providers.antigravity!.models.claude_probe = model;
    assert.doesNotThrow(
      () => validateRoutingConfig(probe),
      `${model} must validate under antigravity`
    );
  }
});

test("antigravity exposes the Claude 5.5 families as selectable models", () => {
  const configured = policy.configuredModels();
  for (const model of ["claude-opus-5-5-high", "claude-sonnet-5-5-medium"]) {
    const entry = configured.find((candidate) => candidate.model === model);
    assert.ok(entry, `${model} must be selectable`);
    assert.equal(entry.provider, "antigravity");
    assert.ok(policy.isConfiguredModel(model), `${model} must be assignable`);
  }
});

test("every model the routing config assigns to antigravity has a catalog entry", () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL(
        "../config/catalogs/antigravity-model-catalog.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as { models: Array<{ slug: string; display_name: string }> };
  const slugs = new Set(catalog.models.map((model) => model.slug));
  const assigned = Object.values(ROUTING_CONFIG.providers.antigravity!.models);
  assert.ok(assigned.length > 0);
  for (const model of assigned) {
    assert.ok(
      slugs.has(model),
      `missing antigravity catalog entry for "${model}"`
    );
  }
  // A catalog entry with no display name renders as a bare id in the Console.
  for (const model of catalog.models) {
    assert.ok(
      model.display_name.trim().length > 0,
      `${model.slug} needs a display name`
    );
  }
});
