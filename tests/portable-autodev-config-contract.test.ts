// Phase 1 portable-source contract test.
//
// Reads tests/fixtures/contracts/portable-autodev-config-contract.json and
// asserts every invariant against the live
// scripts/codex/config.autodev.toml portable source. The TOML is parsed by
// the maintained parser shared with the TypeScript composer.
//
// Schema tag for this contract: autodev-portable-autodev-config-v1.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import test from "node:test";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/contracts/portable-autodev-config-contract.json", import.meta.url),
);
const PORTABLE_PATH = fileURLToPath(
  new URL("../scripts/codex/config.autodev.toml", import.meta.url),
);

const EXPECTED_SCHEMA = "autodev-portable-autodev-config-v1";
const EXPECTED_SECTIONS = Object.freeze([
  "sandbox_workspace_write",
  "otel",
  "analytics",
  "features",
  "tools",
  "skills",
  "shell_environment_policy",
]);
const EXPECTED_MODEL_PROVIDERS = Object.freeze([
  "claude_code_subscription",
  "local_model_router",
  "minimax",
  "antigravity_cli",
]);
const EXPECTED_SKILLS = Object.freeze(["lsp-mcp-server", "ccc", "orchestration"]);

type PortableFixture = {
  schema: string;
  source: string;
  description: string;
  portableScalars: string[];
  scalars: Record<string, unknown>;
  requiredSections: string[];
  sectionShapes: Record<string, unknown>;
  modelProviders: Array<{ name: string; attributes: unknown }>;
  modelProviderOrder: string[];
  skillsConfigNamesRequired: string[];
};

function loadPortable(absoluteTomlPath: string): Record<string, unknown> {
  return parse(readFileSync(absoluteTomlPath, "utf8")) as unknown as Record<string, unknown>;
}

async function readFixture(): Promise<PortableFixture> {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as PortableFixture;
}

test("schema tag pin and source path", async () => {
  const fixture = await readFixture();
  assert.equal(fixture.schema, EXPECTED_SCHEMA);
  assert.equal(fixture.source, "scripts/codex/config.autodev.toml");
  assert.equal(typeof fixture.description, "string");
  assert.ok(fixture.description.length > 0, "fixture description must be non-empty");
});

test("portable scalars are byte-for-byte pinned", async () => {
  const fixture = await readFixture();
  const portable = loadPortable(PORTABLE_PATH);

  assert.deepEqual(
    [...fixture.portableScalars].sort(),
    Object.keys(fixture.scalars).sort(),
  );

  for (const [key, expected] of Object.entries(fixture.scalars)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(portable, key),
      `portable source missing scalar: ${key}`,
    );
    assert.deepEqual(
      portable[key],
      expected,
      `scalar ${key} drifted from the contract fixture`,
    );
  }

  // The fixture must not silently gain scalars that the portable source does
  // not declare: drift must surface on the source side instead.
  const fixtureScalars = new Set(Object.keys(fixture.scalars));
  for (const [key, value] of Object.entries(portable)) {
    const isScalar = value === null || (typeof value !== "object" && !Array.isArray(value));
    if (!isScalar) continue;
    assert.ok(
      fixtureScalars.has(key),
      `portable source declared a new scalar ${key} that is not pinned by the contract fixture`,
    );
  }
});

test("seven required sections are present and shaped", async () => {
  const fixture = await readFixture();
  const portable = loadPortable(PORTABLE_PATH);

  assert.deepEqual(fixture.requiredSections, EXPECTED_SECTIONS);
  assert.deepEqual([...fixture.requiredSections].sort(), [...EXPECTED_SECTIONS].sort());

  for (const section of EXPECTED_SECTIONS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(portable, section),
      `portable source missing required section: ${section}`,
    );
    assert.deepEqual(
      portable[section],
      fixture.sectionShapes[section],
      `section ${section} drifted from the contract fixture`,
    );
  }

  // Exactly seven top-level sections are pinned by the contract; any new
  // section on the source must either be added to the fixture or surface
  // here as drift.
  const sourceTopLevelSections = new Set(EXPECTED_SECTIONS);
  for (const [key, value] of Object.entries(portable)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    // model_providers, agents, hooks are containers of named entries tested
    // separately; skip them here.
    if (
      key === "model_providers" ||
      key === "agents" ||
      key === "hooks"
    ) {
      continue;
    }
    assert.ok(
      sourceTopLevelSections.has(key),
      `portable source declared a new top-level section ${key} not pinned by the contract fixture`,
    );
  }
});

test("four model_providers entries are pinned with byte-for-byte attributes", async () => {
  const fixture = await readFixture();
  const portable = loadPortable(PORTABLE_PATH);

  assert.deepEqual(fixture.modelProviderOrder, EXPECTED_MODEL_PROVIDERS);

  const providers = (portable.model_providers ?? {}) as Record<string, unknown>;
  assert.ok(providers && !Array.isArray(providers), "model_providers must be a TOML table");

  for (const name of EXPECTED_MODEL_PROVIDERS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(providers, name),
      `portable source missing model_providers entry: ${name}`,
    );
  }
  assert.deepEqual(
    Object.keys(providers).sort(),
    [...EXPECTED_MODEL_PROVIDERS].sort(),
    `portable source must declare exactly ${EXPECTED_MODEL_PROVIDERS.length} model_providers entries`,
  );

  const fixtureByName = new Map(
    fixture.modelProviders.map((entry) => [entry.name, entry.attributes]),
  );
  for (const name of EXPECTED_MODEL_PROVIDERS) {
    assert.deepEqual(
      providers[name],
      fixtureByName.get(name),
      `model_providers.${name} drifted from the contract fixture`,
    );
  }
});

test("hook declarations stay in Rulesync, not the portable Codex source", async () => {
  const portable = loadPortable(PORTABLE_PATH);
  assert.equal(Object.prototype.hasOwnProperty.call(portable, "hooks"), false);
  assert.equal(
    readFileSync(fileURLToPath(new URL("../.rulesync/hooks.jsonc", import.meta.url)), "utf8").includes('"hooks"'),
    true,
  );
});

test("MCP servers stay out of the portable source and skills.config.name is pinned", async () => {
  const fixture = await readFixture();
  const portable = loadPortable(PORTABLE_PATH);

  assert.deepEqual(fixture.skillsConfigNamesRequired, [...EXPECTED_SKILLS].sort());

  // `.rulesync/mcp.jsonc` is the only MCP source; the installer composes its
  // Codex projection into the user config.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(portable, "mcp_servers"),
    "portable source must not declare mcp_servers",
  );

  const skills = portable.skills as Record<string, unknown> | undefined;
  const skillsConfig = skills?.config ?? [];
  assert.ok(Array.isArray(skillsConfig), "skills.config must be an array of tables");
  const names = skillsConfig
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => entry.name);
  for (const name of EXPECTED_SKILLS) {
    assert.ok(names.includes(name), `skills.config missing entry: ${name}`);
  }
  assert.deepEqual(
    names.slice().sort(),
    [...EXPECTED_SKILLS].sort(),
    "skills.config.name set drifted from the contract fixture",
  );
});
