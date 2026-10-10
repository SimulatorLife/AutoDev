import assert from "node:assert/strict";
import test from "node:test";

import {
  getAutoDevModels,
  getAutoDevProviders
} from "@simulatorlife/autodev-data/openlit";

test("getAutoDevProviders returns all canonical AutoDev providers", () => {
  const providers = getAutoDevProviders();
  const providerIds = new Set(providers.map((p) => p.providerId));

  assert.ok(providerIds.has("claude"));
  assert.ok(providerIds.has("antigravity"));
  assert.ok(providerIds.has("minimax"));
  assert.ok(providerIds.has("copilot"));
  assert.ok(providerIds.has("codex"));
  assert.ok(providerIds.has("autodev"));

  for (const provider of providers) {
    assert.ok(provider.displayName.length > 0);
    assert.ok(provider.description.length > 0);
    assert.equal(provider.requiresVault, false);
    assert.equal(provider.isDefault, true);
  }
});

test("getAutoDevModels returns valid catalog models with non-negative pricing and positive context windows", () => {
  const models = getAutoDevModels();
  assert.ok(models.length > 0);

  const modelKeys = new Set<string>();

  for (const model of models) {
    const key = `${model.provider}::${model.modelId}`;
    assert.ok(
      !modelKeys.has(key),
      `Duplicate model registration found for ${key}`
    );
    modelKeys.add(key);

    assert.ok(model.displayName.length > 0);
    assert.equal(model.modelType, "chat");
    assert.ok(model.contextWindow >= 100_000);
    assert.ok(model.inputPricePerMToken >= 0);
    assert.ok(model.outputPricePerMToken >= 0);
    assert.ok(model.cacheReadPricePerMToken >= 0);
    assert.ok(model.cacheCreationPricePerMToken >= 0);
    assert.ok(Array.isArray(model.capabilities));
    assert.ok(model.capabilities.includes("chat"));
  }
});
