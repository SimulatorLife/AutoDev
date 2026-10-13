import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  observationSchemaHash,
  observationSchemaHashMatches,
  playtestFileHash,
  playtestManifestHash,
  withObservationSchemaHash
} from "@simulatorlife/autodev-core";

import {
  checkPlaytestIntegration,
  PLAYTESTS_BINDING_FILE,
  dispatchPlaytestCommand,
  initPlaytestIntegration,
  PLAYTESTS_CONFIG_FILE,
  PLAYTESTS_OBSERVATION_FILE,
  PLAYTESTS_RUBRIC_FILE,
  writePlaytestHashes
} from "../../runtime/src/cli/playtest.ts";

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
  assert.equal(
    contract.schemaHash,
    observationSchemaHash(contract as never)
  );
  assert.ok(observationSchemaHashMatches(contract as never));
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
  const rubric = read(root, PLAYTESTS_RUBRIC_FILE) as { metrics: unknown[] };
  assert.deepEqual(rubric.metrics, []);
  const report = checkPlaytestIntegration(root);
  assert.ok(
    report.problems.some((problem) => problem.code === "empty-rubric"),
    "an empty rubric must be reported, not silently accepted"
  );
});

test("check detects a hand-edited observation contract", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const contract = read(root, PLAYTESTS_OBSERVATION_FILE);
  const fields = contract.fields as Record<string, unknown>[];
  fields[0]!.fieldPath = "a-field-the-game-actually-added";
  writeFileSync(
    path.join(root, ".autodev", PLAYTESTS_OBSERVATION_FILE),
    `${JSON.stringify(contract, null, 2)}\n`,
    "utf8"
  );
  const report = checkPlaytestIntegration(root);
  const mismatch = report.problems.find(
    (problem) => problem.code === "hash-mismatch"
  );
  assert.ok(mismatch, "editing a field without regenerating must be detected");
  assert.match(mismatch!.message, /--write-hashes/u);
  assert.match(mismatch!.file, /\.autodev\/playtest\.observation\.json/u);

  // The digest is regenerated from the content, not maintained by the game.
  assert.equal(writePlaytestHashes(root).problems.filter(
    (problem) => problem.severity === "error"
  ).length, 0);
  const regenerated = read(root, PLAYTESTS_OBSERVATION_FILE);
  assert.equal(
    (regenerated.fields as Record<string, unknown>[])[0]!.fieldPath,
    "a-field-the-game-actually-added"
  );
});

test("check names missing files instead of reporting a generic failure", () => {
  const { root } = checkout();
  const report = checkPlaytestIntegration(root);
  const missing = report.problems.filter(
    (problem) => problem.code === "missing-file" && problem.severity === "error"
  );
  assert.equal(missing.length, 3);
  assert.ok(
    missing.every((problem) => problem.file.startsWith(".autodev/")),
    "every missing path must be checkout-relative and openable"
  );
  assert.ok(missing.every((problem) => /playtest init/u.test(problem.message)));
});

test("the canonical digest ignores key order but not content", () => {
  const contract = withObservationSchemaHash({
    schemaVersion: 1,
    mode: "headless",
    cohort: "default",
    visibilityMode: "structured",
    fields: [
      {
        fieldPath: "room",
        unit: null,
        displayRounding: null,
        revelationTiming: "before-action",
        playerRuleRef: "rules/room"
      }
    ],
    uiEquivalence: "unverified",
    conformanceFixtureHash: null
  });
  const reordered = {
    conformanceFixtureHash: null,
    uiEquivalence: "unverified",
    fields: [
      {
        playerRuleRef: "rules/room",
        revelationTiming: "before-action",
        displayRounding: null,
        unit: null,
        fieldPath: "room"
      }
    ],
    visibilityMode: "structured",
    cohort: "default",
    mode: "headless",
    schemaVersion: 1
  };
  // A reformat must not invalidate a run.
  assert.equal(playtestManifestHash(reordered), contract.schemaHash);
  // A real change must.
  assert.notEqual(
    playtestManifestHash({ ...reordered, cohort: "other" }),
    contract.schemaHash
  );
});

test("dispatch rejects an unknown subcommand and reports exit codes", () => {
  const { root } = checkout();
  assert.equal(dispatchPlaytestCommand("init", ["--checkout-root", root]), 0);
  assert.equal(dispatchPlaytestCommand("check", ["--checkout-root", root]), 0);
  assert.throws(
    () => dispatchPlaytestCommand("definitely-not-a-command"),
    /unsupported playtest subcommand.*init, or check/u
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
        schemaVersion: 1,
        metrics: [
          {
            metricId: "clarity",
            label: "Clarity",
            unit: null,
            direction: "higher-is-better",
            description: "The game's own clarity dimension."
          }
        ]
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
  // All three derived fields, not just the observation one.
  assert.equal(mismatches.length, 3);
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
});

test("a game without declared bindings is told it still owns the protocol", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const bindingFile = path.join(root, ".autodev", PLAYTESTS_BINDING_FILE);
  const complete = completeBinding(root);

  // A game that deletes the scaffold still has to hand-write an adapter. That
  // is reported rather than quietly treated as on-board.
  rmSync(bindingFile);
  const report = checkPlaytestIntegration(root);
  const missing = report.problems.find(
    (problem) => problem.file.endsWith(PLAYTESTS_BINDING_FILE)
  );
  assert.ok(missing, "a missing binding must be reported");
  assert.equal(missing!.severity, "warning");
  assert.match(missing!.message, /implement the protocol/u);

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
  // The scaffold binds the six methods an episode cannot run without. The rest
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

test("the declarative tier is a fact, not a claim", () => {
  const { root } = checkout();
  initPlaytestIntegration(root);
  const configFile = path.join(root, ".autodev", PLAYTESTS_CONFIG_FILE);
  const config = read(root, PLAYTESTS_CONFIG_FILE) as {
    adapter: Record<string, unknown>;
  };
  // A binding claiming no protocol code, pointed at a game-written command, is
  // the tier being asserted rather than earned.
  config.adapter.command = ["./my-own-adapter.js"];
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  writeBinding(root, completeBinding(root));

  const report = checkPlaytestIntegration(root);
  const invalid = report.problems.find(
    (problem) => problem.code === "invalid-binding"
  );
  assert.ok(invalid, "a declarative tier must require AutoDev's adapter");
  assert.equal(invalid!.severity, "error");
  assert.match(invalid!.message, /generic adapter/u);
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
