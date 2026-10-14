import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultPlaytestRegistryDefaults,
  playtestBenchmarkHashInput,
  PLAYTESTS_ADAPTER_BINDING_SCHEMA,
  PLAYTESTS_GENERIC_ADAPTER_COMMAND,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";

import {
  ApprovedPlaytestConfigurationError,
  loadApprovedPlaytestDefinition
} from "../src/playtesting/approved-configuration.ts";
import { playtestManifestHash } from "../src/playtesting/hash-chain.ts";

const OBSERVATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { room: { type: "string" } },
  required: ["room"]
};

const ADAPTER_BINDING = {
  schema: PLAYTESTS_ADAPTER_BINDING_SCHEMA,
  schemaVersion: 1,
  tier: "declarative",
  entry: "node-fixture-game.mjs",
  factory: "createFixtureGame",
  schemas: {
    observation: OBSERVATION_SCHEMA,
    action: {
      type: "object",
      properties: { actionId: { type: "string" } },
      required: ["actionId"]
    },
    event: {
      type: "object",
      properties: { kind: { type: "string" } },
      required: ["kind"]
    }
  },
  bindings: {
    reset: { export: "reset" },
    observe: { export: "observe" },
    legalActions: { export: "legalActions" },
    step: { export: "step" },
    outcome: { export: "outcome" }
  }
} as const;

const CONFIG = {
  schemaVersion: 1,
  adapter: {
    transport: "stdio-jsonl",
    command: [...PLAYTESTS_GENERIC_ADAPTER_COMMAND]
  },
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
    reviewSelection: {
      surveillanceSessions: 0,
      discoverySessions: 0,
      discoverySignal: null
    },
    visualCapture: "off",
    counterfactuals: "off",
    understandingProbes: "off",
    learningCohorts: "off",
    humanCalibration: "off"
  },
  reporting: { githubIssues: "disabled" }
} as const;

const RUBRIC =
  JSON.stringify({
    schemaVersion: 2,
    workspaceId: "owner/fixture",
    audience: "synthetic-fixture-only",
    registryVersion: "approved-fixture-rubric-v1",
    eventSchemaHash: playtestManifestHash(ADAPTER_BINDING.schemas.event),
    defaults: defaultPlaytestRegistryDefaults(),
    metricDefinitions: [
      {
        metricId: "legal-action-rejection",
        version: 1,
        mechanicKey: "action-execution",
        aggregationWindow: "phase",
        exposurePredicate: "fresh-legal-request-v1",
        eventFields: ["action.offeredIds", "action.expectedRevision"],
        evaluatorRef: "fixture/legal-action-rejection-v1",
        evaluatorHash: "1".repeat(64),
        numerator: "fresh advertised legal requests rejected by engine",
        denominator: "all fresh advertised legal requests",
        unit: "proportion",
        polarity: "lower",
        targetBand: [0, 0],
        notObservable: ["missing-action-or-revision-events"]
      }
    ],
    coverageRequirements: [
      {
        coverageMetricId: "legal-action-rejection",
        mechanicKey: "action-execution",
        phaseId: "tutorial",
        scenarioFamily: "onboarding",
        cohort: "exploratory",
        policy: "random",
        modality: "headless",
        requiredOpportunities: 10,
        requiredIndependentUnits: 1,
        unsupportedReason: null
      }
    ],
    dimensionRubrics: []
  }) + "\n";
const OBSERVATION =
  JSON.stringify({
    schemaVersion: 1,
    schemaHash: playtestManifestHash(OBSERVATION_SCHEMA),
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
  changes: Partial<WorkspacePlaytestApproval> = {},
  configBytes = JSON.stringify(CONFIG) + "\n"
): WorkspacePlaytestApproval {
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
    adapterCommand: [...PLAYTESTS_GENERIC_ADAPTER_COMMAND],
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
      critiqueCount: 5
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

const SAMPLE_FIXTURE_ROOT = fileURLToPath(
  new URL("fixtures/playtesting/", import.meta.url)
);

/** A target game checks its integration into `.autodev/` inside the checkout. */
function autodev(root: string): string {
  return path.join(root, ".autodev");
}

function integration_file(root: string, name: string): string {
  return path.join(root, ".autodev", name);
}

function setupSampleBenchmark(): {
  readonly root: string;
  readonly cleanup: () => void;
  readonly configBytes: Buffer;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "approved-playtest-benchmark-")
  );
  mkdirSync(autodev(root));
  for (const filename of [
    "playtest.config.json",
    "playtest.binding.json",
    "node-fixture-game.mjs",
    "playtest.observation.json",
    "playtest.rubric.json",
    "playtest.benchmark.json"
  ]) {
    copyFileSync(
      path.join(SAMPLE_FIXTURE_ROOT, filename),
      integration_file(root, filename)
    );
  }
  return {
    root,
    configBytes: readFileSync(integration_file(root, "playtest.config.json")),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function setup(): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "approved-playtest-config-")
  );
  mkdirSync(autodev(root));
  writeFileSync(
    integration_file(root, "playtest.config.json"),
    JSON.stringify(CONFIG) + "\n"
  );
  writeFileSync(
    integration_file(root, "playtest.observation.json"),
    OBSERVATION
  );
  writeFileSync(integration_file(root, "playtest.rubric.json"), RUBRIC);
  writeFileSync(
    integration_file(root, "playtest.binding.json"),
    JSON.stringify(ADAPTER_BINDING) + "\n"
  );
  writeFileSync(
    integration_file(root, "node-fixture-game.mjs"),
    "export function createFixtureGame() { return {}; }\n"
  );
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

