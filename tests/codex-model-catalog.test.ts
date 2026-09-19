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
type Routing = { providers: { codex: { models: Record<string, string> } } };

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

test("MiniMax-M3 catalog entries support only none or high reasoning effort", async () => {
  const minimaxCatalog = JSON.parse(
    await readFile(
      new URL("../config/catalogs/minimax-model-catalog.json", import.meta.url),
      "utf8"
    )
  ) as Catalog;
  for (const [name, cat] of [
    ["codex-model-catalog", catalog],
    ["minimax-model-catalog", minimaxCatalog]
  ] as Array<[string, Catalog]>) {
    const model = cat.models.find((m) => m.slug === "MiniMax-M3");
    assert.ok(model, `MiniMax-M3 must exist in ${name}`);
    const levels = model.supported_reasoning_levels.map((l) => l.effort);
    assert.deepEqual(
      levels.sort(),
      ["high", "none"],
      `MiniMax-M3 in ${name} must only support none or high reasoning`
    );
    assert.ok(["none", "high"].includes(model.default_reasoning_level));
  }
});
