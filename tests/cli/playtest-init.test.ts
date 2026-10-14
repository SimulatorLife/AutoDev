import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultPlaytestRegistryDefaults,
  expandPlaytestRegistry,
  type PlaytestMetricRegistryInput,
  PLAYTESTS_REGISTRY_SCHEMA
} from "../../core/src/playtesting/index.ts";
import {
  checkPlaytestIntegration,
  dispatchPlaytestCommand,
  initPlaytestIntegration,
  PLAYTESTS_BINDING_FILE,
  PLAYTESTS_CONFIG_FILE,
  PLAYTESTS_OBSERVATION_FILE,
  PLAYTESTS_RUBRIC_FILE,
  writePlaytestHashes
} from "../../runtime/src/cli/playtest.ts";
import {
  observationSchemaHash,
  observationSchemaHashMatches,
  playtestBenchmarkContentHash,
  playtestFileHash,
  playtestManifestHash
} from "../../runtime/src/playtesting/hash-chain.ts";

function checkout(): {
  readonly root: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "autodev-playtest-init-")
  );
  return { root, cleanup: () => undefined };
}

function read(root: string, name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(root, ".autodev", name), "utf8")
  ) as Record<string, unknown>;
}

/**
 * The binding `init` scaffolds, with the optional methods bound as well.
 *
 * Derived from the scaffold rather than restated, so these tests cannot drift
 * out of sync with what `init` actually writes.
 */
function completeBinding(root: string): Record<string, unknown> {
  const binding = read(root, PLAYTESTS_BINDING_FILE);
  binding.bindings = {
    ...(binding.bindings as Record<string, unknown>),
    invariants: { export: "invariants" },
    snapshot: { export: "snapshot" },
    replay: { export: "replay" },
    fork: { export: "fork" },
    captureEvents: { export: "captureEvents" },
    captureFrame: { export: "captureFrame" },
    cancel: { export: "cancel" }
  };
  return binding;
}

function writeBinding(root: string, binding: Record<string, unknown>): void {
  writeFileSync(
    path.join(root, ".autodev", PLAYTESTS_BINDING_FILE),
    `${JSON.stringify(binding, null, 2)}\n`,
    "utf8"
  );
}

function nonEmptyRegistry(): PlaytestMetricRegistryInput {
  const metric = {
    metricId: "fixture-rate",
    version: 1,
    mechanicKey: "fixture-mechanic",
    exposurePredicate: "fixture-opportunity-v1",
    eventFields: ["fact.value"],
    evaluatorRef: "game/evaluator.ts#fixture-rate",
    evaluatorHash: "f".repeat(64),
    numerator: "successes",
    denominator: "opportunities",
    unit: "proportion",
    polarity: "higher" as const,
    targetBand: [0, 1] as const,
    notObservable: ["unobserved"] as const
  };
  return {
    schemaVersion: 2,
    workspaceId: "fixture/game",
    audience: "fixture-player",
    registryVersion: "fixture-v2",
    eventSchemaHash: "d".repeat(64),
    defaults: defaultPlaytestRegistryDefaults(),
    metricDefinitions: [metric],
    coverageRequirements: [
      {
        coverageMetricId: metric.metricId,
        mechanicKey: metric.mechanicKey,
        phaseId: null,
        scenarioFamily: "tutorial",
        cohort: "novice",
        policy: "fixture-heuristic",
        modality: "headless",
        requiredOpportunities: 1,
        requiredIndependentUnits: 1,
        unsupportedReason: null
      }
    ],
    dimensionRubrics: []
  };
}

test("init lays out one recognizable integration directory", () => {
  const { root } = checkout();
  assert.equal(initPlaytestIntegration(root), 0);
  const config = read(root, PLAYTESTS_CONFIG_FILE);
  // Every manifest is named relative to the config's own directory, so the
  // integration stays self-contained.
  const analysis = config.analysis as Record<string, unknown>;
  assert.equal(analysis.rubric, PLAYTESTS_RUBRIC_FILE);
  assert.equal(analysis.observationContract, PLAYTESTS_OBSERVATION_FILE);
  // A second init is not destructive.
  assert.equal(initPlaytestIntegration(root), 0);
});

test("init writes a digest the checker accepts", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const contract = read(root, PLAYTESTS_OBSERVATION_FILE);
  const binding = read(root, PLAYTESTS_BINDING_FILE);
  const observationSchema = (binding.schemas as Record<string, unknown>)
    .observation as Record<string, unknown>;
  assert.equal(contract.schemaHash, observationSchemaHash(observationSchema));
  assert.ok(observationSchemaHashMatches(contract as never, observationSchema));
  assert.equal(
    checkPlaytestIntegration(root).problems.filter(
      (problem) => problem.severity === "error"
    ).length,
    0
  );
});

