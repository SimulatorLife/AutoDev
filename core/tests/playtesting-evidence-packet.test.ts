import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalPlaytestJson } from "../src/playtesting/canonical-json.ts";
import {
  aggregatePlaytestCrossSessionMetrics,
  assertPlaytestCrossSessionMetricAggregation,
  assertPlaytestEvidenceLocatorsWithinPacket,
  assertPlaytestEvidencePacket,
  buildPlaytestCoverageManifestDraft,
  buildPlaytestEvidencePacket,
  defaultPlaytestRegistryDefaults,
  expandPlaytestRegistry,
  type PlaytestBatchAssignment,
  type PlaytestCoverageEpisode,
  playtestCoverageManifestHashInput,
  playtestCoveragePlanForRegistry,
  playtestCrossSessionInventoryHashInput,
  type PlaytestEpisode,
  type PlaytestEvidenceLocator,
  type PlaytestEvidenceTraceStep,
  type PlaytestMetricRegistry,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V2
} from "../src/playtesting/index.ts";

const WORKSPACE_ID = "owner/evidence-fixture";
const BATCH_ID = "batch-evidence-1";
const BUILD_SHA = "a".repeat(40);
const RUBRIC_HASH = "b".repeat(64);
const EVALUATOR_HASH = "c".repeat(64);
const GENERATED_AT = "2026-10-12T00:00:00.000Z";

function registry(
  analysisUnit: "episode" | "learner-identity" = "episode"
): PlaytestMetricRegistry {
  return expandPlaytestRegistry({
    schemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    audience: "first-time-adult",
    registryVersion: "evidence-fixture-v1",
    eventSchemaHash: "d".repeat(64),
    defaults: defaultPlaytestRegistryDefaults(),
    metricDefinitions: [
      {
        metricId: "decision-rate",
        version: 1,
        mechanicKey: "race-choice",
        analysisUnit,
        scenarioEligibility: ["tutorial"],
        aggregationWindow: "phase",
        exposurePredicate: "eligible-race-decision-v1",
        eventFields: ["decision.legalActions", "decision.selectedAction"],
        evaluatorRef: "game/evaluators.ts#decision-rate",
        evaluatorHash: EVALUATOR_HASH,
        numerator: "positive eligible decisions",
        denominator: "all eligible race decisions",
        unit: "proportion",
        polarity: "higher",
        targetBand: [0.4, 1],
        notObservable: ["unobserved"]
      }
    ],
    coverageRequirements: [
      {
        coverageMetricId: "decision-rate",
        mechanicKey: "race-choice",
        phaseId: "race",
        scenarioFamily: "tutorial-family",
        cohort: "novice",
        policy: "heuristic",
        modality: "headless",
        requiredOpportunities: 1,
        requiredIndependentUnits: 1,
        unsupportedReason: null
      }
    ],
    dimensionRubrics: []
  });
}

function assignment(): PlaytestBatchAssignment {
  return {
    assignmentId: "assignment-1",
    scenarioId: "tutorial",
    scenarioFamily: "tutorial-family",
    policyId: "heuristic",
    policyVersion: "heuristic-v1",
    cohort: "novice",
    seed: "seed-1",
    maxSteps: 12
  };
}

function metric() {
  return {
    metricId: "decision-rate",
    metricVersion: 1,
    phaseId: "race",
    numerator: 1,
    denominator: 1,
    opportunityCount: 1,
    coverage: 1,
    unit: "proportion",
    estimate: 1,
    missing: 0,
    missingReasons: [],
    independentUnits: 1,
    provenance: {
      workspaceId: WORKSPACE_ID,
      buildSha: BUILD_SHA,
      evaluatorHash: EVALUATOR_HASH,
      rubricHash: RUBRIC_HASH,
      measurementVersion: "playtesting-measurement-v2",
      generatedAt: GENERATED_AT
    },
    notes: "One observed opportunity."
  } as const;
}

