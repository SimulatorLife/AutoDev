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
  minimax: "config/catalogs/minimax-model-catalog.json"
} as const;

/**
 * Models the providers served but their routing catalogue does not name --
 * the CLI reports these ids itself. The live store carried them as the
 * `gen_ai.request.model` of real attempts, so a price row is what makes them
 * cost anything at all.
 */
const SERVED_MODEL_IDS: ReadonlyArray<readonly [string, string]> = [
  ["claude", "claude-sonnet-5-5"],
  ["minimax", "MiniMax-M3.1-Flash"]
];

function pricedModelIds(provider: string): Set<string> {
  return new Set(
    getAutoDevModels()
      .filter((model) => model.provider === provider)
      .map((model) => model.modelId)
  );
}

test("every model a provider's catalogue names has a price row", () => {
  for (const [provider, cataloguePath] of Object.entries(
    PROVIDER_CATALOGUES
  )) {
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