test("scaffolding invents no measurement intent", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  // An empty rubric is reported as empty. A generated placeholder registry
  // would be indistinguishable from one the game chose, and would quietly
  // become the game's own stated intent.
  const rubric = read(root, PLAYTESTS_RUBRIC_FILE);
  assert.equal(rubric.schemaVersion, 2);
  assert.deepEqual(rubric.metricDefinitions, []);
  assert.equal("metrics" in rubric, false);
  const report = checkPlaytestIntegration(root);
  assert.ok(
    report.problems.some((problem) => problem.code === "empty-rubric"),
    "an empty rubric must be reported, not silently accepted"
  );
});

test("an empty metricDefinitions array does not hide a malformed registry envelope", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const rubric = read(root, PLAYTESTS_RUBRIC_FILE);
  rubric.unexpected = true;
  writeFileSync(
    path.join(root, ".autodev", PLAYTESTS_RUBRIC_FILE),
    `${JSON.stringify(rubric, null, 2)}\n`,
    "utf8"
  );

  const problems = checkPlaytestIntegration(root).problems;
  assert.ok(problems.some((problem) => problem.code === "invalid-rubric"));
  assert.ok(!problems.some((problem) => problem.code === "empty-rubric"));
});

test("a non-empty Core v2 registry is not reported as an empty rubric", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const input = nonEmptyRegistry();
  const expanded = expandPlaytestRegistry(input);
  assert.equal(expanded.schema, PLAYTESTS_REGISTRY_SCHEMA);
  writeFileSync(
    path.join(root, ".autodev", PLAYTESTS_RUBRIC_FILE),
    `${JSON.stringify(input, null, 2)}\n`,
    "utf8"
  );

  assert.deepEqual(
    checkPlaytestIntegration(root).problems.filter(
      (problem) => problem.code === "empty-rubric"
    ),
    []
  );
});

test("a non-v2 rubric is rejected", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  writeFileSync(
    path.join(root, ".autodev", PLAYTESTS_RUBRIC_FILE),
    `${JSON.stringify({ schemaVersion: 1, metrics: [] })}\n`,
    "utf8"
  );
  assert.ok(
    checkPlaytestIntegration(root).problems.some(
      (problem) => problem.code === "invalid-rubric"
    )
  );
});

test("check detects observation schema drift against its declared binding", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const binding = read(root, PLAYTESTS_BINDING_FILE);
  const schemas = binding.schemas as Record<string, Record<string, unknown>>;
  schemas.observation = {
    ...schemas.observation,
    additionalProperties: false
  };
  writeFileSync(
    path.join(root, ".autodev", PLAYTESTS_BINDING_FILE),
    `${JSON.stringify(binding, null, 2)}\n`,
    "utf8"
  );
  const report = checkPlaytestIntegration(root);
  const mismatch = report.problems.find(
    (problem) => problem.code === "hash-mismatch"
  );
  assert.ok(mismatch, "schema drift without regeneration must be detected");
  assert.match(mismatch!.message, /--write-hashes/u);
  assert.match(mismatch!.file, /\.autodev\/playtest\.observation\.json/u);

  // AutoDev regenerates the schema link from the binding it also verifies.
  assert.equal(
    writePlaytestHashes(root).problems.filter(
      (problem) => problem.severity === "error"
    ).length,
    0
  );
  const regenerated = read(root, PLAYTESTS_OBSERVATION_FILE);
  assert.equal(
    regenerated.schemaHash,
    observationSchemaHash(schemas.observation)
  );
});

test("check names missing files instead of reporting a generic failure", () => {
  const { root } = checkout();
  const report = checkPlaytestIntegration(root);
  const missing = report.problems.filter(
    (problem) => problem.code === "missing-file" && problem.severity === "error"
  );
  assert.equal(missing.length, 4);
  assert.ok(
    missing.every((problem) => problem.file.startsWith(".autodev/")),
    "every missing path must be checkout-relative and openable"
  );
  assert.ok(missing.every((problem) => /playtest init/u.test(problem.message)));
});

test("the schema digest ignores key order but changes with the declared schema", () => {
  const schema = {
    type: "object",
    properties: { room: { type: "string" } }
  };
  const reordered = {
    properties: { room: { type: "string" } },
    type: "object"
  };
  assert.equal(observationSchemaHash(reordered), observationSchemaHash(schema));
  assert.notEqual(
    observationSchemaHash({
      ...reordered,
      properties: { room: { type: "number" } }
    }),
    observationSchemaHash(schema)
  );
});