function episode(): PlaytestEpisode {
  return {
    schema: PLAYTESTS_EPISODE_SCHEMA,
    episodeId: "episode-1",
    revision: 1,
    batchId: BATCH_ID,
    assignmentId: "assignment-1",
    branchLineage: null,
    identity: {
      workspaceId: WORKSPACE_ID,
      repository: WORKSPACE_ID,
      buildSha: BUILD_SHA,
      gameBuild: "fixture-build-v1",
      scenarioId: "tutorial",
      configHash: "e".repeat(64),
      seed: "seed-1",
      rngInitialStateHash: null,
      rngAlgorithm: null,
      rngVersion: null,
      policyId: "heuristic",
      policyVersion: "heuristic-v1",
      modelId: null,
      modelRevision: null,
      observationSchemaHash: "f".repeat(64),
      actionSchemaHash: "1".repeat(64),
      eventSchemaHash: "2".repeat(64),
      protocolVersion: 1,
      runtimeVersion: "runtime-v1",
      environmentHash: "3".repeat(64)
    },
    scenarioFamily: "tutorial-family",
    policyCohort: "novice",
    strategy: "advance-first",
    status: "completed",
    termination: { reason: "game-terminal", step: 11 },
    outcome: "win",
    outcomeMetrics: { score: 14 },
    completionCounts: {
      assigned: 1,
      started: 1,
      completed: 1,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 1
    },
    replayStatus: "trace-replayable",
    trace: { kind: "replay-segment", id: "trace-artifact-1" },
    frames: [{ kind: "frame", id: "frame-1", frameIndex: 0, step: 5 }],
    stepCount: 12,
    metrics: [metric()],
    findingIds: [],
    assignedAt: GENERATED_AT,
    startedAt: GENERATED_AT,
    completedAt: GENERATED_AT,
    simulationWallMs: 120,
    logicalTicks: 12,
    policyInferenceMs: 9,
    nativeDurationMs: null,
    completeness: "complete",
    missingReasons: []
  };
}

function traceSteps(withEvents = true): readonly PlaytestEvidenceTraceStep[] {
  return Array.from({ length: 12 }, (_, step) => ({
    step,
    phaseId: "race",
    revisionBefore: step,
    revisionAfter: step + 1,
    observationVisibility: "structured" as const,
    visibleObservation: { race: { fuel: 12 - step } },
    legalActionIds: ["advance", "wait"],
    selectedActionId: "advance",
    preActionPrediction: null,
    authoritativeOutcome: null,
    events:
      withEvents && step === 5
        ? [
            {
              eventId: "event-5",
              type: "source-reported-event",
              phaseId: "race",
              revision: step + 1
            }
          ]
        : [],
    frameRefs:
      step === 5
        ? [
            {
              kind: "frame" as const,
              id: "frame-1",
              frameIndex: 0,
              step
            }
          ]
        : []
  }));
}

function coverageManifest() {
  const run = assignment();
  const episodeEvidence: PlaytestCoverageEpisode = {
    episodeId: "episode-1",
    batchId: BATCH_ID,
    assignmentId: run.assignmentId,
    identity: {
      workspaceId: WORKSPACE_ID,
      buildSha: BUILD_SHA,
      scenarioId: run.scenarioId,
      policyId: run.policyId,
      policyVersion: run.policyVersion,
      seed: run.seed
    },
    scenarioFamily: run.scenarioFamily,
    policyCohort: "novice",
    metrics: [metric()]
  };
  const draft = buildPlaytestCoverageManifestDraft({
    rubricHash: RUBRIC_HASH,
    assignmentManifestHash: "4".repeat(64),
    mode: "headless",
    generatedAt: GENERATED_AT,
    batchId: BATCH_ID,
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    plan: playtestCoveragePlanForRegistry(registry()),
    assignments: [run],
    episodes: [episodeEvidence]
  });
  return {
    ...draft,
    contentHash: createHash("sha256")
      .update(playtestCoverageManifestHashInput(draft))
      .digest("hex")
  };
}

