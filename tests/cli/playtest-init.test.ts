import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  observationSchemaHash,
  observationSchemaHashMatches,
  playtestManifestHash,
  withObservationSchemaHash
} from "@simulatorlife/autodev-core";

import {
  checkPlaytestIntegration,
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
    (problem) => problem.code === "missing-file"
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