test("dispatch rejects an unknown subcommand and reports exit codes", () => {
  const { root } = checkout();
  assert.equal(dispatchPlaytestCommand("init", ["--checkout-root", root]), 0);
  assert.equal(dispatchPlaytestCommand("check", ["--checkout-root", root]), 0);
  assert.throws(
    () => dispatchPlaytestCommand("definitely-not-a-command"),
    /unsupported playtest subcommand.*init, check, or conformance/u
  );
});
test("the benchmark's derived digests are checked, not trusted", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const rubricFile = path.join(root, ".autodev", PLAYTESTS_RUBRIC_FILE);
  writeFileSync(
    rubricFile,
    `${JSON.stringify(
      {
        ...nonEmptyRegistry()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const benchmarkFile = path.join(root, ".autodev", "playtest.benchmark.json");
  writeFileSync(
    benchmarkFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        benchmarkId: "fixture",
        // Digests the game wrote once and never revisited.
        rubricHash: "0".repeat(64),
        metricRegistryHash: "0".repeat(64),
        observationSchemaHash: "0".repeat(64)
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const configFile = path.join(root, ".autodev", PLAYTESTS_CONFIG_FILE);
  const config = read(root, PLAYTESTS_CONFIG_FILE) as {
    analysis: Record<string, unknown>;
  };
  config.analysis.benchmark = "playtest.benchmark.json";
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const stale = checkPlaytestIntegration(root);
  const mismatches = stale.problems.filter(
    (problem) => problem.code === "hash-mismatch"
  );
  // Registry, observation/action/event schema, and benchmark content digests
  // are all owned by AutoDev rather than hand-maintained in the game.
  assert.equal(mismatches.length, 6);
  assert.ok(
    mismatches.every((problem) => /--write-hashes/u.test(problem.message)),
    "every stale digest must say how to regenerate it"
  );

  assert.equal(
    writePlaytestHashes(root).problems.filter(
      (problem) => problem.severity === "error"
    ).length,
    0
  );
  const regenerated = readFileSync(benchmarkFile, "utf8");
  assert.doesNotMatch(regenerated, /"0{64}"/u);
  const rubricDigest = playtestFileHash(readFileSync(rubricFile, "utf8"));
  assert.ok(regenerated.includes(rubricDigest));
  // The rubric and metric registry are the same registry, so they share a digest.
  const written = JSON.parse(regenerated) as Record<string, string>;
  assert.equal(written.rubricHash, written.metricRegistryHash);
  assert.equal(
    written.observationSchemaHash,
    read(root, PLAYTESTS_OBSERVATION_FILE).schemaHash
  );
  const binding = read(root, PLAYTESTS_BINDING_FILE);
  const schemas = binding.schemas as Record<string, Record<string, unknown>>;
  assert.equal(written.actionSchemaHash, playtestManifestHash(schemas.action));
  assert.equal(written.eventSchemaHash, playtestManifestHash(schemas.event));
  assert.equal(
    written.contentHash,
    playtestBenchmarkContentHash(written as never)
  );
});

test("a game without a binding is rejected instead of retaining a handwritten protocol path", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const bindingFile = path.join(root, ".autodev", PLAYTESTS_BINDING_FILE);
  const complete = completeBinding(root);

  // A game that deletes the scaffold still has to hand-write an adapter. That
  // is reported rather than quietly treated as on-board.
  rmSync(bindingFile);
  const report = checkPlaytestIntegration(root);
  const missing = report.problems.find((problem) =>
    problem.file.endsWith(PLAYTESTS_BINDING_FILE)
  );
  assert.ok(missing, "a missing binding must be reported");
  assert.equal(missing!.severity, "error");
  assert.match(
    missing!.message,
    /game-written protocol adapters are not supported/u
  );

  // Binding every method resolves every gap: a game that declares its protocol
  // surface is onboarded, not still owning the protocol.
  writeBinding(root, complete);
  const bound = checkPlaytestIntegration(root);
  // Binding every method resolves every binding gap. The empty-rubric warning
  // is the scaffold's, not this binding's, so it is excluded rather than
  // tolerated.
  assert.deepEqual(
    bound.problems.filter((problem) =>
      problem.file.endsWith(PLAYTESTS_BINDING_FILE)
    ),
    [],
    "a complete binding reports nothing"
  );
});

test("an unbound optional method is named rather than assumed", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  // The scaffold binds the five methods an episode cannot run without. The rest
  // are this game's choice, and each one it leaves out is named.
  const report = checkPlaytestIntegration(root);
  assert.equal(
    report.problems.filter((problem) => problem.severity === "error").length,
    0,
    "a binding with every required method is usable"
  );
  const gap = report.problems.find(
    (problem) => problem.code === "incomplete-binding"
  );
  assert.ok(gap, "unbound optional methods must be reported");
  assert.equal(gap!.severity, "warning");
  assert.match(gap!.message, /fork/u);
  // The methods it does bind must not be listed as gaps.
  assert.doesNotMatch(gap!.message, /\bobserve\b/u);
  // AutoDev serves the capability advertisement from the game's own schemas, so
  // a game that binds no `capabilities` is correct, not incomplete. Reporting it
  // would send an operator to write a function nothing ever calls.
  assert.doesNotMatch(gap!.message, /capabilities/u);
});

test("an unusable binding is rejected with a named gap", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const binding = completeBinding(root);
  // `outcome` is missing: AutoDev will not supply a default for it.
  delete (binding.bindings as Record<string, unknown>).outcome;
  writeBinding(root, binding);

  const report = checkPlaytestIntegration(root);
  const invalid = report.problems.find(
    (problem) => problem.code === "invalid-binding"
  );
  assert.ok(invalid);
  assert.equal(invalid!.severity, "error");
  // Named, so the operator knows what to write rather than meeting an
  // unexplained refusal mid-run.
  assert.match(invalid!.message, /outcome/u);
  assert.match(invalid!.message, /will not supply a default/u);
  // One gap at a time would be the wrong report: a game fixing this one would
  // then meet the next, having been told the binding was otherwise complete.
  assert.doesNotMatch(invalid!.message, /\binvariants\b/u);
});

test("every binding tier requires AutoDev's generic protocol adapter", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const configFile = path.join(root, ".autodev", PLAYTESTS_CONFIG_FILE);
  const config = read(root, PLAYTESTS_CONFIG_FILE) as {
    adapter: Record<string, unknown>;
  };
  config.adapter.command = ["./my-own-adapter.js"];
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  for (const tier of ["declarative", "generated-scaffold"] as const) {
    const binding = completeBinding(root);
    binding.tier = tier;
    writeBinding(root, binding);

    const report = checkPlaytestIntegration(root);
    const invalid = report.problems.find(
      (problem) => problem.code === "invalid-binding"
    );
    assert.ok(invalid, `${tier} must require AutoDev's adapter`);
    assert.equal(invalid!.severity, "error");
    assert.match(invalid!.message, /generic adapter/u);
  }
});