function build(overrides: Record<string, unknown> = {}) {
  return buildPlaytestEvidencePacket({
    packetId: "packet-1",
    episode: episode(),
    assignment: assignment(),
    registry: registry(),
    coverageManifest: coverageManifest(),
    crossSessionCandidates: [],
    crossSessionSelectionSeed: "cross-session-fixture-seed-v1",
    crossSessionInventoryHash: hashCrossSessionInventory([]),
    rubricHash: RUBRIC_HASH,
    measurementVersion: "playtesting-measurement-v2",
    traceHash: "5".repeat(64),
    traceSteps: traceSteps(),
    frameHashes: { "frame-1": "6".repeat(64) },
    modelId: null,
    modelRevision: null,
    promptHash: null,
    tokenBudget: 32_768,
    generatedAt: GENERATED_AT,
    maxWindows: 4,
    maxSelectedSteps: 12,
    windowRadius: 0,
    ...overrides
  });
}

function hashCrossSessionInventory(
  candidates: Parameters<typeof playtestCrossSessionInventoryHashInput>[0]
): string {
  return createHash("sha256")
    .update(playtestCrossSessionInventoryHashInput(candidates))
    .digest("hex");
}

test("evidence packet always carries terminal and event-bearing steps plus deterministic ordinary context", () => {
  const packet = build();
  assert.equal(packet.schema, PLAYTESTS_EVIDENCE_PACKET_SCHEMA);
  assert.deepEqual(
    packet.selectedWindows.map((window) => [window.startStep, window.endStep]),
    [
      [2, 2],
      [5, 5],
      [8, 8],
      [11, 11]
    ]
  );
  assert.ok(
    packet.selectedWindows.some((window) =>
      window.selectionReasons.includes("event-bearing-step")
    )
  );
  assert.ok(
    packet.selectedWindows.some((window) =>
      window.selectionReasons.includes("terminal")
    )
  );
  assert.deepEqual(packet.omittedWindows, [
    { startStep: 0, endStep: 1, reason: "ordinary-sampling" },
    { startStep: 3, endStep: 4, reason: "ordinary-sampling" },
    { startStep: 6, endStep: 7, reason: "ordinary-sampling" },
    { startStep: 9, endStep: 10, reason: "ordinary-sampling" }
  ]);
  assert.deepEqual(packet.suppliedArtifacts, [
    { kind: "frame", artifactId: "frame-1", sha256: "6".repeat(64) },
    {
      kind: "trace",
      artifactId: "trace-artifact-1",
      sha256: "5".repeat(64)
    }
  ]);
  assert.equal(packet.visibleEvidenceOnly, true);
  assert.equal(packet.modelId, null);
  assert.deepEqual(packet.crossSessionContext, {
    status: "unavailable",
    reason: "No other complete persisted episode exists in this batch.",
    inventoryHash: hashCrossSessionInventory([]),
    eligibleSessions: 0
  });
  assert.doesNotThrow(() => assertPlaytestEvidencePacket(packet));
});

