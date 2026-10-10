import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type JsonRecord = Record<string, any>;
type Model = JsonRecord & {
  slug: string;
  supported_reasoning_levels: Array<{ effort: string }>;
  default_reasoning_level: string;
};
type Catalog = { models: Model[] };
type Routing = {
  providers: {
    codex: { models: Record<string, string> };
    minimax: { models: Record<string, string> };
  };
};

const catalog = JSON.parse(
  await readFile(
    new URL("../config/catalogs/codex-model-catalog.json", import.meta.url),
    "utf8"
  )
) as Catalog;
const routing = JSON.parse(
  await readFile(
    new URL("../config/model-routing.json", import.meta.url),
    "utf8"
  )
) as Routing;
const minimaxCatalog = JSON.parse(
  await readFile(
    new URL("../config/catalogs/minimax-model-catalog.json", import.meta.url),
    "utf8"
  )
) as Catalog;

test("codex model catalog slugs are unique", () => {
  const slugs = catalog.models.map((model) => model.slug);
  assert.deepEqual(slugs, [...new Set(slugs)]);
});

test("every configured codex routing model has a catalog entry", () => {
  const catalogSlugs = new Set(catalog.models.map((model) => model.slug));
  const codexModels = Object.values(routing.providers.codex.models);
  assert.ok(codexModels.length > 0);
  for (const model of codexModels) {
    assert.equal(
      catalogSlugs.has(model),
      true,
      `missing catalog entry for routing model "${model}"`
    );
  }
});

test("MiniMax provider catalog entries are preserved in the unified catalog", () => {
  const codexModels = new Map(
    catalog.models.map((model) => [model.slug, model])
  );

  for (const model of minimaxCatalog.models) {
    const mergedModel = codexModels.get(model.slug);
    assert.ok(mergedModel, `unified catalog is missing ${model.slug}`);
    assert.deepEqual(mergedModel, model);

    const efforts = model.supported_reasoning_levels.map(
      ({ effort }) => effort
    );
    assert.ok(efforts.length > 0, `${model.slug} must offer a reasoning level`);
    assert.equal(new Set(efforts).size, efforts.length);
    assert.ok(
      efforts.includes(model.default_reasoning_level),
      `${model.slug} default reasoning level must be supported`
    );
  }
});

test("every MiniMax model assigned by routing is listed in both catalogs", () => {
  const providerSlugs = new Set(minimaxCatalog.models.map(({ slug }) => slug));
  const unifiedSlugs = new Set(catalog.models.map(({ slug }) => slug));
  const assignments = new Set(Object.values(routing.providers.minimax.models));
  assert.ok(assignments.size > 0);

  for (const model of assignments) {
    assert.ok(providerSlugs.has(model), `MiniMax catalog is missing ${model}`);
    assert.ok(unifiedSlugs.has(model), `unified catalog is missing ${model}`);
  }
});