test("a binding missing a game schema is rejected rather than defaulted", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const binding = completeBinding(root);
  delete (binding.schemas as Record<string, unknown>).event;
  writeBinding(root, binding);

  const report = checkPlaytestIntegration(root);
  const invalid = report.problems.find(
    (problem) => problem.code === "invalid-binding"
  );
  assert.ok(invalid);
  // The schema is the game's own; an absent one is something only the game can
  // supply, so it is named instead of filled with a guess.
  assert.match(invalid!.message, /event schema/u);
});

test("an invalid RNG version is rejected rather than half-advertised", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const binding = completeBinding(root);
  binding.rngVersion = "";
  writeBinding(root, binding);

  const invalid = checkPlaytestIntegration(root).problems.find(
    (problem) => problem.code === "invalid-binding"
  );
  assert.ok(invalid, "an empty RNG version must be rejected");
  assert.match(invalid!.message, /rngVersion/u);

  // A named version is the source of the seeded-runs capability.
  binding.rngVersion = "pcg32@1";
  writeBinding(root, binding);
  const accepted = checkPlaytestIntegration(root).problems.filter(
    (problem) => problem.code === "invalid-binding"
  );
  assert.deepEqual(accepted, []);
});

test("a declared policy AutoDev cannot run is caught at onboarding", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const configFile = path.join(root, ".autodev", PLAYTESTS_CONFIG_FILE);
  const config = read(root, PLAYTESTS_CONFIG_FILE) as {
    policies: string[];
  };
  // A game may name any policy string, so nothing in the config stops it
  // declaring one no code path constructs. Without this check the game would
  // pass `check`, be approved, and meet the refusal mid-run.
  config.policies = ["random", "a-policy-nobody-implemented"];
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const problem = checkPlaytestIntegration(root).problems.find(
    (entry) => entry.code === "unknown-policy"
  );
  assert.ok(problem, "an unrunnable policy must be reported");
  assert.equal(problem!.severity, "error");
  // Named, with the set that would work, so the operator can fix it in one edit.
  assert.match(problem!.message, /a-policy-nobody-implemented/u);
  assert.match(problem!.message, /random/u);

  // Both advertised policies are accepted.
  config.policies = ["random", "first-legal"];
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  assert.deepEqual(
    checkPlaytestIntegration(root).problems.filter(
      (entry) => entry.code === "unknown-policy"
    ),
    []
  );
});