test("cross-session aggregate uses ratio-of-sums and keeps exact metric strata", () => {
  const first = build();
  const second = {
    ...first,
    packetId: "packet-2",
    episodeId: "episode-2",
    assignmentId: "assignment-2",
    metrics: [
      {
        ...metric(),
        numerator: 1,
        denominator: 4,
        opportunityCount: 5,
        coverage: 0.8,
        estimate: 0.25,
        missing: 1
      }
    ]
  };
  const aggregation = aggregatePlaytestCrossSessionMetrics({
    workspaceId: WORKSPACE_ID,
    analysisId: "analysis-1",
    packets: [
      { episodeId: first.episodeId, batchId: first.batchId, packet: first },
      { episodeId: second.episodeId, batchId: second.batchId, packet: second }
    ]
  });

  assert.equal(aggregation.status, "available");
  assert.equal(aggregation.rows.length, 1);
  assert.deepEqual(aggregation.rows[0]?.sourcePacketIndices, [0, 1]);
  assert.deepEqual(
    aggregation.sourcePackets.map((packet) => packet.packetId),
    ["packet-1", "packet-2"]
  );
  assert.equal(aggregation.rows[0]?.numerator, 2);
  assert.equal(aggregation.rows[0]?.denominator, 5);
  assert.equal(aggregation.rows[0]?.opportunityCount, 6);
  assert.equal(aggregation.rows[0]?.missing, 1);
  assert.equal(aggregation.rows[0]?.estimate, 0.4);
  assert.equal(aggregation.rows[0]?.coverage, 5 / 6);
  assert.equal(aggregation.rows[0]?.independentUnits, 2);
  assert.doesNotThrow(() =>
    assertPlaytestCrossSessionMetricAggregation(
      aggregation,
      WORKSPACE_ID,
      "analysis-1",
      ["episode-1", "episode-2"]
    )
  );
  assert.throws(
    () =>
      assertPlaytestCrossSessionMetricAggregation(
        aggregation,
        WORKSPACE_ID,
        "analysis-1",
        ["episode-1"]
      ),
    /sorted trusted selection/u
  );
  assert.throws(
    () =>
      assertPlaytestCrossSessionMetricAggregation(
        {
          ...aggregation,
          rows: [{ ...aggregation.rows[0]!, estimate: 0.9 }]
        },
        WORKSPACE_ID,
        "analysis-1",
        ["episode-1", "episode-2"]
      ),
    /sufficient statistics/u
  );

  const differentCohort = {
    ...second,
    packetId: "packet-3",
    episodeId: "episode-3",
    assignmentId: "assignment-3",
    cohort: "expert"
  };
  const separated = aggregatePlaytestCrossSessionMetrics({
    workspaceId: WORKSPACE_ID,
    analysisId: "analysis-2",
    packets: [
      { episodeId: first.episodeId, batchId: first.batchId, packet: first },
      {
        episodeId: differentCohort.episodeId,
        batchId: differentCohort.batchId,
        packet: differentCohort
      }
    ]
  });
  assert.equal(separated.rows.length, 2);
  assert.deepEqual(separated.rows.map((row) => row.cohort).sort(), [
    "expert",
    "novice"
  ]);
});

test("cross-session aggregates never sum non-episode independent-unit counts", () => {
  const first = build({ registry: registry("learner-identity") });
  const second = {
    ...first,
    packetId: "packet-2",
    episodeId: "episode-2",
    assignmentId: "assignment-2",
    metrics: [
      {
        ...metric(),
        numerator: 1,
        denominator: 2,
        opportunityCount: 2,
        coverage: 1,
        estimate: 0.5,
        independentUnits: 1
      }
    ]
  };
  const aggregation = aggregatePlaytestCrossSessionMetrics({
    workspaceId: WORKSPACE_ID,
    analysisId: "analysis-learner",
    packets: [
      { episodeId: first.episodeId, batchId: first.batchId, packet: first },
      { episodeId: second.episodeId, batchId: second.batchId, packet: second }
    ]
  });
  assert.equal(aggregation.status, "available");
  assert.equal(aggregation.rows[0]?.independentUnits, null);
});

test("historical packets are not pooled when frozen aggregation semantics are absent", () => {
  const first = build();
  const oldIntent = first.metricIntent.map(
    ({
      analysisUnit: _unit,
      aggregationWindow: _window,
      aggregation: _aggregation,
      ...intent
    }) => intent
  );
  const historical = {
    ...first,
    schema: PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V2,
    packetId: "packet-2",
    episodeId: "episode-2",
    assignmentId: "assignment-2",
    metricIntent: oldIntent
  };
  const aggregation = aggregatePlaytestCrossSessionMetrics({
    workspaceId: WORKSPACE_ID,
    analysisId: "analysis-historical",
    packets: [
      { episodeId: first.episodeId, batchId: first.batchId, packet: first },
      {
        episodeId: historical.episodeId,
        batchId: historical.batchId,
        packet: historical
      }
    ]
  });
  assert.equal(aggregation.status, "unavailable");
  assert.equal(
    aggregation.reason,
    "historical-packet-predates-aggregation-semantics"
  );
  assert.deepEqual(aggregation.rows, []);
});

