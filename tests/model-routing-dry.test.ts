import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  renderModelCatalog,
  runModelCatalog
} from "../src/config/render-model-catalog.ts";
import {
  CONFIGURED_ORCHESTRATOR_MODEL,
  CONFIGURED_SMART_MODEL,
  ROUTING_POLICY,
  RoutingPolicy,
  type RoutingPolicyConfig
} from "../src/router/routing.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ROUTING_CONFIG_PATH = join(REPO_ROOT, "config/model-routing.json");
const CATALOGS_DIR = join(REPO_ROOT, "config/catalogs");
const CODEX_CATALOG_OUTPUT = join(CATALOGS_DIR, "codex-model-catalog.json");

test("config/model-routing.json is the single source of truth for model versions", async () => {
  const raw = await readFile(ROUTING_CONFIG_PATH, "utf8");
  const config = JSON.parse(raw) as RoutingPolicyConfig;

  // Single-source-of-truth invariants
  assert.equal(
    CONFIGURED_ORCHESTRATOR_MODEL,
    config.providers.codex.models.orchestrator,
    "CONFIGURED_ORCHESTRATOR_MODEL must match config/model-routing.json"
  );
  assert.equal(
    CONFIGURED_SMART_MODEL,
    config.providers.codex.models.smart,
    "CONFIGURED_SMART_MODEL must match config/model-routing.json"
  );
  assert.equal(
    ROUTING_POLICY.orchestratorModel,
    config.providers.codex.models.orchestrator
  );
  assert.equal(
    ROUTING_POLICY.smartModel,
    config.providers.codex.models.smart
  );
  assert.equal(
    ROUTING_POLICY.configuredModel("codex", "orchestrator"),
    config.providers.codex.models.orchestrator
  );
  assert.equal(
    ROUTING_POLICY.configuredModel("codex", "smart"),
    config.providers.codex.models.smart
  );
});

test("changing model in a single config field dynamically propagates through RoutingPolicy without code changes", () => {
  const baseConfig = JSON.parse(JSON.stringify(ROUTING_POLICY.config)) as RoutingPolicyConfig;

  // Simulate updating the model versions in ONE config file, ONE field each
  const customOrchestrator = "gpt-future-orchestrator-9000";
  const customSmart = "gpt-future-smart-9000";

  baseConfig.providers.codex.models.orchestrator = customOrchestrator;
  baseConfig.providers.codex.models.default = customOrchestrator;
  baseConfig.providers.codex.models.smart = customSmart;

  const dynamicPolicy = new RoutingPolicy(baseConfig);

  // 1. Configured model accessors reflect the new model immediately
  assert.equal(dynamicPolicy.configuredModel("codex", "orchestrator"), customOrchestrator);
  assert.equal(dynamicPolicy.configuredModel("codex", "smart"), customSmart);
  assert.equal(dynamicPolicy.orchestratorModel, customOrchestrator);
  assert.equal(dynamicPolicy.smartModel, customSmart);

  // 2. Role candidates resolve to the new model dynamically
  const orchestratorCandidates = dynamicPolicy.orchestratorCandidates();
  assert.ok(orchestratorCandidates.length > 0);
  assert.equal(orchestratorCandidates[0]!.provider, "codex");
  assert.equal(orchestratorCandidates[0]!.model, customOrchestrator);

  const smartCandidates = dynamicPolicy.roleCandidates("smart");
  const codexSmartCandidate = smartCandidates.find((c) => c.provider === "codex");
  assert.ok(codexSmartCandidate, "codex candidate must exist for smart role");
  assert.equal(codexSmartCandidate.model, customSmart);

  // 3. Concrete routing resolves the new models to the codex provider
  assert.equal(dynamicPolicy.routeForModel(customOrchestrator)?.provider, "codex");
  assert.equal(dynamicPolicy.routeForModel(customSmart)?.provider, "codex");

  // 4. Provider model metadata synthesizes correctly
  const meta = dynamicPolicy.providerModelMetadata(customOrchestrator);
  assert.equal(meta.id, customOrchestrator);
  assert.equal(meta.owned_by, "codex");

  // 5. Catalog model IDs includes the new model without duplicate
  const catalogIds = dynamicPolicy.catalogModelIds(
    [{ slug: customOrchestrator }, { slug: customOrchestrator }],
    ["autodev/orchestrator"]
  );
  assert.deepEqual(catalogIds, [customOrchestrator, "autodev/orchestrator"]);
});

test("renderModelCatalog dynamically generates complete codex-model-catalog from model-routing.json", async () => {
  const renderedJson = renderModelCatalog(ROUTING_CONFIG_PATH, CATALOGS_DIR);
  const rendered = JSON.parse(renderedJson);
  const models = rendered.models as Array<{ slug: string; default_reasoning_level?: string }>;
  const slugs = new Set(models.map((m) => m.slug));

  // Both configured models must be rendered in the catalog
  assert.ok(
    slugs.has(CONFIGURED_ORCHESTRATOR_MODEL),
    `Catalog must contain orchestrator model ${CONFIGURED_ORCHESTRATOR_MODEL}`
  );
  assert.ok(
    slugs.has(CONFIGURED_SMART_MODEL),
    `Catalog must contain smart model ${CONFIGURED_SMART_MODEL}`
  );

  // Verify reasoning levels match requirements
  const orchestratorEntry = models.find((m) => m.slug === CONFIGURED_ORCHESTRATOR_MODEL);
  assert.ok(orchestratorEntry);
  assert.equal(orchestratorEntry.default_reasoning_level, "xhigh");

  const smartEntry = models.find((m) => m.slug === CONFIGURED_SMART_MODEL);
  assert.ok(smartEntry);
  assert.equal(smartEntry.default_reasoning_level, "high");

  // Verify external providers and role aliases are also rendered
  assert.ok(slugs.has("sonnet"));
  assert.ok(slugs.has("MiniMax-M3"));
  assert.ok(slugs.has("autodev/orchestrator"));
  assert.ok(slugs.has("autodev/smart"));
});

test("codex-model-catalog.json on disk is in sync with model-routing.json", async () => {
  // Check that the materializer output is verified with 0 drift
  const exitCode = runModelCatalog(
    ROUTING_CONFIG_PATH,
    CATALOGS_DIR,
    CODEX_CATALOG_OUTPUT,
    true
  );
  assert.equal(exitCode, 0, "codex-model-catalog.json must match renderModelCatalog output");
});

test("renderModelCatalog dynamically handles arbitrary new model additions without code changes", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");

  const tempDir = await mkdtemp(join(tmpdir(), "autodev-dry-test-"));
  try {
    const mockRoutingPath = join(tempDir, "model-routing.json");
    const raw = await readFile(ROUTING_CONFIG_PATH, "utf8");
    const customConfig = JSON.parse(raw);
    customConfig.providers.codex.models.orchestrator = "gpt-next-alpha";
    customConfig.providers.codex.models.smart = "gpt-next-beta";
    await writeFile(mockRoutingPath, JSON.stringify(customConfig, null, 2), "utf8");

    const renderedJson = renderModelCatalog(mockRoutingPath, CATALOGS_DIR);
    const rendered = JSON.parse(renderedJson);
    const slugs = (rendered.models as Array<{ slug: string }>).map((m) => m.slug);

    assert.ok(slugs.includes("gpt-next-alpha"), "Catalog must contain newly configured orchestrator model");
    assert.ok(slugs.includes("gpt-next-beta"), "Catalog must contain newly configured smart model");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
