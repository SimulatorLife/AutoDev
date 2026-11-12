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

test("every catalog model compacts before its context outgrows the cost band", async () => {
  const { autoCompactTokenLimit, AUTO_COMPACT_TOKEN_LIMIT_CAP } =
    await import("../runtime/src/config/render-model-catalog.ts");
  for (const file of [
    "codex",
    "claude",
    "minimax",
    "antigravity",
    "opencli-chatgpt",
    "opencli-gemini"
  ]) {
    const source = JSON.parse(
      await readFile(
        new URL(
          `../config/catalogs/${file}-model-catalog.json`,
          import.meta.url
        ),
        "utf8"
      )
    ) as Catalog;
    for (const model of source.models) {
      assert.equal(
        model.auto_compact_token_limit,
        autoCompactTokenLimit(model.context_window),
        `${file}:${model.slug} must declare the shared auto-compact limit`
      );
      assert.ok(model.auto_compact_token_limit <= AUTO_COMPACT_TOKEN_LIMIT_CAP);
      assert.ok(model.auto_compact_token_limit < model.context_window);
    }
  }
});

test("provider profiles leave compaction to the model catalog", async () => {
  for (const profile of ["minimax", "claude", "antigravity"]) {
    const source = await readFile(
      new URL(`../config/profiles/${profile}.config.toml`, import.meta.url),
      "utf8"
    );
    assert.doesNotMatch(source, /^model_auto_compact_token_limit\b/m, profile);
    assert.doesNotMatch(source, /^model_context_window\b/m, profile);
  }
  const portable = await readFile(
    new URL("../config/config.autodev.toml", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(portable, /^model_auto_compact_token_limit\b/m);
});