test("cross-session packets include a deterministic bounded sibling sample and scoped citations", () => {
  const candidates = Array.from({ length: 5 }, (_, index) => {
    const assignmentId = `sibling-assignment-${String(index + 1)}`;
    const seed = `sibling-seed-${String(index + 1)}`;
    return {
      assignment: {
        ...assignment(),
        assignmentId,
        seed
      },
      episode: {
        ...episode(),
        episodeId: `sibling-episode-${String(index + 1)}`,
        assignmentId,
        identity: { ...episode().identity, seed }
      }
    };
  });
  const crossSessionInventoryHash = hashCrossSessionInventory(candidates);
  const packet = build({
    crossSessionCandidates: candidates,
    crossSessionSelectionSeed: "frozen-selection-seed-v1",
    crossSessionInventoryHash
  });
  assert.equal(packet.crossSessionContext.status, "included");
  if (packet.crossSessionContext.status !== "included") {
    assert.fail("Expected an included sibling sample.");
  }
  assert.equal(packet.crossSessionContext.eligibleSessions, 5);
  assert.equal(packet.crossSessionContext.sessions.length, 4);
  assert.equal(packet.crossSessionContext.inclusionProbability, 0.8);
  assert.deepEqual(
    build({
      crossSessionCandidates: [...candidates].reverse(),
      crossSessionSelectionSeed: "frozen-selection-seed-v1",
      crossSessionInventoryHash
    }).crossSessionContext,
    packet.crossSessionContext
  );
  const siblingEpisodeId = packet.crossSessionContext.sessions[0]!.episodeId;
  assert.doesNotThrow(() =>
    assertPlaytestEvidenceLocatorsWithinPacket(
      [{ kind: "episode", id: siblingEpisodeId }],
      packet
    )
  );
  assert.throws(
    () =>
      assertPlaytestEvidenceLocatorsWithinPacket(
        [{ kind: "episode", id: siblingEpisodeId, step: 0 }],
        packet
      ),
    /sibling at unsupported granularity/u
  );
});

test("packet validator preserves v1/v2 history and rejects malformed v3 context", () => {
  const packet = build();
  const { crossSessionContext: _crossSessionContext, ...legacyFields } = packet;
  const legacyIntent = packet.metricIntent.map(
    ({
      analysisUnit: _analysisUnit,
      aggregationWindow: _window,
      aggregation: _aggregation,
      ...intent
    }) => intent
  );
  const legacyPacket = {
    ...legacyFields,
    schema: PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1,
    metricIntent: legacyIntent
  };
  assert.doesNotThrow(() => assertPlaytestEvidencePacket(legacyPacket));
  assert.doesNotThrow(() =>
    assertPlaytestEvidencePacket({
      ...packet,
      schema: PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V2,
      metricIntent: legacyIntent
    })
  );
  assert.throws(
    () =>
      assertPlaytestEvidencePacket({
        ...packet,
        crossSessionContext: {
          status: "unavailable",
          reason: "",
          inventoryHash: hashCrossSessionInventory([]),
          eligibleSessions: 0
        }
      }),
    /unavailable cross-session context is malformed/u
  );
});

test("evidence packet refuses hidden/unverified trace data, assignment drift and missing mandatory windows", () => {
  assert.throws(
    () =>
      build({
        traceSteps: traceSteps().map((step, index) =>
          index === 3
            ? ({ ...step, checkpoint: { stateHash: "hidden" } } as unknown)
            : step
        )
      }),
    /malformed or not player-visible/u
  );
  assert.throws(
    () =>
      build({
        traceSteps: traceSteps().map((step, index) =>
          index === 3 ? { ...step, observationVisibility: "unverified" } : step
        )
      }),
    /malformed or not player-visible/u
  );
  assert.throws(
    () => build({ assignment: { ...assignment(), cohort: "expert" } }),
    /frozen episode, rubric and coverage identities/u
  );
  assert.throws(
    () =>
      build({
        traceSteps: traceSteps().map((step) => ({
          ...step,
          events: [
            {
              eventId: `event-${String(step.step)}`,
              type: "source-reported-event",
              phaseId: "race",
              revision: step.revisionBefore + 1
            }
          ]
        })),
        maxWindows: 4,
        maxSelectedSteps: 3
      }),
    /Mandatory event and terminal evidence exceeds/u
  );
});

