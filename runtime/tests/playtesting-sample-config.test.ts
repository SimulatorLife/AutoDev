import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPlaytestBenchmark,
  assertPlaytestGameConfiguration,
  assertPlaytestObservationContract,
  expandPlaytestRegistry,
  PLAYTESTS_MEASUREMENT_VERSION,
  playtestBenchmarkHashInput
} from "@simulatorlife/autodev-core";

const FIXTURE_ROOT = fileURLToPath(
  new URL("fixtures/playtesting/", import.meta.url)
);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, name), "utf8"));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("checked-in synthetic playtest config binds a valid rubric, observation, and immutable benchmark", () => {
  const config = readJson("playtest.config.json");
  const observation = readJson("playtest.observation.json");
  const rubric = readJson("playtest.rubric.json");
  const benchmark = readJson("playtest.benchmark.json");
  const goldenCapabilities = readJson("golden-capabilities-response.json") as {
    result: Record<string, unknown>;
  };
  const adapterBytes = readFileSync(
    join(FIXTURE_ROOT, "node-fixture-adapter.mjs")
  );
  const rubricBytes = readFileSync(join(FIXTURE_ROOT, "playtest.rubric.json"));

  assertPlaytestGameConfiguration(config);
  assertPlaytestObservationContract(observation);
  assertPlaytestBenchmark(benchmark);
  const registry = expandPlaytestRegistry(rubric);
  const typedConfig = config as {
    analysis: {
      rubric: string;
      observationContract: string;
      benchmark: string;
    };
    scenarios: readonly string[];
    policies: readonly string[];
  };
  const typedObservation = observation as {
    schemaHash: string;
    mode: string;
  };
  const typedBenchmark = benchmark as {
    benchmarkId: string;
    workspaceId: string;
    referenceBuildSha: string;
    scenarioInventory: readonly { scenarioId: string; family: string }[];
    policyVersions: Readonly<Record<string, string>>;
    observationSchemaHash: string;
    actionSchemaHash: string;
    eventSchemaHash: string;
    metricRegistryHash: string;
    rubricHash: string;
    measurementVersion: string;
    contentHash: string;
  };

  assert.ok(registry.metricDefinitions.length > 0);
  assert.equal(typedConfig.analysis.rubric, "playtest.rubric.json");
  assert.equal(
    typedConfig.analysis.observationContract,
    "playtest.observation.json"
  );
  assert.equal(typedConfig.analysis.benchmark, "playtest.benchmark.json");
  assert.equal(typedObservation.mode, "headless");
  assert.equal(
    typedObservation.schemaHash,
    goldenCapabilities.result.observationSchemaHash
  );
  assert.equal(typedBenchmark.benchmarkId, "benchmark-synthetic-fixture-v1");
  assert.equal(typedBenchmark.workspaceId, registry.workspaceId);
  assert.equal(
    typedBenchmark.referenceBuildSha,
    createHash("sha1").update(adapterBytes).digest("hex"),
    "the synthetic build alias resolves to exact immutable adapter fixture bytes"
  );
  assert.deepEqual(
    typedBenchmark.scenarioInventory.map((scenario) => scenario.scenarioId),
    typedConfig.scenarios
  );
  assert.deepEqual(
    Object.keys(typedBenchmark.policyVersions),
    typedConfig.policies
  );
  assert.equal(
    typedBenchmark.actionSchemaHash,
    goldenCapabilities.result.actionSchemaHash
  );
  assert.equal(
    typedBenchmark.eventSchemaHash,
    goldenCapabilities.result.eventSchemaHash
  );
  assert.equal(typedBenchmark.metricRegistryHash, sha256(rubricBytes));
  assert.equal(typedBenchmark.rubricHash, sha256(rubricBytes));
  assert.equal(
    typedBenchmark.measurementVersion,
    PLAYTESTS_MEASUREMENT_VERSION
  );
  assert.equal(
    typedBenchmark.contentHash,
    sha256(playtestBenchmarkHashInput(benchmark)),
    "benchmark content hash is reproducible from the canonical hash projection"
  );

  for (const adapterFixture of [
    "node-fixture-adapter.mjs",
    "python-stdio-adapter.py"
  ]) {
    assert.ok(readFileSync(join(FIXTURE_ROOT, adapterFixture)).byteLength > 0);
  }
});
