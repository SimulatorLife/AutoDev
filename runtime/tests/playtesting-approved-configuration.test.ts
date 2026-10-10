import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspacePlaytestApproval } from "@simulatorlife/autodev-core";

import {
  ApprovedPlaytestConfigurationError,
  loadApprovedPlaytestDefinition
} from "../src/playtesting/approved-configuration.ts";

const CONFIG = {
  schemaVersion: 1,
  adapter: { transport: "stdio-jsonl", command: ["node", "adapter.mjs"] },
  modes: ["headless"],
  scenarios: ["tutorial", "edge"],
  scenarioFamilies: { tutorial: "onboarding", edge: "edge-cases" },
  policies: ["random", "heuristic"],
  budget: {
    episodes: 10,
    maxStepsPerEpisode: 30,
    workers: 2,
    wallTimeMinutes: 5
  },
  analysis: {
    rubric: "playtest.rubric.json",
    observationContract: "playtest.observation.json",
    benchmark: null,
    critic: "auto",
    maxReviewedSessions: 5,
    visualCapture: "off",
    counterfactuals: "off",
    understandingProbes: "off",
    learningCohorts: "off",
    humanCalibration: "off"
  },
  reporting: { githubIssues: "disabled" }
} as const;

const RUBRIC = JSON.stringify({ schemaVersion: 1, dimensions: [] }) + "\n";
const OBSERVATION =
  JSON.stringify({
    schemaVersion: 1,
    schemaHash: "d".repeat(64),
    mode: "headless",
    cohort: "exploratory",
    visibilityMode: "structured",
    fields: [
      {
        fieldPath: "room",
        unit: null,
        displayRounding: null,
        revelationTiming: "before-action",
        playerRuleRef: "fixture/rules/room"
      }
    ],
    uiEquivalence: "unverified",
    conformanceFixtureHash: null
  }) + "\n";

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function approval(
  root: string,
  changes: Partial<WorkspacePlaytestApproval> = {}
): WorkspacePlaytestApproval {
  const configBytes = JSON.stringify(CONFIG) + "\n";
  return {
    schema: "autodev-workspace-playtest-approval-v1",
    workspaceId: "owner/fixture",
    revision: 1,
    approvalId: "approval-fixture",
    checkoutRoot: root,
    buildSha: "a".repeat(40),
    gameBuild: "fixture-build-1",
    playtestConfigHash: digest(configBytes),
    adapterImageDigest: `ghcr.io/owner/fixture@sha256:${"b".repeat(64)}`,
    workingDirectory: ".",
    adapterCommand: ["node", "adapter.mjs"],
    allowedScenarios: ["tutorial"],
    allowedPolicies: ["random"],
    limits: {
      cpuCores: 1,
      memoryBytes: 256 * 1024 * 1024,
      processCount: 16,
      wallTimeMs: 30_000,
      artifactBytes: 16 * 1024 * 1024,
      workerCount: 1,
      episodeCount: 3,
      maxStepsPerEpisode: 20,
      critiqueCount: 0
    },
    retentionDays: 7,
    issueReporting: "disabled",
    humanStudyAllowed: false,
    approvedAt: "2026-10-10T00:00:00.000Z",
    approvedBy: "fixture-operator",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...changes
  };
}

function setup(): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "approved-playtest-config-")
  );
  writeFileSync(
    path.join(root, "playtest.config.json"),
    JSON.stringify(CONFIG) + "\n"
  );
  writeFileSync(path.join(root, "playtest.observation.json"), OBSERVATION);
  writeFileSync(path.join(root, "playtest.rubric.json"), RUBRIC);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function expectCategory(
  run: () => unknown,
  category: ApprovedPlaytestConfigurationError["category"]
): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ApprovedPlaytestConfigurationError);
    assert.equal(error.category, category);
    return true;
  });
}

test("approved config verifies exact raw-byte digest and bound settings without executing", () => {
  const fixture = setup();
  try {
    const result = loadApprovedPlaytestDefinition(approval(fixture.root));
    assert.equal(result.configHash, approval(fixture.root).playtestConfigHash);
    assert.deepEqual(result.configuration.adapter.command, [
      "node",
      "adapter.mjs"
    ]);
    assert.deepEqual(result.configuration.scenarios, ["tutorial", "edge"]);
  } finally {
    fixture.cleanup();
  }
});