test("packet byte/token cap may omit ordinary windows but never mandatory event or terminal evidence", () => {
  const minimal = build({ maxWindows: 2, maxSelectedSteps: 6 });
  const full = build();
  const minimalBytes = Buffer.byteLength(
    canonicalPlaytestJson(minimal),
    "utf8"
  );
  const fullBytes = Buffer.byteLength(canonicalPlaytestJson(full), "utf8");
  const budget = Math.floor((minimalBytes + fullBytes) / 2);
  const packet = build({ tokenBudget: budget, maxPacketBytes: budget });
  assert.ok(
    packet.selectedWindows.some((window) =>
      window.selectionReasons.includes("event-bearing-step")
    )
  );
  assert.ok(
    packet.selectedWindows.some((window) =>
      window.selectionReasons.includes("terminal")
    )
  );
  assert.ok(
    packet.omittedWindows.some((window) => window.reason === "packet-budget")
  );
  assert.doesNotThrow(() => assertPlaytestEvidencePacket(packet));
  assert.throws(
    () => build({ tokenBudget: 1, maxPacketBytes: 1 }),
    /Mandatory event and terminal evidence exceeds/u
  );
});

test("generic decision events are sampled so long completed episodes retain review packets", () => {
  const trace = Array.from({ length: 1200 }, (_, step) => ({
    step,
    phaseId: "race_and_energy",
    revisionBefore: step,
    revisionAfter: step + 1,
    observationVisibility: "structured" as const,
    visibleObservation: { phaseId: "race_and_energy", progress: step },
    legalActionIds: ["advance-segment"],
    selectedActionId: "advance-segment",
    preActionPrediction: null,
    authoritativeOutcome: null,
    events: [
      {
        eventId: `decision-${String(step)}`,
        type: "decision_applied",
        phaseId: "race_and_energy",
        revision: step + 1
      }
    ],
    frameRefs: []
  }));
  const packet = build({
    episode: { ...episode(), stepCount: trace.length },
    traceSteps: trace,
    maxWindows: 32,
    maxSelectedSteps: 256,
    windowRadius: 2,
    tokenBudget: 32_768,
    maxPacketBytes: 64 * 1024
  });
  const selectedSteps = packet.selectedWindows.flatMap(
    (window) => window.steps
  );
  assert.ok(packet.selectedWindows.length <= 32);
  assert.ok(selectedSteps.length <= 256);
  assert.ok(
    selectedSteps.some((step) =>
      step.events.some((event) => event.type === "decision_applied")
    )
  );
  assert.ok(packet.omittedWindows.length > 0);
  assert.doesNotThrow(() => assertPlaytestEvidencePacket(packet));
});

test("specific event anchors in a long episode fit the bounded analyst packet", () => {
  const eventAt = new Map<number, string>([
    [3, "race_started"],
    ...[
      4, 8, 10, 11, 12, 15, 18, 25, 70, 140, 210, 280, 350, 420, 490, 560, 630
    ].map((step) => [step, "card_played"] as const),
    [800, "race_settled"],
    [1400, "reward_claimed"],
    [1700, "race_started"]
  ]);
  const trace = Array.from({ length: 1985 }, (_, step) => {
    const eventType =
      step === 1984 ? "run_ended" : (eventAt.get(step) ?? "decision_applied");
    return {
      step,
      phaseId: "race_and_energy",
      revisionBefore: step,
      revisionAfter: step + 1,
      observationVisibility: "structured" as const,
      visibleObservation: {
        phaseId: "race_and_energy",
        bankroll_gold: 50,
        races_completed: step === 1984 ? 3 : 0,
        selected_ticket_ids: ["ticket-a", "ticket-b"],
        hand_card_ids: [4, 3, 8, 2],
        running_order: ["car-1", "car-2", "car-3", "car-4", "car-5", "car-6"],
        running_order_route_progress: [1180, 1082, 1082, 984, 592, 143.65],
        running_order_pit_phase: [null, null, "pit_lane", null, null, null],
        running_order_pit_route_progress: [
          null,
          null,
          490.12,
          null,
          null,
          null
        ],
        running_order_pit_service_remaining_seconds: [
          null,
          null,
          10,
          null,
          null,
          null
        ],
        running_order_pit_tire_service_duration_seconds: [
          null,
          null,
          2.33,
          null,
          null,
          null
        ]
      },
      legalActionIds: ["advance-segment"],
      selectedActionId: "advance-segment",
      preActionPrediction: null,
      authoritativeOutcome: null,
      events: [
        {
          eventId: `event-${String(step)}`,
          type: eventType,
          phaseId: "race_and_energy",
          revision: step + 1
        }
      ],
      frameRefs: []
    };
  });
  const packet = build({
    episode: {
      ...episode(),
      stepCount: trace.length,
      termination: { reason: "game-terminal", step: trace.length - 1 }
    },
    traceSteps: trace,
    maxWindows: 32,
    maxSelectedSteps: 256,
    windowRadius: 2,
    tokenBudget: 32_768,
    maxPacketBytes: 64 * 1024
  });
  assert.ok(packet.selectedWindows.length <= 32);
  assert.ok(
    packet.selectedWindows.some((window) =>
      window.selectionReasons.includes("terminal")
    )
  );
  assert.ok(
    packet.omittedWindows.some(
      (window) => window.reason === "ordinary-sampling"
    )
  );
  assert.doesNotThrow(() => assertPlaytestEvidencePacket(packet));
});