function rewriteBenchmark(
  root: string,
  changes: Record<string, unknown>
): void {
  const benchmarkPath = integration_file(root, "playtest.benchmark.json");
  const previous = JSON.parse(readFileSync(benchmarkPath, "utf8")) as Record<
    string,
    unknown
  >;
  const updated = { ...previous, ...changes };
  delete updated.contentHash;
  const contentHash = digest(playtestBenchmarkHashInput(updated as never));
  writeFileSync(
    benchmarkPath,
    JSON.stringify({ ...updated, contentHash }) + "\n"
  );
}

test("approved config verifies exact raw-byte digest and bound settings without executing", () => {
  const fixture = setup();
  try {
    const result = loadApprovedPlaytestDefinition(approval(fixture.root));
    assert.equal(result.configHash, approval(fixture.root).playtestConfigHash);
    assert.deepEqual(
      result.configuration.adapter.command,
      PLAYTESTS_GENERIC_ADAPTER_COMMAND
    );
    assert.deepEqual(result.configuration.scenarios, ["tutorial", "edge"]);
  } finally {
    fixture.cleanup();
  }
});

test("approved runtime refuses handwritten protocol commands even when exactly approved", () => {
  const fixture = setup();
  try {
    const legacyConfig = {
      ...CONFIG,
      adapter: { transport: "stdio-jsonl", command: ["node", "adapter.mjs"] }
    };
    const configBytes = JSON.stringify(legacyConfig) + "\n";
    writeFileSync(
      integration_file(fixture.root, "playtest.config.json"),
      configBytes
    );
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition(
          approval(
            fixture.root,
            { adapterCommand: ["node", "adapter.mjs"] },
            configBytes
          )
        ),
      "command-mismatch"
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved runtime verifies the observation contract against the binding schema", () => {
  const fixture = setup();
  try {
    const binding = JSON.parse(
      readFileSync(
        integration_file(fixture.root, "playtest.binding.json"),
        "utf8"
      )
    ) as typeof ADAPTER_BINDING;
    const changed = {
      ...binding,
      schemas: {
        ...binding.schemas,
        observation: {
          ...binding.schemas.observation,
          properties: { room: { type: "number" } }
        }
      }
    };
    writeFileSync(
      integration_file(fixture.root, "playtest.binding.json"),
      JSON.stringify(changed) + "\n"
    );
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(fixture.root)),
      "target-file-invalid"
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved runtime refuses an absent adapter binding before Docker setup", () => {
  const fixture = setup();
  try {
    unlinkSync(integration_file(fixture.root, "playtest.binding.json"));
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(fixture.root)),
      "target-file-unavailable"
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved target bundle loads its rubric registry and content-hashed benchmark", () => {
  const fixture = setupSampleBenchmark();
  try {
    const result = loadApprovedPlaytestDefinition(
      approval(
        fixture.root,
        {
          adapterCommand: [...PLAYTESTS_GENERIC_ADAPTER_COMMAND],
          allowedScenarios: ["tutorial"],
          allowedPolicies: ["random"],
          limits: { ...approval(fixture.root).limits, critiqueCount: 0 }
        },
        fixture.configBytes.toString("utf8")
      )
    );
    assert.equal(
      result.benchmark?.benchmarkId,
      "benchmark-synthetic-fixture-v1"
    );
    assert.equal(result.benchmark?.workspaceId, "owner/fixture");
    assert.equal(result.benchmarkHash, result.benchmark?.contentHash);
    assert.equal(result.rubricHash, result.benchmark?.rubricHash);
    assert.deepEqual(
      result.rubric.metricDefinitions.map((metric) => metric.metricId),
      ["legal-action-rejection"]
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved target bundle refuses a stale benchmark content hash", () => {
  const fixture = setupSampleBenchmark();
  try {
    const benchmarkPath = integration_file(
      fixture.root,
      "playtest.benchmark.json"
    );
    const benchmark = JSON.parse(readFileSync(benchmarkPath, "utf8")) as {
      contentHash: string;
      [key: string]: unknown;
    };
    writeFileSync(
      benchmarkPath,
      JSON.stringify({ ...benchmark, contentHash: "f".repeat(64) }) + "\n"
    );
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition(
          approval(
            fixture.root,
            {
              adapterCommand: [...PLAYTESTS_GENERIC_ADAPTER_COMMAND],
              allowedScenarios: ["tutorial"],
              allowedPolicies: ["random"],
              limits: { ...approval(fixture.root).limits, critiqueCount: 0 }
            },
            fixture.configBytes.toString("utf8")
          )
        ),
      "target-file-invalid"
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved target bundle rejects a well-hashed benchmark for another workspace", () => {
  const fixture = setupSampleBenchmark();
  try {
    rewriteBenchmark(fixture.root, { workspaceId: "other/workspace" });
    expectCategory(
      () =>
        loadApprovedPlaytestDefinition(
          approval(
            fixture.root,
            {
              adapterCommand: [...PLAYTESTS_GENERIC_ADAPTER_COMMAND],
              allowedScenarios: ["tutorial"],
              allowedPolicies: ["random"],
              limits: { ...approval(fixture.root).limits, critiqueCount: 0 }
            },
            fixture.configBytes.toString("utf8")
          )
        ),
      "benchmark-mismatch"
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved config rejects changed bytes before parsing or execution", () => {
  const fixture = setup();
  try {
    writeFileSync(
      integration_file(fixture.root, "playtest.config.json"),
      "{}\n"
    );
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
    rmSync(integration_file(fixture.root, "playtest.config.json"));
    symlinkSync(
      outsideFile,
      integration_file(fixture.root, "playtest.config.json")
    );
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
    expectCategory(() => {
      const overBudgetConfig =
        JSON.stringify({
          ...CONFIG,
          analysis: { ...CONFIG.analysis, maxReviewedSessions: 6 }
        }) + "\n";
      writeFileSync(
        integration_file(fixture.root, "playtest.config.json"),
        overBudgetConfig
      );
      return loadApprovedPlaytestDefinition(
        approval(
          fixture.root,
          { playtestConfigHash: digest(overBudgetConfig) },
          overBudgetConfig
        )
      );
    }, "budget-mismatch");
  } finally {
    fixture.cleanup();
  }
});

test("approved config fails closed on invalid UTF-8, malformed schema and revoked approval", () => {
  const fixture = setup();
  try {
    writeFileSync(
      integration_file(fixture.root, "playtest.config.json"),
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
      integration_file(fixture.root, "playtest.config.json"),
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
      integration_file(fixture.root, "playtest.config.json"),
      JSON.stringify(CONFIG) + "\n"
    );
    writeFileSync(
      integration_file(fixture.root, "playtest.observation.json"),
      "{}\n"
    );
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(fixture.root)),
      "target-file-invalid"
    );
    writeFileSync(
      integration_file(fixture.root, "playtest.observation.json"),
      OBSERVATION
    );
    const linkedObservation = `${fixture.root}-observation-link`;
    symlinkSync(
      integration_file(fixture.root, "playtest.observation.json"),
      linkedObservation
    );
    rmSync(integration_file(fixture.root, "playtest.observation.json"));
    symlinkSync(
      linkedObservation,
      integration_file(fixture.root, "playtest.observation.json")
    );
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(fixture.root)),
      "target-file-unavailable"
    );
    unlinkSync(integration_file(fixture.root, "playtest.observation.json"));
    unlinkSync(linkedObservation);
    writeFileSync(
      integration_file(fixture.root, "playtest.observation.json"),
      OBSERVATION
    );
    rmSync(integration_file(fixture.root, "playtest.rubric.json"));
    expectCategory(
      () => loadApprovedPlaytestDefinition(approval(fixture.root)),
      "target-file-unavailable"
    );
    writeFileSync(
      integration_file(fixture.root, "playtest.rubric.json"),
      RUBRIC
    );
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
      integration_file(fixture.root, "playtest.config.json"),
      Buffer.alloc(1024 * 1024 + 1)
    );
    const info = lstatSync(
      integration_file(fixture.root, "playtest.config.json")
    );
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
