import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { getAutoDevModels } from "@simulatorlife/autodev-data/openlit";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * The provider whose model catalogue names a slug is the provider that serves
 * it, and the price catalogue is what the Usage cost panel looks the model up
 * in. A slug with no price row is not priced at all: the pricing cron skips
 * the span, and the panel reads as if that provider had cost nothing.
 */
const PROVIDER_CATALOGUES = {
  antigravity: "config/catalogs/antigravity-model-catalog.json",
  claude: "config/catalogs/claude-model-catalog.json",
  minimax: "config/catalogs/minimax-model-catalog.json",
  opencli: "config/catalogs/opencli-model-catalog.json"
} as const;

/**
 * Models the providers served but their routing catalogue does not name --
 * the CLI reports these ids itself. The live store carried them as the
 * `gen_ai.request.model` of real attempts, so a price row is what makes them
 * cost anything at all.
 */
const SERVED_MODEL_IDS: ReadonlyArray<readonly [string, string]> = [
  ["claude", "claude-sonnet-5-5"],
  ["minimax", "MiniMax-M3.1-Flash"],
  // agy serves the third effort of this family too, and the Console offers
  // every model the provider serves, so it has to carry a price.
  ["antigravity", "gemini-3.8-flash-low"]
];

function pricedModelIds(provider: string): Set<string> {
  return new Set(
    getAutoDevModels()
      .filter((model) => model.provider === provider)
      .map((model) => model.modelId)
  );
}

test("every model a provider's catalogue names has a price row", () => {
  for (const [provider, cataloguePath] of Object.entries(PROVIDER_CATALOGUES)) {
    const priced = pricedModelIds(provider);
    const catalogue = JSON.parse(
      readFileSync(join(REPO_ROOT, cataloguePath), "utf8")
    ) as { models?: Array<{ slug?: string }> };
    for (const model of catalogue.models ?? []) {
      const slug = String(model.slug ?? "");
      assert.ok(
        priced.has(slug),
        `${provider} | ${slug} has no price row, so its attempts are never priced`
      );
    }
  }
});

test("every model a provider served has a price row", () => {
  for (const [provider, modelId] of SERVED_MODEL_IDS) {
    assert.ok(
      pricedModelIds(provider).has(modelId),
      `${provider} | ${modelId} has no price row, so its attempts are never priced`
    );
  }
});

/**
 * The efforts a family is served at.
 *
 * agy encodes reasoning depth in the model id, so a family is a set of models
 * that differ only by their suffix, and a provider serves every effort of
 * the families it serves.
 */
const EFFORT_SUFFIXES = ["low", "medium", "high"] as const;

test("every effort of a priced family is priced", () => {
  const byProvider = new Map<string, Set<string>>();
  for (const model of getAutoDevModels()) {
    const ids = byProvider.get(model.provider) ?? new Set<string>();
    ids.add(model.modelId);
    byProvider.set(model.provider, ids);
  }
  for (const [provider, ids] of byProvider) {
    for (const modelId of ids) {
      const suffix = EFFORT_SUFFIXES.find((candidate) =>
        modelId.endsWith(`-${candidate}`)
      );
      if (!suffix) continue;
      const family = modelId.slice(0, modelId.length - suffix.length - 1);
      for (const effort of EFFORT_SUFFIXES) {
        assert.ok(
          ids.has(`${family}-${effort}`),
          `${provider} | ${family} is priced at ${suffix} but not at ${effort}, so the unpriced variant's attempts are never priced`
        );
      }
    }
  }
});