test("packet validator rejects omissions that do not partition the complete source trace", () => {
  const packet = build();
  assert.throws(
    () =>
      assertPlaytestEvidencePacket({
        ...packet,
        omittedWindows: []
      }),
    /do not partition the source trace|leave source steps unaccounted/u
  );
});

test("review citations resolve only to selected packet windows and supplied artifacts", () => {
  const packet = build();
  const validLocators: PlaytestEvidenceLocator[] = [
    { kind: "episode", id: "episode-1", step: 5 },
    { kind: "replay-segment", id: "trace-artifact-1", step: 2 },
    {
      kind: "event",
      id: "event-5",
      step: 5,
      revision: 6,
      phaseId: "race"
    },
    { kind: "frame", id: "frame-1", frameIndex: 0, step: 5 }
  ];
  assert.doesNotThrow(() =>
    assertPlaytestEvidenceLocatorsWithinPacket(validLocators, packet)
  );

  const outsidePacket: PlaytestEvidenceLocator[] = [
    { kind: "episode", id: "episode-1", step: 4 },
    { kind: "replay-segment", id: "another-trace", step: 5 },
    { kind: "event", id: "event-5", step: 8 },
    { kind: "frame", id: "frame-unseen", frameIndex: 1, step: 5 }
  ];
  for (const locator of outsidePacket) {
    assert.throws(
      () => assertPlaytestEvidenceLocatorsWithinPacket([locator], packet),
      /outside|absent/u
    );
  }
});

test("packet construction rejects event IDs that cannot identify one source event", () => {
  assert.throws(
    () =>
      build({
        traceSteps: traceSteps().map((step) =>
          step.step === 8
            ? {
                ...step,
                events: [
                  {
                    eventId: "event-5",
                    type: "source-reported-event",
                    phaseId: "race",
                    revision: step.revisionAfter!
                  }
                ]
              }
            : step
        )
      }),
    /duplicate event ID/u
  );
});

test("packet records a missing frame explicitly without fabricating a frame locator", () => {
  const packet = build({
    traceSteps: traceSteps().map((step) =>
      step.step === 5 ? { ...step, frameRefs: [] } : step
    ),
    frameHashes: {},
    omittedArtifacts: [
      {
        kind: "frame",
        artifactId: "frame-1",
        step: 5,
        reason: "missing"
      }
    ]
  });
  assert.deepEqual(packet.omittedArtifacts, [
    { kind: "frame", artifactId: "frame-1", step: 5, reason: "missing" }
  ]);
  assert.equal(
    packet.selectedWindows.some((window) =>
      window.steps.some((step) =>
        step.frameRefs.some((frame) => frame.id === "frame-1")
      )
    ),
    false
  );
  assert.deepEqual(packet.suppliedArtifacts, [
    {
      kind: "trace",
      artifactId: "trace-artifact-1",
      sha256: "5".repeat(64)
    }
  ]);
  assert.doesNotThrow(() => assertPlaytestEvidencePacket(packet));
});