test("approved config rejects changed bytes before parsing or execution", () => {
  const fixture = setup();
  try {
    writeFileSync(path.join(fixture.root, "playtest.config.json"), "{}\n");
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(fixture.root)),
      "config-hash-mismatch"
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved config refuses symlink files and symlink checkout roots", () => {
  const fixture = setup();
  const outside = mkdtempSync(
    path.join(realpathSync(tmpdir()), "outside-playtest-config-")
  );
  const outsideFile = path.join(outside, "playtest.config.json");
  writeFileSync(outsideFile, JSON.stringify(CONFIG) + "\n");
  const rootLink = `${fixture.root}-link`;
  try {
    rmSync(path.join(fixture.root, "playtest.config.json"));
    symlinkSync(outsideFile, path.join(fixture.root, "playtest.config.json"));
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition(
          approval(fixture.root, {
            playtestConfigHash: digest(JSON.stringify(CONFIG) + "\n")
          })
        ),
      "config-unavailable"
    );
    symlinkSync(fixture.root, rootLink, "dir");
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(rootLink)),
      "checkout-unavailable"
    );
  } finally {
    unlinkSync(rootLink);
    fixture.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("approved config rejects command, scenario, policy and budget drift", () => {
  const fixture = setup();
  try {
    const base = approval(fixture.root);
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition({
          ...base,
          adapterCommand: ["node", "other.mjs"]
        }),
      "command-mismatch"
    );
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition({
          ...base,
          allowedScenarios: ["missing"]
        }),
      "scenario-mismatch"
    );
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition({
          ...base,
          allowedPolicies: ["missing"]
        }),
      "policy-mismatch"
    );
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition({
          ...base,
          limits: { ...base.limits, workerCount: 3 }
        }),
      "budget-mismatch"
    );
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition({
          ...base,
          limits: { ...base.limits, wallTimeMs: 5 * 60_000 + 1 }
        }),
      "budget-mismatch"
    );
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition({
          ...base,
          limits: { ...base.limits, critiqueCount: 6 }
        }),
      "budget-mismatch"
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved config fails closed on invalid UTF-8, malformed schema and revoked approval", () => {
  const fixture = setup();
  try {
    writeFileSync(
      path.join(fixture.root, "playtest.config.json"),
      Buffer.from([0xff, 0xfe])
    );
    const changed = approval(fixture.root, {
      playtestConfigHash: digest(Buffer.from([0xff, 0xfe]))
    });
    expectCategory(
      () => loadApprovedPlaytestDefinition(changed),
      "config-invalid"
    );
    writeFileSync(
      path.join(fixture.root, "playtest.config.json"),
      JSON.stringify({ ...CONFIG, extra: true }) + "\n"
    );
    const invalid = approval(fixture.root, {
      playtestConfigHash: digest(
        JSON.stringify({ ...CONFIG, extra: true }) + "\n"
      )
    });
    expectCategory(
      () => loadApprovedPlaytestDefinition(invalid),
      "config-invalid"
    );
    writeFileSync(
      path.join(fixture.root, "playtest.config.json"),
      JSON.stringify(CONFIG) + "\n"
    );
    writeFileSync(path.join(fixture.root, "playtest.observation.json"), "{}\n");
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(fixture.root)),
      "target-file-invalid"
    );
    writeFileSync(
      path.join(fixture.root, "playtest.observation.json"),
      OBSERVATION
    );
    const linkedObservation = `${fixture.root}-observation-link`;
    symlinkSync(
      path.join(fixture.root, "playtest.observation.json"),
      linkedObservation
    );
    rmSync(path.join(fixture.root, "playtest.observation.json"));
    symlinkSync(
      linkedObservation,
      path.join(fixture.root, "playtest.observation.json")
    );
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(fixture.root)),
      "target-file-unavailable"
    );
    unlinkSync(path.join(fixture.root, "playtest.observation.json"));
    unlinkSync(linkedObservation);
    writeFileSync(
      path.join(fixture.root, "playtest.observation.json"),
      OBSERVATION
    );
    rmSync(path.join(fixture.root, "playtest.rubric.json"));
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(fixture.root)),
      "target-file-unavailable"
    );
    writeFileSync(path.join(fixture.root, "playtest.rubric.json"), RUBRIC);
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition(
          approval(fixture.root, {
            revokedAt: "2026-10-10T01:00:00.000Z",
            revokedBy: "fixture-operator",
            revocationReason: "fixture revoked"
          })
        ),
      "invalid-approval"
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved config bounds bytes before parsing", () => {
  const fixture = setup();
  try {
    writeFileSync(
      path.join(fixture.root, "playtest.config.json"),
      Buffer.alloc(1024 * 1024 + 1)
    );
    const info = lstatSync(path.join(fixture.root, "playtest.config.json"));
    assert.equal(info.size, 1024 * 1024 + 1);
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition(
          approval(fixture.root, {
            playtestConfigHash: digest(Buffer.alloc(info.size))
          })
        ),
      "config-too-large"
    );
  } finally {
    fixture.cleanup();
  }
});
