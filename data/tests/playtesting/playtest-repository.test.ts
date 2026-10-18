import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertPlaytestAssignmentManifest,
  assertPlaytestCoverageManifest,
  buildPlaytestCoverageManifestDraft,
  buildPlaytestFindingIdentity,
  type HumanPlaytestStudy,
  type PlaytestAdapterBatch,
  type PlaytestAssignmentManifestDraft,
  playtestAssignmentManifestHashInput,
  type PlaytestAssignmentOutcome,
  type PlaytestBatch,
  type PlaytestBenchmark,
  playtestBenchmarkHashInput,
  type PlaytestComparison,
  playtestCoverageManifestHashInput,
  type PlaytestCrossSessionSynthesis,
  type PlaytestDiscoverySessionReview,
  type PlaytestEpisode,
  type PlaytestExperiment,
  playtestExperimentHashInput,
  type PlaytestFinding,
  playtestFindingIdentityHashInput,
  playtestReviewOutcomeKey,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V1,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V2,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V3,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA_V1,
  PLAYTESTS_BATCH_SCHEMA_V2,
  PLAYTESTS_BATCH_SCHEMA_V3,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_COMPARISON_SCHEMA_V1,
  PLAYTESTS_COVERAGE_MANIFEST_SCHEMA,
  PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA_V1,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA_V1,
  PLAYTESTS_EPISODE_SCHEMA_V2,
  PLAYTESTS_EPISODE_SCHEMA_V3,
  PLAYTESTS_EPISODE_SCHEMA_V4,
  PLAYTESTS_EPISODE_SCHEMA_V5,
  PLAYTESTS_EPISODE_SCHEMA_V6,
  PLAYTESTS_EPISODE_SCHEMA_V7,
  PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_EXPERIMENT_SCHEMA,
  PLAYTESTS_HUMAN_STUDY_SCHEMA,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
  PLAYTESTS_REVIEW_SELECTION_SCHEMA,
  PLAYTESTS_REVIEW_STRATIFICATION,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V1,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V2,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V3,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V4,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V5,
  PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
  type PlaytestSessionReview,
  type PlaytestVisualBatch,
  selectPlaytestBatchReviews
} from "@simulatorlife/autodev-core";

import {
  type PlaytestHumanAggregateRecord,
  PlaytestInvalidCursorError,
  type PlaytestLaunchIntent,
  PlaytestRepository,
  PlaytestSourceUnavailableError
} from "../../src/playtesting/index.ts";
import {
  decodeBatch,
  decodeComparison,
  decodeCrossSessionSynthesis,
  decodeDiscoveryReview,
  decodeEpisode,
  decodeExperiment,
  decodeFinding,
  decodeReview,
  encodeBatch,
  encodeBenchmark,
  encodeComparison,
  encodeCrossSessionSynthesis,
  encodeDiscoveryReview,
  encodeEpisode,
  encodeExperiment,
  encodeFinding,
  encodeHumanStudy,
  encodeHumanSummary,
  encodeReview,
  migrateLegacyEpisodeForStorage
} from "../../src/playtesting/row-codec.ts";

const BUILD_SHA_A = "a".repeat(40);
const BUILD_SHA_B = "b".repeat(40);
const CONFIG_HASH = "c".repeat(64);
const OBSERVATION_SCHEMA_HASH = "d".repeat(64);
const ACTION_SCHEMA_HASH = "e".repeat(64);
const EVENT_SCHEMA_HASH = "f".repeat(64);

function counts() {
  return {
    assigned: 1,
    started: 1,
    completed: 1,
    crashed: 0,
    infrastructureFailed: 0,
    cancelled: 0,
    budgetTruncated: 0,
    reviewed: 0,
    eligible: 1
  } as const;
}

function episode(
  index: number,
  workspaceId = "workspace-a/game"
): PlaytestEpisode {
  const timestamp = new Date(
    Date.UTC(2026, 9, 1, 0, 0, index % 60)
  ).toISOString();
  return {
    schema: PLAYTESTS_EPISODE_SCHEMA,
    episodeId: `episode-${String(index).padStart(5, "0")}`,
    revision: 1,
    batchId: `batch-${Math.floor(index / 20)}`,
    assignmentId: `a-${String(index).padStart(5, "0")}`,
    branchLineage: null,
    executionProvenance: {
      mode: "adapter-accelerated",
      source: {
        kind: "repo-checkout",
        repository: "synthetic/game",
        revision: null,
        revisionConfidence: "unknown",
        checkoutState: "unknown",
        artifactFingerprint: null,
        targetId: null,
        targetOrigin: null
      },
      observationSource: "engine-adapter",
      actionSource: "engine-policy",
      derivedFrom: null
    },
    identity: {
      workspaceId,
      repository: "synthetic/game",
      buildSha: index % 2 ? BUILD_SHA_A : BUILD_SHA_B,
      gameBuild: "game-v1",
      scenarioId: index % 2 ? "tutorial" : "arena",
      configHash: CONFIG_HASH,
      seed: String(index),
      rngInitialStateHash: null,
      rngAlgorithm: "pcg32",
      rngVersion: "1",
      policyId: index % 3 ? "heuristic" : "expert",
      policyVersion: "1",
      modelId: null,
      modelRevision: null,
      observationSchemaHash: OBSERVATION_SCHEMA_HASH,
      actionSchemaHash: ACTION_SCHEMA_HASH,
      eventSchemaHash: EVENT_SCHEMA_HASH,
      protocolVersion: 1,
      runtimeVersion: "runtime-v1",
      environmentHash: "env-v1"
    },
    playerDebrief: {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: "absent",
      reason: "legacy-no-report"
    },
    scenarioFamily: "synthetic",
    policyCohort: index % 4 ? "novice" : "expert",
    strategy: "baseline",
    status: index % 5 ? "completed" : "crashed",
    termination:
      index % 5
        ? { reason: "game-terminal", step: null }
        : { reason: "runtime-failure", step: null },
    outcome: index % 5 ? "win" : "dnf",
    outcomeMetrics: { score: index },
    completionCounts: counts(),
    replayStatus: "trace-replayable",
    trace: { kind: "episode", id: `sha256:${String(index).padStart(64, "0")}` },
    frames: [],
    stepCount: 0,
    metrics: [],
    findingIds: [],
    assignedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    simulationWallMs: 10,
    logicalTicks: 12,
    policyInferenceMs: 1,
    nativeDurationMs: null,
    completeness: "complete",
    missingReasons: []
  };
}

function batch(): PlaytestAdapterBatch {
  const assignmentManifest = {
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: "adapter-accelerated",
    batchId: "batch-0",
    workspaceId: "workspace-a/game",
    buildSha: BUILD_SHA_A,
    configHash: CONFIG_HASH,
    rubricHash: "rubric-v1",
    approvalRevision: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    assignments: [
      {
        assignmentId: "a-00001",
        scenarioId: "tutorial",
        scenarioFamily: "tutorial",
        policyId: "heuristic",
        policyVersion: "1",
        cohort: "novice",
        seed: "1",
        maxSteps: 50
      }
    ]
  } as const;
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    executionMode: "adapter-accelerated",
    batchId: "batch-0",
    revision: 1,
    workspaceId: "workspace-a/game",
    repository: "synthetic/game",
    buildSha: BUILD_SHA_A,
    gameBuild: "game-v1",
    configHash: CONFIG_HASH,
    rubricHash: "rubric-v1",
    actionSchemaHash: ACTION_SCHEMA_HASH,
    observationSchemaHash: OBSERVATION_SCHEMA_HASH,
    eventSchemaHash: "events-v1",
    measurementVersion: "measurement-v1",
    protocolVersion: 1,
    policyIds: ["heuristic"],
    cohortIds: ["novice"],
    scenarioIds: ["tutorial"],
    assignmentInventory: {
      status: "frozen",
      manifest: {
        ...assignmentManifest,
        contentHash: createHash("sha256")
          .update(playtestAssignmentManifestHashInput(assignmentManifest))
          .digest("hex")
      }
    },
    coverageManifest: null,
    reviewPackets: [],
    reviewSelection: { status: "pending" },
    unobservedAssignments: [],
    reviewReceipts: [],
    status: "completed",
    cancellationReason: null,
    failureReason: null,
    counts: counts(),
    budget: {
      assignedEpisodes: 1,
      maxStepsPerEpisode: 50,
      wallTimeMs: 1000,
      critiqueBudget: 1,
      actualCritiques: 0
    },
    startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:00:01.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    provenance: {
      workspaceId: "workspace-a/game",
      buildSha: BUILD_SHA_A,
      measurementVersion: "measurement-v1",
      generatedAt: "2026-10-01T00:00:00.000Z"
    },
    evaluationIds: [],
    spanIds: []
  };
}

function visualBatch(cohortId: string | null = null): PlaytestVisualBatch {
  const manifestDraft = {
    schema: PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: "autonomous-visual" as const,
    batchId: "visual-batch-1",
    workspaceId: "workspace-a/game",
    targetId: "target-visual-1",
    targetApprovalId: "approval-visual-1",
    targetRevision: 2,
    targetOrigin: "http://localhost:5173",
    policyId: "smart-direct" as const,
    policyVersion: "smart-direct-v1",
    cohortId,
    areasOfFocus: "Explore the tutorial without submitting purchases.",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 40,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 20,
      smartTokensPerEpisode: 10_000,
      screenshotCountPerEpisode: 40,
      artifactBytesPerEpisode: 10_000_000
    },
    createdAt: "2026-10-17T12:00:00.000Z",
    assignments: [{ assignmentId: "v-0001", ordinal: 0, maxSteps: 30 }]
  } as const;
  const manifest = {
    ...manifestDraft,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(manifestDraft))
      .digest("hex")
  };
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    executionMode: "autonomous-visual",
    batchId: manifest.batchId,
    revision: 1,
    workspaceId: manifest.workspaceId,
    repository: null,
    buildSha: null,
    gameBuild: null,
    configHash: null,
    rubricHash: null,
    actionSchemaHash: null,
    observationSchemaHash: null,
    eventSchemaHash: null,
    measurementVersion: "playtesting-measurement-v2",
    protocolVersion: null,
    policyIds: ["smart-direct"],
    cohortIds: cohortId === null ? [] : [cohortId],
    scenarioIds: [],
    assignmentInventory: { status: "frozen-visual", manifest },
    coverageManifest: null,
    unobservedAssignments: [],
    reviewSelection: {
      status: "unavailable",
      reason: "visual-discovery-session-level"
    },
    reviewPackets: [],
    reviewReceipts: [],
    status: "completed",
    cancellationReason: null,
    failureReason: null,
    counts: {
      assigned: 1,
      started: 1,
      completed: 1,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 0
    },
    budget: {
      assignedEpisodes: 1,
      maxStepsPerEpisode: 30,
      wallTimeMs: 60_000,
      critiqueBudget: 0,
      actualCritiques: 0
    },
    startedAt: manifest.createdAt,
    completedAt: manifest.createdAt,
    createdAt: manifest.createdAt,
    provenance: {
      workspaceId: manifest.workspaceId,
      buildSha: null,
      measurementVersion: "playtesting-measurement-v2",
      generatedAt: manifest.createdAt
    },
    evaluationIds: [],
    spanIds: []
  };
}

function batchWithCoverage(): PlaytestAdapterBatch {
  const original = batch();
  if (
    original.assignmentInventory.status !== "frozen" ||
    original.assignmentInventory.manifest.mode !== "adapter-accelerated"
  ) {
    throw new Error(
      "The fixture batch must have a frozen adapter assignment inventory."
    );
  }
  const buildSha = "a".repeat(40);
  const rubricHash = "d".repeat(64);
  const manifestBase = {
    ...original.assignmentInventory.manifest,
    buildSha,
    rubricHash
  };
  const manifest = {
    ...manifestBase,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(manifestBase))
      .digest("hex")
  };
  const draft = buildPlaytestCoverageManifestDraft({
    rubricHash,
    assignmentManifestHash: manifest.contentHash,
    mode: "headless",
    generatedAt: original.createdAt,
    batchId: original.batchId,
    workspaceId: original.workspaceId,
    buildSha,
    plan: [
      {
        coverageMetricId: "fixture-rate",
        metricVersion: 2,
        mechanicKey: "fixture-mechanic",
        phaseId: "tutorial",
        scenarioFamily: "tutorial",
        cohort: "novice",
        policy: "heuristic",
        modality: "headless",
        analysisUnit: "episode",
        requiredOpportunities: 1,
        requiredIndependentUnits: 1,
        unsupportedReason: null
      }
    ],
    assignments: manifest.assignments,
    episodes: []
  });
  const coverageManifest = {
    ...draft,
    contentHash: createHash("sha256")
      .update(playtestCoverageManifestHashInput(draft))
      .digest("hex")
  };
  return {
    ...original,
    buildSha,
    rubricHash,
    provenance: { ...original.provenance, buildSha },
    assignmentInventory: { status: "frozen", manifest },
    coverageManifest
  };
}

function finding(overrides: Partial<PlaytestFinding> = {}): PlaytestFinding {
  const identity = buildPlaytestFindingIdentity({
    workspaceId: "workspace-a/game",
    mechanicKey: "collision-clip",
    failureSignature: {
      events: ["collision", "fall", "clip"],
      action: "jump",
      witness: "witness-collision-1"
    },
    scope: {
      scenarioFamily: "tutorial",
      phase: "phase-2",
      modality: "headless"
    }
  });
  const fingerprint = createHash("sha256")
    .update(playtestFindingIdentityHashInput(identity))
    .digest("hex");
  return {
    identity,
    fingerprint,
    findingId: `finding-${fingerprint}`,
    version: 2,
    title: "Verified synthetic finding",
    description: "The content remains in the full canonical artifact payload.",
    severity: "major",
    status: "open",
    verificationStage: "fixed-on-reproduced-case",
    evidenceStatus: "verified",
    affectedEpisodes: 2,
    totalEligibleEpisodes: 10,
    affectedOpportunities: 2,
    totalEligibleOpportunities: 8,
    affectedCohorts: ["novice"],
    evidenceRefs: [{ kind: "episode", id: "episode-1", step: 2 }],
    experimentIds: [],
    issueRefs: [],
    lastVerifiedBuild: BUILD_SHA_A,
    nextReviewAt: null,
    ...overrides
  } as PlaytestFinding;
}

function review(): PlaytestSessionReview {
  const episodeEvidence = { kind: "episode", id: "episode-00001" } as const;
  return {
    schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
    reviewId: "review-1",
    version: 1,
    episodeId: "episode-00001",
    supersedes: null,
    evidencePacket: {
      packetId: "packet-review-1",
      artifact: {
        artifactId: "artifact-review-1",
        sha256: "1".repeat(64),
        bytes: 256,
        mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE
      }
    },
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    rubricHash: "rubric-v1",
    measurementVersion: "measurement-v1",
    provenance: {
      workspaceId: "workspace-a/game",
      buildSha: BUILD_SHA_A,
      measurementVersion: "measurement-v1",
      generatedAt: "2026-10-01T00:00:00.000Z"
    },
    chronologicalSummary: "Synthetic summary",
    authoritativeMetrics: [],
    observations: [
      { text: "Synthetic observation", evidenceRefs: [episodeEvidence] }
    ],
    interpretations: [
      { text: "Synthetic interpretation", evidenceRefs: [episodeEvidence] }
    ],
    anchors: [],
    alternativeExplanations: [],
    reportCompleteness: {
      crossSessionContext: {
        status: "unavailable",
        reason: "The review packet contains only this session."
      },
      alternatives: {
        status: "none-identified",
        reason: "No alternative is included in this fixture."
      },
      experiments: {
        status: "none-recommended",
        reason: "No experiment is included in this fixture."
      },
      followUp: {
        status: "none",
        reason: "No follow-up is included in this fixture."
      }
    },
    experiments: [],
    status: "hypothesis",
    findings: [],
    evidenceRefs: [episodeEvidence],
    createdAt: "2026-10-01T00:00:00.000Z",
    notes: "Synthetic note"
  };
}

function discoveryReview(): PlaytestDiscoverySessionReview {
  return {
    schema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
    analysisKind: "discovery",
    reviewId: "discovery-review-1",
    version: 1,
    workspaceId: "workspace-a/game",
    batchId: "batch-visual-1",
    episodeId: "ep-visual-1",
    supersedes: null,
    evidencePacket: {
      packetId: "discovery-packet-1",
      artifact: {
        artifactId: "discovery-packet-artifact-1",
        sha256: "2".repeat(64),
        bytes: 512,
        mediaType: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE
      }
    },
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    measurementVersion: "playtesting-measurement-v2",
    chronologicalSummary: "The setup screen exposed two visible stage choices.",
    observations: [
      {
        hypothesisId: "observation-1",
        status: "hypothesis",
        text: "Two stage choices were visible.",
        evidenceRefs: [{ kind: "episode", id: "ep-visual-1" }]
      }
    ],
    interpretations: [
      {
        hypothesisId: "interpretation-1",
        status: "not-observed",
        text: "The selected stage's effect was not observed.",
        evidenceRefs: [{ kind: "episode", id: "ep-visual-1" }]
      }
    ],
    alternativeExplanations: [
      {
        hypothesisId: "alternative-1",
        status: "hypothesis",
        text: "The stage label may refer to preview selection only.",
        evidenceRefs: [{ kind: "episode", id: "ep-visual-1" }]
      }
    ],
    experiments: [
      {
        hypothesis: "Check whether selecting the stage begins a race.",
        falsifier: "The same control leaves the setup screen unchanged.",
        controls: ["Stage 1"],
        budget: "One visual decision.",
        evidenceRefs: [{ kind: "episode", id: "ep-visual-1" }]
      }
    ],
    evidenceRefs: [{ kind: "episode", id: "ep-visual-1" }],
    createdAt: "2026-10-17T12:00:00.000Z",
    status: "hypothesis"
  };
}

test("discovery review codec persists an unscored strict record", () => {
  const artifact = discoveryReview();
  const row = encodeDiscoveryReview("workspace-a/game", artifact);
  assert.equal(row.rubric_hash, "");
  assert.equal(row.measurement_version, "playtesting-measurement-v2");
  assert.deepEqual(
    decodeDiscoveryReview(row as unknown as Record<string, unknown>),
    artifact
  );
  assert.throws(
    () =>
      encodeDiscoveryReview("workspace-a/game", {
        ...artifact,
        rubricHash: "invented"
      } as unknown as PlaytestDiscoverySessionReview),
    /unknown or missing fields/u
  );
  assert.throws(
    () => decodeReview(row as unknown as Record<string, unknown>),
    /unsupported playtest review schema/u
  );
});

test("discovery and confirmatory reviews have separate latest-read paths", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  const confirmatory = {
    ...review(),
    episodeId: "ep-visual-1",
    observations: [
      {
        text: "Confirmatory observation",
        evidenceRefs: [{ kind: "episode" as const, id: "ep-visual-1" }]
      }
    ],
    interpretations: [
      {
        text: "Confirmatory interpretation",
        evidenceRefs: [{ kind: "episode" as const, id: "ep-visual-1" }]
      }
    ],
    evidenceRefs: [{ kind: "episode" as const, id: "ep-visual-1" }]
  };
  const discovery = discoveryReview();

  await repo.insertReview(confirmatory);
  await repo.insertDiscoveryReview(discovery);

  assert.deepEqual(
    await repo.getLatestReviewForEpisode("workspace-a/game", "ep-visual-1"),
    confirmatory
  );
  assert.deepEqual(
    await repo.getLatestDiscoveryReviewForEpisode(
      "workspace-a/game",
      "ep-visual-1"
    ),
    discovery
  );
});

test("legacy review schemas migrate with explicit packet and claim-citation gaps", () => {
  const artifact = review();
  const row = encodeReview("workspace-a/game", artifact);
  const legacy = JSON.parse(row.payload_json) as Record<string, unknown>;
  legacy.schema = PLAYTESTS_SESSION_REVIEW_SCHEMA_V1;
  legacy.observations = ["Synthetic observation"];
  legacy.interpretations = ["Synthetic interpretation"];
  delete legacy.evidencePacket;
  const decoded = decodeReview({
    ...row,
    payload_json: JSON.stringify(legacy)
  } as unknown as Record<string, unknown>);
  assert.equal(decoded.schema, PLAYTESTS_SESSION_REVIEW_SCHEMA);
  assert.equal(decoded.evidencePacket, null);
  assert.deepEqual(decoded.observations, [
    { text: "Synthetic observation", evidenceRefs: [] }
  ]);
  assert.deepEqual(decoded.interpretations, [
    { text: "Synthetic interpretation", evidenceRefs: [] }
  ]);

  const packetReview: PlaytestSessionReview = {
    ...artifact,
    evidencePacket: {
      packetId: "packet-review-1",
      artifact: {
        artifactId: "artifact-review-1",
        sha256: "1".repeat(64),
        bytes: 256,
        mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE
      }
    }
  };
  const packetReviewRow = encodeReview("workspace-a/game", packetReview);
  assert.deepEqual(
    decodeReview(packetReviewRow as unknown as Record<string, unknown>),
    packetReview
  );
  const schemaV5 = JSON.parse(packetReviewRow.payload_json) as Record<
    string,
    unknown
  >;
  schemaV5.schema = PLAYTESTS_SESSION_REVIEW_SCHEMA_V5;
  const migratedV5 = decodeReview({
    ...packetReviewRow,
    payload_json: JSON.stringify(schemaV5)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedV5.schema, PLAYTESTS_SESSION_REVIEW_SCHEMA);
  assert.deepEqual(
    migratedV5.reportCompleteness,
    packetReview.reportCompleteness
  );
  const schemaV4 = JSON.parse(packetReviewRow.payload_json) as Record<
    string,
    unknown
  >;
  schemaV4.schema = PLAYTESTS_SESSION_REVIEW_SCHEMA_V4;
  delete schemaV4.reportCompleteness;
  const migratedV4 = decodeReview({
    ...packetReviewRow,
    payload_json: JSON.stringify(schemaV4)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedV4.schema, PLAYTESTS_SESSION_REVIEW_SCHEMA);
  assert.deepEqual(migratedV4.reportCompleteness, {
    crossSessionContext: {
      status: "not-recorded",
      reason: "Cross-session context was not represented in review schema v4."
    },
    alternatives: {
      status: "not-recorded",
      reason:
        "Alternative-explanation completeness was not represented in review schema v4."
    },
    experiments: {
      status: "not-recorded",
      reason: "Experiment completeness was not represented in review schema v4."
    },
    followUp: {
      status: "not-recorded",
      reason: "Follow-up completeness was not represented in review schema v4."
    }
  });
  for (const legacySchema of [
    PLAYTESTS_SESSION_REVIEW_SCHEMA_V2,
    PLAYTESTS_SESSION_REVIEW_SCHEMA_V3
  ]) {
    const legacyPacketReview = JSON.parse(
      packetReviewRow.payload_json
    ) as Record<string, unknown>;
    legacyPacketReview.schema = legacySchema;
    legacyPacketReview.observations = ["Synthetic observation"];
    legacyPacketReview.interpretations = ["Synthetic interpretation"];
    const migrated = decodeReview({
      ...packetReviewRow,
      payload_json: JSON.stringify(legacyPacketReview)
    } as unknown as Record<string, unknown>);
    assert.deepEqual(migrated.evidencePacket, packetReview.evidencePacket);
    assert.deepEqual(migrated.observations, [
      { text: "Synthetic observation", evidenceRefs: [] }
    ]);
    assert.deepEqual(migrated.interpretations, [
      { text: "Synthetic interpretation", evidenceRefs: [] }
    ]);
  }
  assert.throws(
    () =>
      encodeReview("workspace-a/game", {
        ...packetReview,
        evidencePacket: {
          ...packetReview.evidencePacket!,
          artifact: {
            artifactId: "artifact-review-1",
            sha256: "1".repeat(64),
            bytes: 256,
            mediaType: "text/plain"
          }
        }
      }),
    /artifact metadata/u
  );
});

function crossSessionSynthesis(
  overrides: Partial<PlaytestCrossSessionSynthesis> = {}
): PlaytestCrossSessionSynthesis {
  const contributors = [
    { episodeId: "episode-1", batchId: "batch-1", packetId: "packet-1" },
    { episodeId: "episode-2", batchId: "batch-2", packetId: "packet-2" }
  ] as const;
  const base: PlaytestCrossSessionSynthesis = {
    schema: PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
    synthesisId: "synthesis-1",
    version: 1,
    analysisId: "analysis-1",
    workspaceId: "workspace-a/game",
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    modelId: null,
    modelRevision: null,
    promptHash: null,
    generatedAt: "2026-10-01T00:00:00.000Z",
    status: "hypothesis",
    summary: "The same warning preceded a no-progress action in both sessions.",
    contributors,
    packetEligibleEpisodeIds: contributors.map((entry) => entry.episodeId),
    metricAggregation: {
      schema: PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
      workspaceId: "workspace-a/game",
      analysisId: "analysis-1",
      status: "no-applicable-metrics",
      method: "ratio-of-sums-within-identical-stratum-v1",
      sourcePackets: contributors,
      rows: [],
      omittedMetrics: [],
      reason: "no-applicable-metric-rows"
    },
    claims: [
      {
        kind: "pattern",
        text: "Both sessions recorded the warning before progress stopped.",
        evidenceRefs: contributors.map((contributor) => ({
          episodeId: contributor.episodeId,
          packetId: contributor.packetId,
          locator: {
            kind: "event" as const,
            id: `warning-${contributor.episodeId}`,
            step: 2
          }
        }))
      }
    ],
    experiments: []
  };
  const result = { ...base, ...overrides };
  return {
    ...result,
    metricAggregation: overrides.metricAggregation ?? {
      ...base.metricAggregation,
      workspaceId: result.workspaceId,
      analysisId: result.analysisId
    }
  };
}

function comparison(
  index = 1,
  workspaceId = "workspace-a/game"
): PlaytestComparison {
  return {
    schema: PLAYTESTS_COMPARISON_SCHEMA,
    comparisonId: `comparison-${String(index).padStart(5, "0")}`,
    version: 1,
    benchmarkId: `benchmark-${index % 2 === 0 ? 2 : 1}`,
    experimentId: index % 3 === 0 ? `experiment-${index}` : null,
    baseline: { id: "baseline", version: "1" },
    candidate: { id: "candidate", version: "2" },
    freezeStatus: "frozen",
    pairing: {
      mode: "observational",
      pairMap: {},
      allocationPlanHash: null,
      rngAlgorithm: null,
      rngStreamVersion: null,
      couplingDiagnostics: [],
      exclusions: []
    },
    sourceFindingIds: [],
    episodeRefs: [],
    measurementVersion: "measurement-v1",
    metrics: [],
    decision:
      index % 2 === 0 ? "eligible-for-owner-promotion" : "hold-inconclusive",
    ownerDecisionAt: null,
    ownerDecisionReason: null,
    ownerDecisionBy: null,
    ownerDisposition: null,
    humanPreference: { answer: "not-collected", interval: null },
    provenance: {
      workspaceId,
      buildSha: BUILD_SHA_A,
      measurementVersion: "measurement-v1",
      generatedAt: new Date(
        Date.UTC(2026, 9, 1, 0, 0, index % 60)
      ).toISOString()
    },
    notes: "Synthetic comparison note"
  };
}

function benchmark(
  index = 1,
  workspaceId = "workspace-a/game"
): PlaytestBenchmark {
  const manifest: Omit<PlaytestBenchmark, "contentHash"> = {
    benchmarkId: `benchmark-${String(index).padStart(5, "0")}`,
    version: 1,
    workspaceId,
    referenceBuildSha: index % 2 === 0 ? "a".repeat(40) : "b".repeat(40),
    scenarioInventory: [{ scenarioId: "tutorial", family: "intro", weight: 1 }],
    seedInventory: [{ seed: "1", purpose: "discovery" }],
    policyVersions: { heuristic: "1" },
    competenceReportRefs: [],
    memoryResetRules: "episode",
    engineEnvironmentHash: createHash("sha256")
      .update("environment-v1")
      .digest("hex"),
    actionSchemaHash: createHash("sha256").update("actions-v1").digest("hex"),
    observationSchemaHash: createHash("sha256")
      .update("observations-v1")
      .digest("hex"),
    eventSchemaHash: createHash("sha256").update("events-v1").digest("hex"),
    metricRegistryHash: createHash("sha256").update("metrics-v1").digest("hex"),
    rubricHash: createHash("sha256").update("rubric-v1").digest("hex"),
    captureMode: "headless",
    cohortWeights: { novice: 1 },
    measurementVersion: index % 3 === 0 ? "measurement-v2" : "measurement-v1",
    primaryMetricIds: ["completion"],
    guardrailMetricIds: [],
    practicalMargins: { completion: 0.05 },
    independentUnit: "episode",
    precisionPlanRef: "precision-plan-v1",
    missingnessBound: 0.1,
    refreshPolicy: "manual",
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index % 60)).toISOString(),
    createdBy: "operator"
  };
  return {
    ...manifest,
    contentHash: createHash("sha256")
      .update(playtestBenchmarkHashInput(manifest))
      .digest("hex")
  };
}

function experiment(
  index = 1,
  workspaceId = "workspace-a/game"
): PlaytestExperiment {
  const discoveryInventory = [
    `experiment-${index}-discovery-1`,
    `experiment-${index}-discovery-2`
  ];
  const confirmationInventory = Array.from(
    { length: 8 },
    (_, assignment) => `experiment-${index}-confirmation-${assignment + 1}`
  );
  const assignedUnits = [...discoveryInventory, ...confirmationInventory];
  const state = index % 2 === 0 ? "approved" : "draft";
  const manifest: Omit<PlaytestExperiment, "contentHash"> = {
    schema: PLAYTESTS_EXPERIMENT_SCHEMA,
    experimentId: `experiment-${String(index).padStart(5, "0")}`,
    version: 1,
    workspaceId,
    findingIds: ["finding-" + "f".repeat(64)],
    hypothesis: "Synthetic hypothesis",
    falsifier: "Synthetic falsifier",
    alternativeExplanations: ["Synthetic alternative explanation."],
    benchmarkId: `benchmark-${index % 2 === 0 ? 2 : 1}`,
    baseline: {
      id: "baseline",
      version: "1",
      contentHash: createHash("sha256").update("baseline").digest("hex")
    },
    treatment: {
      id: "treatment",
      version: "2",
      contentHash: createHash("sha256").update("treatment").digest("hex")
    },
    approvalId: state === "approved" ? "approval-fixture" : null,
    exposureUnit: "episode",
    allocationSeed: "seed-1",
    allocationMethod: "randomized",
    cohort: "novice",
    memoryInitialization: "fresh",
    pairMap: {},
    assignmentMap: Object.fromEntries(
      assignedUnits.map((unit, unitIndex) => [
        unit,
        unitIndex % 2 === 0 ? "baseline" : "treatment"
      ])
    ),
    discoveryInventory,
    confirmationInventory,
    primaryMetricId: "completion",
    guardrailMetricIds: [],
    analysisPlan: "descriptive",
    missingnessPlan: "report",
    multiplicityPlan: "none",
    budget: { maxAssignments: 10, maxCritiques: 1, maxWallTimeMs: 1000 },
    stoppingRule: "fixed-budget",
    state,
    attemptIds: [],
    comparisonId: null,
    ownerDecision: null,
    rollbackRefs: [],
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index % 60)).toISOString()
  };
  return {
    ...manifest,
    contentHash: createHash("sha256")
      .update(playtestExperimentHashInput({ ...manifest, contentHash: "" }))
      .digest("hex")
  };
}

function humanStudy(
  index = 1,
  workspaceId = "workspace-a/game"
): HumanPlaytestStudy {
  return {
    schema: PLAYTESTS_HUMAN_STUDY_SCHEMA,
    studyId: `study-${String(index).padStart(5, "0")}`,
    version: 1,
    workspaceId,
    benchmarkId: `benchmark-${index % 2 === 0 ? 2 : 1}`,
    allowedBuilds: [{ id: "a".repeat(40), version: 1 }],
    pxiItemConstructMappingHash: null,
    instrument: "miniPXI",
    instrumentVersion: "1.0",
    instrumentHash: "hash-instrument",
    consentVersion: "consent-v1",
    consentScope: "full",
    approved: index % 2 === 1,
    approvedBy: "operator",
    responseWindowMs: 60_000,
    minimumExposureMs: 5000,
    orderDesign: "AB/BA",
    independentUnit: "participant",
    missingItemPolicy: "item-wise",
    invitedCount: 10,
    eligibleCount: 8,
    respondedCount: 6,
    withdrawnCount: 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index % 60)).toISOString()
  };
}

function humanSummary(
  studyId = "study-1",
  retainedParticipants = 5,
  revision = 1,
  isTombstone = false,
  workspaceId = "workspace-a/game",
  benchmarkId = "benchmark-1"
): PlaytestHumanAggregateRecord {
  return {
    workspaceId,
    studyId,
    revision,
    benchmarkId,
    buildSha: BUILD_SHA_A,
    instrument: "miniPXI",
    measurementVersion: "measurement-v1",
    retainedParticipants,
    isTombstone,
    items: [
      {
        itemId: "ENJ",
        mean: 2.5,
        respondentCount: retainedParticipants,
        missingCount: 0,
        categoryCounts: {
          "-3": 0,
          "-2": 0,
          "-1": 0,
          "0": 0,
          "1": 1,
          "2": 2,
          "3": 2
        },
        unit: "native-Likert-minus3-plus3",
        missingReasons: []
      }
    ],
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, revision % 60)).toISOString()
  };
}

test("Data round-trips only verified branch lineage and migrates episode/manifest v1 once", () => {
  const sourceCheckpoint = {
    stateHash: "a".repeat(64),
    rngCheckpoint: {
      algorithm: "pcg",
      version: "pcg-v1",
      stateHash: "b".repeat(64),
      reproducible: true
    }
  } as const;
  const branchEpisode: PlaytestEpisode = {
    ...episode(1),
    episodeId: "episode-branch",
    branchLineage: {
      parentEpisodeId: "episode-parent",
      parentEpisodeRevision: 1,
      parentBatchId: "batch-parent",
      branchStep: 3,
      parentTrace: {
        artifactId: "parent-trace",
        sha256: "c".repeat(64),
        bytes: 128,
        mediaType: "application/x-ndjson"
      },
      parentCheckpoint: sourceCheckpoint,
      alternativeActionId: "cool-down",
      rngPolicy: "same-stream",
      rngPolicyVersion: "same-stream-state-v1",
      replayTransitionHash: "d".repeat(64),
      snapshotArtifact: {
        artifactId: "branch-snapshot",
        sha256: "e".repeat(64),
        bytes: 64,
        mediaType: "application/vnd.fixture.snapshot"
      },
      snapshotIntegrityHash: "e".repeat(64),
      forkStateHash: sourceCheckpoint.stateHash,
      forkRngCheckpoint: sourceCheckpoint.rngCheckpoint,
      continuationPolicyId: "heuristic",
      continuationPolicyVersion: "v1"
    }
  };
  const encodedEpisode = encodeEpisode(branchEpisode);
  assert.deepEqual(
    decodeEpisode(encodedEpisode as unknown as Record<string, unknown>)
      .branchLineage,
    branchEpisode.branchLineage
  );
  assert.throws(
    () =>
      encodeEpisode({
        ...branchEpisode,
        branchLineage: {
          ...branchEpisode.branchLineage!,
          forkStateHash: "f".repeat(64)
        }
      }),
    /state or RNG lineage/u
  );
  assert.throws(
    () =>
      encodeEpisode({
        ...branchEpisode,
        branchLineage: {
          ...branchEpisode.branchLineage!,
          snapshotArtifact: null
        }
      }),
    /explicitly incomplete/u
  );

  const legacyEpisodeRow = encodeEpisode({
    ...episode(2),
    branchLineage: null
  });
  const legacyEpisodePayload = JSON.parse(
    legacyEpisodeRow.payload_json
  ) as Record<string, unknown>;
  legacyEpisodePayload.schema = PLAYTESTS_EPISODE_SCHEMA_V1;
  delete legacyEpisodePayload.branchLineage;
  (legacyEpisodePayload.identity as Record<string, unknown>).protocolVersion =
    null;
  legacyEpisodePayload.metrics = [
    {
      metricId: "legacy-rate",
      metricVersion: 1,
      numerator: 1,
      denominator: 2,
      coverage: 0.5,
      unit: "proportion",
      estimate: 0.5,
      missing: 0,
      missingReasons: [],
      independentUnits: 2,
      provenance: {
        workspaceId: "workspace-a/game",
        measurementVersion: "measurement-v1",
        generatedAt: new Date().toISOString()
      },
      notes: "Old result did not store the total opportunity count."
    }
  ];
  const migratedEpisode = migrateLegacyEpisodeForStorage({
    ...legacyEpisodeRow,
    payload_json: JSON.stringify(legacyEpisodePayload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedEpisode.schema, PLAYTESTS_EPISODE_SCHEMA);
  assert.equal(migratedEpisode.revision, 1);
  assert.equal(migratedEpisode.branchLineage, null);
  assert.equal(migratedEpisode.executionProvenance.mode, "legacy-unknown");
  assert.equal(migratedEpisode.metrics[0]?.opportunityCount, null);
  assert.equal(migratedEpisode.metrics[0]?.coverage, 0.5);
  assert.deepEqual(migratedEpisode.playerDebrief, {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "absent",
    reason: "legacy-no-report"
  });

  const v2EpisodeRow = encodeEpisode(episode(12));
  const v2EpisodePayload = JSON.parse(v2EpisodeRow.payload_json) as Record<
    string,
    unknown
  >;
  v2EpisodePayload.schema = PLAYTESTS_EPISODE_SCHEMA_V2;
  delete v2EpisodePayload.executionProvenance;
  delete v2EpisodePayload.playerDebrief;
  const migratedV2Episode = migrateLegacyEpisodeForStorage({
    ...v2EpisodeRow,
    payload_json: JSON.stringify(v2EpisodePayload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedV2Episode.schema, PLAYTESTS_EPISODE_SCHEMA);
  assert.equal(migratedV2Episode.revision, episode(12).revision);
  assert.deepEqual(migratedV2Episode.playerDebrief, {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "absent",
    reason: "legacy-no-report"
  });

  const v3EpisodePayload = JSON.parse(
    encodeEpisode(episode(3)).payload_json
  ) as Record<string, unknown>;
  v3EpisodePayload.schema = PLAYTESTS_EPISODE_SCHEMA_V3;
  delete v3EpisodePayload.termination;
  (v3EpisodePayload.identity as Record<string, unknown>).protocolVersion = null;
  const migratedV3Episode = migrateLegacyEpisodeForStorage({
    ...encodeEpisode(episode(3)),
    payload_json: JSON.stringify(v3EpisodePayload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedV3Episode.schema, PLAYTESTS_EPISODE_SCHEMA);
  assert.equal(migratedV3Episode.executionProvenance.mode, "legacy-unknown");
  assert.deepEqual(migratedV3Episode.termination, {
    reason: "unknown",
    step: null
  });
  assert.deepEqual(migratedV3Episode.playerDebrief, {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "absent",
    reason: "legacy-no-report"
  });
  assert.equal(migratedV3Episode.revision, episode(3).revision);
  const v5EpisodeRow = encodeEpisode(episode(4));
  const v5EpisodePayload = JSON.parse(v5EpisodeRow.payload_json) as Record<
    string,
    unknown
  >;
  v5EpisodePayload.schema = PLAYTESTS_EPISODE_SCHEMA_V5;
  const migratedV5Episode = migrateLegacyEpisodeForStorage({
    ...v5EpisodeRow,
    payload_json: JSON.stringify(v5EpisodePayload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedV5Episode.schema, PLAYTESTS_EPISODE_SCHEMA);
  assert.equal(migratedV5Episode.revision, episode(4).revision);
  assert.equal(
    migratedV5Episode.executionProvenance.mode,
    "adapter-accelerated"
  );
  assert.equal(migratedV5Episode.identity.buildSha, BUILD_SHA_B);
  assert.deepEqual(migratedV5Episode.playerDebrief, {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "absent",
    reason: "legacy-no-report"
  });

  const v7EpisodeRow = encodeEpisode(episode(6));
  const v7EpisodePayload = JSON.parse(v7EpisodeRow.payload_json) as Record<
    string,
    unknown
  >;
  v7EpisodePayload.schema = PLAYTESTS_EPISODE_SCHEMA_V7;
  delete v7EpisodePayload.playerDebrief;
  const migratedV7Episode = migrateLegacyEpisodeForStorage({
    ...v7EpisodeRow,
    payload_json: JSON.stringify(v7EpisodePayload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedV7Episode.schema, PLAYTESTS_EPISODE_SCHEMA);
  assert.equal(migratedV7Episode.revision, episode(6).revision);
  assert.equal(
    migratedV7Episode.executionProvenance.mode,
    "adapter-accelerated"
  );
  assert.deepEqual(migratedV7Episode.playerDebrief, {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "absent",
    reason: "legacy-no-report"
  });

  const visualEpisodeV6: PlaytestEpisode = {
    ...episode(5),
    batchId: "visual-batch-1",
    assignmentId: "visual-assignment-1",
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-target-1",
        targetOrigin: "http://racing.local"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    identity: {
      ...episode(5).identity,
      repository: null,
      buildSha: null,
      gameBuild: null,
      scenarioId: null,
      configHash: null,
      seed: null,
      rngInitialStateHash: null,
      rngAlgorithm: null,
      rngVersion: null,
      policyId: "smart-direct",
      policyVersion: "smart-direct-v1",
      protocolVersion: null
    },
    scenarioFamily: null,
    policyCohort: null,
    strategy: "smart-direct"
  };
  const visualV5Row = encodeEpisode(visualEpisodeV6);
  assert.equal(visualV5Row.scenario, "");
  assert.equal(visualV5Row.cohort, "");
  const visualV5Payload = JSON.parse(visualV5Row.payload_json) as Record<
    string,
    unknown
  >;
  visualV5Payload.schema = PLAYTESTS_EPISODE_SCHEMA_V5;
  visualV5Payload.scenarioFamily = "visual-discovery";
  visualV5Payload.policyCohort = "exploratory";
  const migratedVisualV5 = migrateLegacyEpisodeForStorage({
    ...visualV5Row,
    cohort: "exploratory",
    payload_json: JSON.stringify(visualV5Payload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedVisualV5.executionProvenance.mode, "autonomous-visual");
  assert.equal(migratedVisualV5.identity.buildSha, null);
  assert.equal(migratedVisualV5.identity.scenarioId, null);
  assert.equal(migratedVisualV5.scenarioFamily, null);
  assert.equal(migratedVisualV5.policyCohort, null);
  assert.equal(migratedVisualV5.revision, visualEpisodeV6.revision);
  assert.deepEqual(migratedVisualV5.playerDebrief, {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "absent",
    reason: "legacy-no-report"
  });

  const visualV6Row = encodeEpisode(visualEpisodeV6);
  const visualV6Payload = JSON.parse(visualV6Row.payload_json) as Record<
    string,
    unknown
  >;
  visualV6Payload.schema = PLAYTESTS_EPISODE_SCHEMA_V6;
  visualV6Payload.scenarioFamily = "visual-discovery";
  visualV6Payload.policyCohort = "exploratory";
  const migratedVisualV6 = migrateLegacyEpisodeForStorage({
    ...visualV6Row,
    cohort: "exploratory",
    payload_json: JSON.stringify(visualV6Payload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedVisualV6.executionProvenance.mode, "autonomous-visual");
  assert.equal(migratedVisualV6.scenarioFamily, null);
  assert.equal(migratedVisualV6.policyCohort, null);
  assert.deepEqual(migratedVisualV6.playerDebrief, {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "absent",
    reason: "legacy-no-report"
  });
  assert.equal(migratedVisualV6.revision, visualEpisodeV6.revision);

  const visualV7Row = encodeEpisode(visualEpisodeV6);
  const visualV7Payload = JSON.parse(visualV7Row.payload_json) as Record<
    string,
    unknown
  >;
  visualV7Payload.schema = PLAYTESTS_EPISODE_SCHEMA_V7;
  visualV7Payload.scenarioFamily = "visual-discovery";
  visualV7Payload.policyCohort = "exploratory";
  delete visualV7Payload.playerDebrief;
  const migratedVisualV7 = migrateLegacyEpisodeForStorage({
    ...visualV7Row,
    cohort: "exploratory",
    payload_json: JSON.stringify(visualV7Payload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedVisualV7.executionProvenance.mode, "autonomous-visual");
  assert.equal(migratedVisualV7.scenarioFamily, null);
  assert.equal(migratedVisualV7.policyCohort, null);
  assert.deepEqual(migratedVisualV7.playerDebrief, {
    schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
    status: "absent",
    reason: "legacy-no-report"
  });
  assert.equal(migratedVisualV7.revision, visualEpisodeV6.revision);
  assert.throws(
    () =>
      decodeEpisode({
        ...legacyEpisodeRow,
        payload_json: JSON.stringify(legacyEpisodePayload)
      } as unknown as Record<string, unknown>),
    /unsupported schema version/u
  );

  const batchRow = encodeBatch(batch());
  const legacyBatchPayload = JSON.parse(batchRow.payload_json) as Record<
    string,
    any
  >;
  const currentManifest = legacyBatchPayload.assignmentInventory.manifest;
  const { mode: _currentMode, ...manifestBeforeMode } = currentManifest;
  const legacyManifest = {
    ...manifestBeforeMode,
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V1,
    assignments: currentManifest.assignments.map(
      ({ cohort: _cohort, ...assignment }: Record<string, unknown>) =>
        assignment
    ),
    contentHash: ""
  };
  legacyManifest.contentHash = createHash("sha256")
    .update(
      playtestAssignmentManifestHashInput(
        legacyManifest as unknown as PlaytestAssignmentManifestDraft
      )
    )
    .digest("hex");
  legacyBatchPayload.assignmentInventory.manifest = legacyManifest;
  const migratedBatch = decodeBatch({
    ...batchRow,
    payload_json: JSON.stringify(legacyBatchPayload)
  });
  assert.equal(migratedBatch.assignmentInventory.status, "frozen");
  if (migratedBatch.assignmentInventory.status === "frozen") {
    const migratedManifest = migratedBatch.assignmentInventory.manifest;
    assert.equal(migratedManifest.schema, PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA);
    assert.equal(migratedManifest.assignments[0]?.cohort, null);
    assert.doesNotThrow(() =>
      assertPlaytestAssignmentManifest(migratedManifest)
    );
  }

  const legacyV3Manifest = {
    ...manifestBeforeMode,
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V3,
    contentHash: ""
  };
  legacyV3Manifest.contentHash = createHash("sha256")
    .update(
      playtestAssignmentManifestHashInput(
        legacyV3Manifest as unknown as PlaytestAssignmentManifestDraft
      )
    )
    .digest("hex");
  const legacyBatchV3Payload: Record<string, unknown> = {
    ...legacyBatchPayload,
    schema: PLAYTESTS_BATCH_SCHEMA_V3,
    assignmentInventory: {
      status: "frozen",
      manifest: legacyV3Manifest
    }
  };
  delete legacyBatchV3Payload.executionMode;
  const migratedOuterV3 = decodeBatch({
    ...batchRow,
    payload_json: JSON.stringify(legacyBatchV3Payload)
  });
  assert.equal(migratedOuterV3.schema, PLAYTESTS_BATCH_SCHEMA);
  assert.equal(migratedOuterV3.executionMode, "adapter-accelerated");
  assert.equal(migratedOuterV3.assignmentInventory.status, "frozen");

  const migratedV3 = decodeBatch({
    ...batchRow,
    payload_json: JSON.stringify({
      ...legacyBatchPayload,
      assignmentInventory: {
        status: "frozen",
        manifest: legacyV3Manifest
      }
    })
  });
  assert.equal(migratedV3.assignmentInventory.status, "frozen");
  if (
    migratedV3.assignmentInventory.status === "frozen" &&
    migratedV3.assignmentInventory.manifest.mode === "adapter-accelerated"
  ) {
    assert.equal(
      migratedV3.assignmentInventory.manifest.assignments[0]?.cohort,
      "novice"
    );
  } else {
    assert.fail("The v3 adapter manifest must migrate with its cohort intact.");
  }

  const legacyV2Manifest = {
    ...legacyManifest,
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V2,
    contentHash: ""
  };
  legacyV2Manifest.contentHash = createHash("sha256")
    .update(
      playtestAssignmentManifestHashInput(
        legacyV2Manifest as unknown as PlaytestAssignmentManifestDraft
      )
    )
    .digest("hex");
  const migratedV2 = decodeBatch({
    ...batchRow,
    payload_json: JSON.stringify({
      ...legacyBatchPayload,
      assignmentInventory: {
        status: "frozen",
        manifest: legacyV2Manifest
      }
    })
  });
  assert.equal(migratedV2.assignmentInventory.status, "frozen");
  if (
    migratedV2.assignmentInventory.status === "frozen" &&
    migratedV2.assignmentInventory.manifest.mode === "adapter-accelerated"
  ) {
    assert.equal(
      migratedV2.assignmentInventory.manifest.assignments[0]?.cohort,
      null
    );
  } else {
    assert.fail("The legacy adapter manifest must remain adapter-accelerated.");
  }
});

test("Data fails closed on a malformed frozen manifest instead of relabeling it pre-manifest history", () => {
  const row = encodeBatch(batch());
  const payload = JSON.parse(row.payload_json) as Record<string, any>;
  payload.assignmentInventory = {
    status: "frozen",
    manifest: "corrupted-current-format"
  };
  payload.reviewReceipts = [];
  assert.throws(
    () => decodeBatch({ ...row, payload_json: JSON.stringify(payload) }),
    PlaytestSourceUnavailableError
  );
});

test("Data round-trips opportunity counts and verified evaluator provenance", () => {
  const base = {
    ...episode(101),
    identity: { ...episode(101).identity, buildSha: "a".repeat(40) }
  };
  const result = {
    metricId: "fixture-rate",
    metricVersion: 2,
    phaseId: null,
    numerator: 2,
    denominator: 3,
    opportunityCount: 4,
    coverage: 0.75,
    unit: "proportion",
    estimate: 2 / 3,
    missing: 1,
    missingReasons: ["unobserved" as const],
    independentUnits: 3,
    provenance: {
      workspaceId: base.identity.workspaceId,
      buildSha: base.identity.buildSha,
      evaluatorHash: "c".repeat(64),
      rubricHash: "d".repeat(64),
      measurementVersion: "playtesting-measurement-v1",
      generatedAt: base.assignedAt
    },
    notes: "2/3 eligible opportunities; coverage 3/4."
  };
  const encoded = encodeEpisode({ ...base, metrics: [result] });
  const decoded = decodeEpisode(encoded as unknown as Record<string, unknown>);
  assert.deepEqual(decoded.metrics, [result]);
  assert.throws(
    () => encodeEpisode({ ...base, metrics: [result, result] }),
    /unique metric\/phase pairs/u
  );
});

test("Data verifies immutable benchmark and experiment content hashes before indexing", () => {
  const benchmarkArtifact = benchmark();
  const experimentArtifact = experiment();
  assert.doesNotThrow(() => encodeBenchmark(benchmarkArtifact));
  assert.doesNotThrow(() => encodeExperiment(experimentArtifact));
  assert.throws(
    () =>
      encodeBenchmark({
        ...benchmarkArtifact,
        contentHash: "f".repeat(64)
      }),
    /Benchmark contentHash does not match/u
  );
  assert.throws(
    () =>
      encodeExperiment({
        ...experimentArtifact,
        hypothesis: "Changed without a new frozen content hash."
      }),
    /Experiment contentHash does not match/u
  );
  const unapproved = {
    ...experimentArtifact,
    state: "approved" as const,
    approvalId: null
  };
  assert.throws(
    () => encodeExperiment(unapproved),
    /state "approved" requires an approvalId/u
  );
  const malformedPayload = {
    ...unapproved,
    contentHash: createHash("sha256")
      .update(playtestExperimentHashInput(unapproved))
      .digest("hex")
  };
  const encoded = encodeExperiment(experimentArtifact);
  assert.throws(
    () =>
      decodeExperiment({
        ...encoded,
        state: "approved",
        payload_json: JSON.stringify(malformedPayload)
      } as unknown as Record<string, unknown>),
    /state "approved" requires an approvalId/u
  );
});

const SYNTHETIC_ID_COLUMNS = {
  batchId: "batch_id",
  episodeId: "episode_id",
  findingId: "finding_id",
  reviewId: "review_id",
  synthesisId: "synthesis_id",
  analysisId: "analysis_id",
  comparisonId: "comparison_id",
  benchmarkId: "benchmark_id",
  experimentId: "experiment_id",
  studyId: "study_id",
  actorId: "actor_id",
  requestId: "request_id"
} as const;
const SYNTHETIC_FILTER_COLUMNS: readonly (readonly [string, string])[] = [
  ["buildSha", "build_sha"],
  ["scenario", "scenario"],
  ["policy", "policy"],
  ["cohort", "cohort"],
  ["status", "status"],
  ["gameOutcome", "game_outcome"],
  ["severity", "severity"],
  ["verificationStage", "verification_stage"],
  ["evidenceStatus", "evidence_status"],
  ["decision", "decision"],
  ["referenceBuildSha", "reference_build_sha"],
  ["measurementVersion", "measurement_version"],
  ["state", "state"],
  ["instrument", "instrument"],
  ["approved", "approved"]
];
const SYNTHETIC_COLLATOR = new Intl.Collator("en");

function tableKeyColumn(table: string): string {
  switch (table) {
    case "playtest_launch_intents": {
      return "request_id";
    }
    case "playtest_batches": {
      return "batch_id";
    }
    case "playtest_episodes": {
      return "episode_id";
    }
    case "playtest_findings": {
      return "finding_id";
    }
    case "playtest_reviews": {
      return "review_id";
    }
    case "playtest_cross_session_syntheses": {
      return "synthesis_id";
    }
    case "playtest_benchmarks": {
      return "benchmark_id";
    }
    case "playtest_experiments": {
      return "experiment_id";
    }
    case "playtest_human_studies":
    case "playtest_human_summaries": {
      return "study_id";
    }
    default: {
      return "comparison_id";
    }
  }
}

function filterSyntheticRows(
  url: URL,
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const workspace = url.searchParams.get("param_workspaceId");
  let filtered =
    workspace === null
      ? rows
      : rows.filter((row) => row.workspace_id === workspace);
  for (const key of Object.keys(
    SYNTHETIC_ID_COLUMNS
  ) as (keyof typeof SYNTHETIC_ID_COLUMNS)[]) {
    const value = url.searchParams.get(`param_${key}`);
    if (value !== null) {
      const column = SYNTHETIC_ID_COLUMNS[key];
      filtered = filtered.filter((row) => row[column] === value);
    }
  }
  const episodeIdParameters = [...url.searchParams.entries()]
    .filter(([key]) => /^param_episodeId\d+$/u.test(key))
    .map(([, value]) => value);
  if (episodeIdParameters.length > 0) {
    const selected = new Set(episodeIdParameters);
    filtered = filtered.filter((row) => selected.has(String(row.episode_id)));
  }
  for (const [param, column] of SYNTHETIC_FILTER_COLUMNS) {
    const value = url.searchParams.get(`param_${param}`);
    if (value !== null) {
      filtered = filtered.filter(
        (row) => String(row[column]) === String(value)
      );
    }
  }
  return filtered;
}

function latestSyntheticRows(
  table: string,
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  if (table === "playtest_launch_intents") return rows;
  const keyColumn = tableKeyColumn(table);
  const versionColumn =
    table === "playtest_batches" ||
    table === "playtest_episodes" ||
    table === "playtest_human_summaries"
      ? "revision"
      : "version";
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = String(row[keyColumn]);
    const current = latest.get(key);
    const rowRevision = Number(row[versionColumn]);
    const currentRevision = Number(current?.[versionColumn]);
    const rowIsCurrentEpisodeSchema =
      table === "playtest_episodes" &&
      (JSON.parse(String(row.payload_json)) as { schema?: unknown }).schema ===
        PLAYTESTS_EPISODE_SCHEMA;
    const currentIsCurrentEpisodeSchema =
      table === "playtest_episodes" &&
      current !== undefined &&
      (JSON.parse(String(current.payload_json)) as { schema?: unknown })
        .schema === PLAYTESTS_EPISODE_SCHEMA;
    if (
      !current ||
      rowRevision > currentRevision ||
      (rowRevision === currentRevision &&
        rowIsCurrentEpisodeSchema &&
        !currentIsCurrentEpisodeSchema)
    ) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

function cursorSyntheticRows(
  url: URL,
  table: string,
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const cursorAt = url.searchParams.get("param_cursorOrderedAt");
  const cursorId = url.searchParams.get("param_cursorTiebreakId");
  if (!cursorAt || !cursorId) return rows;
  const cursorDateTime = cursorAt.replace("T", " ").replace("Z", "");
  const timeColumn =
    table === "playtest_episodes" ? "assigned_at" : "created_at";
  const keyColumn = tableKeyColumn(table);
  return rows.filter(
    (row) =>
      String(row[timeColumn]) < cursorDateTime ||
      (String(row[timeColumn]) === cursorDateTime &&
        String(row[keyColumn]) < cursorId)
  );
}

function makeClickHouseFetch() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const calls: URL[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    const query = url.searchParams.get("query") ?? "";
    const tableMatch = query.match(/(?:INTO|FROM) (playtest_[a-z_]+)/u);
    const table = tableMatch?.[1] ?? "";
    if (query.startsWith("INSERT INTO ")) {
      const current = tables.get(table) ?? [];
      for (const line of String(init?.body ?? "")
        .split("\n")
        .filter(Boolean)) {
        current.push(JSON.parse(line) as Record<string, unknown>);
      }
      tables.set(table, current);
      return new Response("", { status: 200 });
    }
    if (query.includes("CREATE TABLE IF NOT EXISTS"))
      return new Response("", { status: 200 });

    let rows = latestSyntheticRows(
      table,
      filterSyntheticRows(url, [...(tables.get(table) ?? [])])
    );
    if (
      query.includes(
        "JSONExtractString(payload_json, 'schema') != {currentSchema:String}"
      )
    ) {
      const currentSchema = url.searchParams.get("param_currentSchema");
      rows = rows.filter((row) => {
        const payload = JSON.parse(String(row.payload_json)) as {
          readonly schema?: unknown;
        };
        return payload.schema !== currentSchema;
      });
    }
    if (
      query.includes(
        "JSONExtractString(payload_json, 'schema') != {discoverySchema:String}"
      )
    ) {
      const discoverySchema = url.searchParams.get("param_discoverySchema");
      rows = rows.filter((row) => {
        const payload = JSON.parse(String(row.payload_json)) as {
          readonly schema?: unknown;
        };
        return payload.schema !== discoverySchema;
      });
    }
    if (
      query.includes(
        "JSONExtractString(payload_json, 'schema') = {discoverySchema:String}"
      )
    ) {
      const discoverySchema = url.searchParams.get("param_discoverySchema");
      rows = rows.filter((row) => {
        const payload = JSON.parse(String(row.payload_json)) as {
          readonly schema?: unknown;
        };
        return payload.schema === discoverySchema;
      });
    }

    const count = query.includes("count() AS total");
    if (count)
      return Response.json(
        { total: String(rows.length) },
        {
          status: 200
        }
      );

    const keyColumn = tableKeyColumn(table);
    const cursorRows = cursorSyntheticRows(url, table, rows);
    const timeColumn =
      table === "playtest_episodes" ? "assigned_at" : "created_at";
    cursorRows.sort(
      (a, b) =>
        SYNTHETIC_COLLATOR.compare(
          String(b[timeColumn]),
          String(a[timeColumn])
        ) ||
        SYNTHETIC_COLLATOR.compare(String(b[keyColumn]), String(a[keyColumn]))
    );
    const limit = Number(url.searchParams.get("param_limit") ?? "500");
    return new Response(
      cursorRows
        .slice(0, limit)
        .map((row) => JSON.stringify(row))
        .join("\n"),
      { status: 200 }
    );
  };
  return { fetchImpl, calls, tables };
}

test("cross-session synthesis codec enforces its canonical workspace and packet identities", () => {
  const artifact = crossSessionSynthesis();
  const encoded = encodeCrossSessionSynthesis("workspace-a/game", artifact);
  assert.equal(encoded.analysis_id, artifact.analysisId);
  assert.deepEqual(
    decodeCrossSessionSynthesis(encoded as unknown as Record<string, unknown>),
    artifact
  );
  assert.throws(
    () => encodeCrossSessionSynthesis("workspace-b/game", artifact),
    /workspace does not match/u
  );
  const forged = {
    ...artifact,
    claims: [
      {
        ...artifact.claims[0]!,
        evidenceRefs: [
          { ...artifact.claims[0]!.evidenceRefs[0]!, packetId: "packet-2" },
          ...artifact.claims[0]!.evidenceRefs.slice(1)
        ]
      }
    ]
  };
  assert.throws(() => encodeCrossSessionSynthesis("workspace-a/game", forged));
});

test("cross-session synthesis codec migrates v1 without inferring metric history", () => {
  const artifact = crossSessionSynthesis();
  const encoded = encodeCrossSessionSynthesis("workspace-a/game", artifact);
  const historical = { ...artifact } as Record<string, unknown>;
  delete historical.metricAggregation;
  historical.schema = PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA_V1;
  const migrated = decodeCrossSessionSynthesis({
    ...encoded,
    payload_json: JSON.stringify(historical)
  });
  assert.equal(migrated.schema, PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA);
  assert.equal(migrated.metricAggregation.status, "not-recorded");
  assert.equal(
    migrated.metricAggregation.reason,
    "historical-synthesis-predates-aggregation"
  );
  assert.deepEqual(migrated.metricAggregation.rows, []);
});

test("comparison codec rejects legacy finding aliases on write and read", () => {
  const current = comparison();
  const row = encodeComparison(current);
  const legacy = { ...current, sourceFindingIds: ["finding-1"] };
  assert.throws(
    () => encodeComparison(legacy),
    /canonical stable finding IDs/u
  );
  assert.throws(
    () =>
      decodeComparison({
        ...row,
        payload_json: JSON.stringify(legacy)
      }),
    /noncanonical source finding ID/u
  );
});

test("finding codec rejects workspace spoofing, fingerprint tampering, and legacy rows without stable identity", () => {
  const artifact = finding();
  const row = encodeFinding("workspace-a/game", artifact);
  const prevalenceUnknown = finding({
    affectedEpisodes: null,
    totalEligibleEpisodes: null,
    affectedOpportunities: null,
    totalEligibleOpportunities: null
  });
  assert.deepEqual(
    decodeFinding(encodeFinding("workspace-a/game", prevalenceUnknown)),
    prevalenceUnknown
  );
  assert.throws(
    () => encodeFinding("workspace-b/game", artifact),
    /identity workspaceId must match/u
  );
  assert.throws(
    () =>
      encodeFinding("workspace-a/game", {
        ...artifact,
        fingerprint: "f".repeat(64)
      }),
    /does not match SHA-256/u
  );
  assert.throws(
    () =>
      encodeFinding("workspace-a/game", { ...artifact, affectedEpisodes: 11 }),
    /cannot exceed eligible denominators/u
  );
  assert.throws(
    () =>
      encodeFinding("workspace-a/game", {
        ...artifact,
        affectedOpportunities: -1
      }),
    /non-negative safe integers/u
  );
  assert.throws(
    () => decodeFinding({ ...row, fingerprint: "" }),
    /fingerprint index column is not/u
  );
  assert.throws(
    () =>
      decodeFinding({
        ...row,
        payload_json: JSON.stringify({
          findingId: artifact.findingId,
          version: 1
        })
      }),
    /identity|fingerprint|findingId/u
  );
});

test("batch artifact state sees historical receipt refs and current status with workspace binding", async () => {
  const packetArtifact = {
    artifactId: "packet-artifact-1",
    sha256: "f".repeat(64),
    bytes: 512,
    mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE
  } as const;
  const selectedBatch = {
    ...batch(),
    revision: 2,
    reviewSelection: {
      schema: PLAYTESTS_REVIEW_SELECTION_SCHEMA,
      status: "selected",
      inventoryHash: "a".repeat(64),
      seed: "selection-seed",
      stratification: PLAYTESTS_REVIEW_STRATIFICATION,
      maxReviewedSessions: 1,
      critiqueBudget: 1,
      reviewCap: 1,
      reviewablePopulation: 1,
      unreviewableAssignments: 0,
      surveillance: { status: "disabled", budget: 0 },
      discovery: { status: "disabled", budget: 0 },
      selected: [
        {
          assignmentId: "a-00001",
          episodeId: "episode-00001",
          stream: "surveillance",
          stratumKey: "heuristic/tutorial/win",
          inclusionProbability: null,
          discoveryRank: null,
          signalValue: null
        }
      ],
      selectedAt: "2026-10-01T00:00:01.000Z"
    },
    reviewPackets: [
      {
        status: "prepared",
        packetId: "packet-history-1",
        assignmentId: "a-00001",
        episodeId: "episode-00001",
        artifact: packetArtifact,
        failureReason: null,
        createdAt: "2026-10-01T00:00:01.000Z"
      }
    ]
  } as unknown as PlaytestBatch;
  const latestBatch = {
    ...batch(),
    revision: 3,
    status: "failed",
    reviewSelection: { status: "unavailable", reason: "batch-incomplete" }
  } as PlaytestBatch;
  const encodedHistory = [latestBatch, selectedBatch].map((artifact) => {
    const row = encodeBatch(artifact);
    return {
      ...row,
      workspace_id: artifact.workspaceId,
      batch_id: artifact.batchId,
      revision: artifact.revision,
      status: artifact.status,
      build_sha: artifact.buildSha
    };
  });
  const capturedUrls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    capturedUrls.push(new URL(String(input)));
    return new Response(
      encodedHistory.map((row) => JSON.stringify(row)).join("\n"),
      { status: 200 }
    );
  };
  const repo = new PlaytestRepository({ fetchImpl });
  const state = await repo.getBatchArtifactState("workspace-a/game", "batch-0");
  assert.equal(state.latestStatus, "failed");
  assert.deepEqual(state.packetArtifacts, [packetArtifact]);
  assert.equal(
    capturedUrls[0]?.searchParams.get("param_workspaceId"),
    "workspace-a/game"
  );
  assert.equal(capturedUrls[0]?.searchParams.get("param_batchId"), "batch-0");

  const missing = new PlaytestRepository({
    fetchImpl: async () => new Response("", { status: 200 })
  });
  assert.deepEqual(
    await missing.getBatchArtifactState("workspace-a/game", "absent"),
    {
      latestStatus: null,
      packetArtifacts: []
    }
  );
});

test("batch artifact state refuses history beyond its bounded read limit", async () => {
  const history = Array.from({ length: 129 }, (_, index) => {
    const artifact = { ...batch(), revision: 129 - index };
    return encodeBatch(artifact);
  });
  const repo = new PlaytestRepository({
    fetchImpl: async () =>
      new Response(history.map((row) => JSON.stringify(row)).join("\n"), {
        status: 200
      })
  });
  await assert.rejects(
    repo.getBatchArtifactState("workspace-a/game", "batch-0"),
    /history exceeds the bounded packet-reconciliation limit/u
  );
});

test("batch assignment manifest is durably round-tripped, hash-checked and old history stays unavailable", () => {
  const artifact = batch();
  const encoded = encodeBatch(artifact);
  const decoded = decodeBatch(encoded as unknown as Record<string, unknown>);
  assert.deepEqual(decoded.assignmentInventory, artifact.assignmentInventory);
  assert.deepEqual(decoded.unobservedAssignments, []);

  const reviewSelection = selectPlaytestBatchReviews({
    inventoryHash:
      artifact.assignmentInventory.status === "frozen"
        ? artifact.assignmentInventory.manifest.contentHash
        : "",
    maxReviewedSessions: 1,
    critiqueBudget: 1,
    surveillanceSessions: 1,
    discoverySessions: 0,
    discoverySignal: null,
    candidates: [
      {
        assignmentId: "a-00001",
        episodeId: "episode-selected",
        policyId: "heuristic",
        scenarioId: "tutorial",
        outcomeKey: playtestReviewOutcomeKey("completed", "win"),
        metrics: []
      }
    ],
    unreviewableAssignments: 0,
    selectedAt: "2026-10-01T00:00:00.000Z"
  });
  const packetBatch: PlaytestBatch = {
    ...artifact,
    reviewSelection,
    reviewPackets: [
      {
        status: "prepared",
        packetId: "packet-selected",
        assignmentId: "a-00001",
        episodeId: "episode-selected",
        artifact: {
          artifactId: "artifact-packet",
          sha256: "1".repeat(64),
          bytes: 128,
          mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE
        },
        failureReason: null,
        createdAt: "2026-10-01T00:00:00.000Z"
      }
    ]
  };
  assert.deepEqual(
    decodeBatch(encodeBatch(packetBatch) as unknown as Record<string, unknown>)
      .reviewPackets,
    packetBatch.reviewPackets
  );
  const receiptedBatch: PlaytestBatch = {
    ...packetBatch,
    counts: { ...packetBatch.counts, reviewed: 1 },
    budget: { ...packetBatch.budget, actualCritiques: 1 },
    reviewReceipts: [
      {
        reviewId: "review-selected",
        assignmentId: "a-00001",
        episodeId: "episode-selected",
        packetId: "packet-selected",
        status: "persisted"
      }
    ]
  };
  assert.deepEqual(
    decodeBatch(
      encodeBatch(receiptedBatch) as unknown as Record<string, unknown>
    ).reviewReceipts,
    receiptedBatch.reviewReceipts
  );
  const reservedBatch: PlaytestBatch = {
    ...packetBatch,
    reviewReceipts: [
      {
        reviewId: "review-reserved",
        assignmentId: "a-00001",
        episodeId: "episode-selected",
        packetId: "packet-selected",
        status: "reserved"
      }
    ]
  };
  assert.deepEqual(
    decodeBatch(
      encodeBatch(reservedBatch) as unknown as Record<string, unknown>
    ).reviewReceipts,
    reservedBatch.reviewReceipts
  );
  assert.throws(
    () =>
      encodeBatch({
        ...reservedBatch,
        counts: { ...reservedBatch.counts, reviewed: 1 },
        budget: { ...reservedBatch.budget, actualCritiques: 1 }
      }),
    /persisted review receipts and reservation ledger/u
  );
  const missingReceiptStatus = JSON.parse(
    encodeBatch(reservedBatch).payload_json
  ) as Record<string, unknown>;
  const missingReceiptStatusRows =
    missingReceiptStatus.reviewReceipts as Record<string, unknown>[];
  delete missingReceiptStatusRows[0]!.status;
  assert.throws(
    () =>
      decodeBatch({
        ...encodeBatch(reservedBatch),
        payload_json: JSON.stringify(missingReceiptStatus)
      } as unknown as Record<string, unknown>),
    /persisted review receipts and reservation ledger/u
  );
  assert.throws(
    () =>
      encodeBatch({
        ...receiptedBatch,
        reviewReceipts: [
          { ...receiptedBatch.reviewReceipts[0]!, packetId: "packet-other" }
        ]
      }),
    /do not match.*selection/u
  );
  const unavailablePacketBatch: PlaytestBatch = {
    ...packetBatch,
    reviewPackets: [
      {
        status: "unavailable",
        packetId: "packet-selected",
        assignmentId: "a-00001",
        episodeId: "episode-selected",
        artifact: null,
        failureReason: "trace-unavailable",
        createdAt: "2026-10-01T00:00:00.000Z"
      }
    ]
  };
  assert.deepEqual(
    decodeBatch(
      encodeBatch(unavailablePacketBatch) as unknown as Record<string, unknown>
    ).reviewPackets,
    unavailablePacketBatch.reviewPackets
  );
  assert.throws(
    () => encodeBatch({ ...packetBatch, reviewPackets: [] }),
    /explicitly cover every selected review session/u
  );
  assert.throws(
    () =>
      encodeBatch({
        ...packetBatch,
        reviewPackets: packetBatch.reviewPackets.map((receipt) => ({
          ...receipt,
          packetId: "invalid packet id"
        }))
      }),
    /receipt identity is invalid/u
  );
  assert.throws(
    () =>
      encodeBatch({
        ...packetBatch,
        reviewPackets: [
          {
            status: "prepared",
            packetId: "packet-selected",
            assignmentId: "a-00001",
            episodeId: "episode-selected",
            artifact: {
              artifactId: "artifact-packet",
              sha256: "1".repeat(64),
              bytes: 128,
              mediaType: "text/plain"
            },
            failureReason: null,
            createdAt: "2026-10-01T00:00:00.000Z"
          }
        ]
      }),
    /packet artifact metadata/u
  );
  const missingV3Packets = JSON.parse(
    encodeBatch(packetBatch).payload_json
  ) as Record<string, unknown>;
  delete missingV3Packets.reviewPackets;
  assert.throws(
    () =>
      decodeBatch({
        ...encodeBatch(packetBatch),
        payload_json: JSON.stringify(missingV3Packets)
      } as unknown as Record<string, unknown>),
    /requires its packet and review receipt inventory/u
  );

  const inventory = artifact.assignmentInventory;
  assert.equal(inventory.status, "frozen");
  if (
    inventory.status !== "frozen" ||
    inventory.manifest.mode !== "adapter-accelerated"
  ) {
    assert.fail("The fixture batch must use an adapter assignment manifest.");
  }
  const tampered: PlaytestBatch = {
    ...artifact,
    assignmentInventory: {
      status: "frozen",
      manifest: {
        ...inventory.manifest,
        assignments: inventory.manifest.assignments.map((assignment) => ({
          ...assignment,
          seed: "changed-seed"
        }))
      }
    }
  };
  assert.throws(() => encodeBatch(tampered), /contentHash/u);

  const legacyPayload: Record<string, unknown> = {
    ...artifact,
    schema: PLAYTESTS_BATCH_SCHEMA_V1,
    samplingPlan: null,
    reviewedAssignmentIds: [],
    assignmentOutcomes: []
  };
  delete legacyPayload.assignmentInventory;
  delete legacyPayload.unobservedAssignments;
  delete legacyPayload.reviewSelection;
  delete legacyPayload.reviewReceipts;
  delete legacyPayload.reviewPackets;
  const legacy = decodeBatch({
    ...encoded,
    payload_json: JSON.stringify(legacyPayload)
  } as unknown as Record<string, unknown>);
  assert.equal(legacy.assignmentInventory.status, "unavailable");
  assert.equal(legacy.unobservedAssignments, null);
  assert.equal(legacy.reviewSelection.status, "unavailable");
  assert.deepEqual(legacy.reviewReceipts, []);
  assert.equal(legacy.cancellationReason, null);
  assert.equal(legacy.failureReason, null);
  assert.equal("samplingPlan" in legacy, false);
  assert.equal("reviewedAssignmentIds" in legacy, false);
  assert.equal("assignmentOutcomes" in legacy, false);

  const v2Payload: Record<string, unknown> = {
    ...artifact,
    schema: PLAYTESTS_BATCH_SCHEMA_V2,
    reviewSelection: selectPlaytestBatchReviews({
      inventoryHash:
        artifact.assignmentInventory.status === "frozen"
          ? artifact.assignmentInventory.manifest.contentHash
          : "",
      maxReviewedSessions: 1,
      critiqueBudget: 1,
      surveillanceSessions: 1,
      discoverySessions: 0,
      discoverySignal: null,
      candidates: [
        {
          assignmentId: "a-00001",
          episodeId: "episode-1",
          policyId: "heuristic",
          scenarioId: "tutorial",
          outcomeKey: playtestReviewOutcomeKey("completed", "win"),
          metrics: []
        }
      ],
      unreviewableAssignments: 0,
      selectedAt: "2026-10-01T00:00:00.000Z"
    }),
    counts: { ...artifact.counts, reviewed: 1 },
    budget: { ...artifact.budget, actualCritiques: 1 },
    reviewReceipts: [
      {
        reviewId: "review-legacy",
        assignmentId: "a-00001",
        episodeId: "episode-1"
      }
    ]
  };
  delete v2Payload.reviewPackets;
  const migratedV2 = decodeBatch({
    ...encoded,
    payload_json: JSON.stringify(v2Payload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedV2.coverageManifest, null);
  assert.equal(migratedV2.reviewPackets.length, 1);
  assert.equal(migratedV2.reviewPackets[0]?.status, "unavailable");
  assert.equal(
    migratedV2.reviewPackets[0]?.failureReason,
    "recorded-before-evidence-packets"
  );
  assert.equal(migratedV2.reviewPackets[0]?.assignmentId, "a-00001");
  assert.equal(migratedV2.reviewPackets[0]?.episodeId, "episode-1");
  assert.equal(migratedV2.reviewReceipts[0]?.packetId, null);
  assert.equal(migratedV2.reviewReceipts[0]?.status, "persisted");
  assert.doesNotThrow(() => encodeBatch(migratedV2));

  const cancelled: PlaytestBatch = {
    ...artifact,
    status: "cancelled",
    cancellationReason: "approval-revoked"
  };
  assert.equal(
    decodeBatch(encodeBatch(cancelled) as unknown as Record<string, unknown>)
      .cancellationReason,
    "approval-revoked"
  );
  const interrupted: PlaytestBatch = {
    ...artifact,
    status: "failed",
    failureReason: "nonterminal-batch-recovered"
  };
  assert.equal(
    decodeBatch(encodeBatch(interrupted) as unknown as Record<string, unknown>)
      .failureReason,
    "nonterminal-batch-recovered"
  );
  assert.throws(
    () => encodeBatch({ ...artifact, cancellationReason: "cancelled" }),
    /cancellation reason/u
  );
  assert.throws(
    () =>
      encodeBatch({
        ...artifact,
        failureReason: "nonterminal-batch-recovered"
      }),
    /failure reason/u
  );
});

test("Data round-trips a visual batch with explicit null source identity", () => {
  const artifact = visualBatch();
  const encoded = encodeBatch(artifact);
  assert.equal(encoded.build_sha, "");
  const payload = JSON.parse(encoded.payload_json) as Record<string, unknown>;
  assert.equal(payload.executionMode, "autonomous-visual");
  assert.equal(payload.repository, null);
  assert.equal(payload.buildSha, null);
  assert.equal(payload.configHash, null);
  assert.equal(payload.protocolVersion, null);
  const decoded = decodeBatch(encoded as unknown as Record<string, unknown>);
  assert.deepEqual(decoded, artifact);
  assert.equal(decoded.executionMode, "autonomous-visual");
  assert.equal(decoded.assignmentInventory.status, "frozen-visual");
});

test("Data accepts a running visual batch with explicit empty unobserved outcomes", () => {
  const completed = visualBatch();
  const running: PlaytestVisualBatch = {
    ...completed,
    status: "running",
    counts: {
      ...completed.counts,
      started: 0,
      completed: 0
    },
    completedAt: null,
    unobservedAssignments: []
  };
  assert.doesNotThrow(() => encodeBatch(running));
  assert.throws(
    () => encodeBatch({ ...running, unobservedAssignments: null }),
    /Batch no-episode outcomes must be unique terminal assignments/u
  );
});

test("Data round-trips an in-flight visual episode revision with a durable frame reference", async () => {
  const base = episode(700);
  const visualEpisode: PlaytestEpisode = {
    ...base,
    episodeId: "ep-visual-in-flight",
    batchId: "visual-batch-1",
    assignmentId: "v-0001",
    revision: 2,
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "target-visual-1",
        targetOrigin: "http://localhost:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    identity: {
      ...base.identity,
      repository: null,
      buildSha: null,
      gameBuild: null,
      scenarioId: null,
      configHash: null,
      seed: null,
      rngAlgorithm: null,
      rngVersion: null,
      rngInitialStateHash: null,
      policyId: "smart-direct",
      policyVersion: "1",
      modelId: "autodev/smart",
      modelRevision: null,
      protocolVersion: null
    },
    scenarioFamily: null,
    policyCohort: null,
    strategy: "smart-direct-visual",
    status: "started",
    termination: { reason: "unknown", step: null },
    outcome: "unknown",
    outcomeMetrics: {},
    completionCounts: {
      assigned: 1,
      started: 1,
      completed: 0,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 0
    },
    replayStatus: "unavailable",
    trace: null,
    frames: [
      {
        id: "frame-captured-before-decision",
        kind: "frame",
        step: 0,
        frameIndex: 0
      }
    ],
    stepCount: 0,
    metrics: [],
    assignedAt: "2026-10-17T12:00:00.000Z",
    startedAt: "2026-10-17T12:00:01.000Z",
    completedAt: null,
    simulationWallMs: 0,
    logicalTicks: null,
    policyInferenceMs: 0,
    nativeDurationMs: null,
    completeness: "unknown",
    missingReasons: []
  };
  const fake = makeClickHouseFetch();
  const repository = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  await repository.insertEpisode(visualEpisode);
  assert.deepEqual(
    await repository.getEpisode("workspace-a/game", visualEpisode.episodeId),
    visualEpisode
  );
});

test("Data preserves only a persona cohort explicitly frozen into a visual assignment manifest", () => {
  const artifact = visualBatch("validated-first-time");
  const decoded = decodeBatch(
    encodeBatch(artifact) as unknown as Record<string, unknown>
  );
  assert.equal(decoded.executionMode, "autonomous-visual");
  assert.deepEqual(decoded.cohortIds, ["validated-first-time"]);
  if (decoded.assignmentInventory.status !== "frozen-visual") {
    assert.fail("The visual batch must retain its mode-specific inventory.");
  }
  assert.equal(
    decoded.assignmentInventory.manifest.cohortId,
    "validated-first-time"
  );
});

test("Data refuses adapter-derived coverage or metrics on a visual batch", () => {
  const artifact = visualBatch();
  assert.throws(
    () =>
      encodeBatch({
        ...artifact,
        buildSha: "a".repeat(40)
      } as unknown as PlaytestBatch),
    /Visual batch identity contains adapter facts/u
  );
  assert.throws(
    () =>
      encodeBatch({
        ...artifact,
        coverageManifest: {
          schema: PLAYTESTS_COVERAGE_MANIFEST_SCHEMA,
          workspaceId: artifact.workspaceId,
          batchId: artifact.batchId,
          buildSha: "a".repeat(40),
          rubricHash: "b".repeat(64),
          assignmentManifestHash:
            artifact.assignmentInventory.manifest.contentHash,
          mode: "browser",
          generatedAt: artifact.createdAt,
          assignedEpisodes: 1,
          observedEpisodes: 1,
          cells: [],
          contentHash: "c".repeat(64)
        }
      } as unknown as PlaytestBatch),
    /Visual batches cannot carry confirmatory coverage/u
  );
});

test("Data verifies coverage-manifest hashes and its frozen batch identity", () => {
  const artifact = batchWithCoverage();
  const encoded = encodeBatch(artifact);
  const decoded = decodeBatch(encoded as unknown as Record<string, unknown>);
  assert.deepEqual(decoded.coverageManifest, artifact.coverageManifest);
  assert.equal(decoded.coverageManifest?.cells[0]?.status, "partial");

  const legacyPayload = JSON.parse(encoded.payload_json) as Record<string, any>;
  const currentManifest = legacyPayload.assignmentInventory.manifest;
  const {
    mode: _mode,
    contentHash: _manifestHash,
    ...manifestWithoutMode
  } = currentManifest;
  const legacyManifestDraft = {
    ...manifestWithoutMode,
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V3
  };
  const legacyManifest = {
    ...legacyManifestDraft,
    contentHash: createHash("sha256")
      .update(
        playtestAssignmentManifestHashInput(
          legacyManifestDraft as unknown as PlaytestAssignmentManifestDraft
        )
      )
      .digest("hex")
  };
  const { contentHash: _coverageHash, ...coverageWithoutHash } =
    legacyPayload.coverageManifest;
  const legacyCoverageDraft = {
    ...coverageWithoutHash,
    assignmentManifestHash: legacyManifest.contentHash
  };
  legacyPayload.schema = PLAYTESTS_BATCH_SCHEMA_V3;
  legacyPayload.assignmentInventory.manifest = legacyManifest;
  legacyPayload.coverageManifest = {
    ...legacyCoverageDraft,
    contentHash: createHash("sha256")
      .update(
        playtestCoverageManifestHashInput(
          legacyCoverageDraft as Parameters<
            typeof playtestCoverageManifestHashInput
          >[0]
        )
      )
      .digest("hex")
  };
  delete legacyPayload.executionMode;
  const migratedLegacy = decodeBatch({
    ...encoded,
    payload_json: JSON.stringify(legacyPayload)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedLegacy.schema, PLAYTESTS_BATCH_SCHEMA);
  assert.equal(
    migratedLegacy.coverageManifest?.assignmentManifestHash,
    migratedLegacy.assignmentInventory.status === "frozen"
      ? migratedLegacy.assignmentInventory.manifest.contentHash
      : null
  );
  assert.doesNotThrow(() =>
    assertPlaytestCoverageManifest(migratedLegacy.coverageManifest)
  );
  assert.deepEqual(
    migratedLegacy.coverageManifest?.cells,
    artifact.coverageManifest?.cells
  );

  const invalidLegacyHashPayload = structuredClone(legacyPayload);
  invalidLegacyHashPayload.coverageManifest.contentHash = "f".repeat(64);
  assert.throws(
    () =>
      decodeBatch({
        ...encoded,
        payload_json: JSON.stringify(invalidLegacyHashPayload)
      } as unknown as Record<string, unknown>),
    /content hash is invalid before assignment migration/u
  );

  const invalidLegacyPayload = structuredClone(legacyPayload);
  invalidLegacyPayload.coverageManifest.assignmentManifestHash = "e".repeat(64);
  const { contentHash: _invalidCoverageHash, ...invalidCoverageDraft } =
    invalidLegacyPayload.coverageManifest;
  invalidLegacyPayload.coverageManifest.contentHash = createHash("sha256")
    .update(
      playtestCoverageManifestHashInput(
        invalidCoverageDraft as Parameters<
          typeof playtestCoverageManifestHashInput
        >[0]
      )
    )
    .digest("hex");
  assert.throws(
    () =>
      decodeBatch({
        ...encoded,
        payload_json: JSON.stringify(invalidLegacyPayload)
      } as unknown as Record<string, unknown>),
    /does not match its original batch and assignment identity/u
  );
  assert.throws(
    () =>
      encodeBatch({
        ...artifact,
        coverageManifest: {
          ...artifact.coverageManifest!,
          generatedAt: "2026-10-02T00:00:00.000Z"
        }
      }),
    /coverage manifest content hash/u
  );
  assert.throws(
    () =>
      encodeBatch({
        ...artifact,
        coverageManifest: {
          ...artifact.coverageManifest!,
          assignmentManifestHash: "e".repeat(64)
        }
      }),
    /does not match its frozen rubric and assignment identity/u
  );
});

test("Data durably bounds and accepts a full 1,000-assignment partial batch", () => {
  const template = batch();
  const manifestBase = {
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: "adapter-accelerated",
    batchId: "batch-1000",
    workspaceId: template.workspaceId,
    buildSha: template.buildSha,
    configHash: template.configHash,
    rubricHash: template.rubricHash,
    approvalRevision: 1,
    createdAt: template.createdAt,
    assignments: Array.from(
      { length: PLAYTESTS_MAX_BATCH_ASSIGNMENTS },
      (_, index) => ({
        assignmentId: "a-" + String(index + 1).padStart(4, "0"),
        scenarioId: "tutorial",
        scenarioFamily: "tutorial",
        policyId: "heuristic",
        policyVersion: "1",
        cohort: "novice",
        seed: "seed-" + String(index + 1),
        maxSteps: 50
      })
    )
  } as const;
  const manifest = {
    ...manifestBase,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(manifestBase))
      .digest("hex")
  };
  const unobservedAssignments: PlaytestAssignmentOutcome[] =
    manifest.assignments.map(({ assignmentId }) => ({
      assignmentId,
      episodeId: null,
      state: "infrastructure-failed",
      started: false,
      eligible: false
    }));
  const completeInventory: PlaytestBatch = {
    ...template,
    batchId: manifest.batchId,
    revision: 2,
    assignmentInventory: { status: "frozen", manifest },
    unobservedAssignments,
    reviewSelection: { status: "unavailable", reason: "batch-incomplete" },
    status: "failed",
    counts: {
      assigned: PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
      started: 0,
      completed: 0,
      crashed: 0,
      infrastructureFailed: PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 0
    },
    budget: {
      ...template.budget,
      assignedEpisodes: PLAYTESTS_MAX_BATCH_ASSIGNMENTS
    }
  };

  const row = encodeBatch(completeInventory);
  assert.equal(JSON.parse(row.payload_json).unobservedAssignments.length, 1000);
  assert.equal(Buffer.byteLength(row.payload_json, "utf8") < 512 * 1024, true);
  const decoded = decodeBatch(row as unknown as Record<string, unknown>);
  assert.equal(decoded.assignmentInventory.status, "frozen");
  assert.equal(decoded.assignmentInventory.manifest.assignments.length, 1000);
  assert.equal(decoded.unobservedAssignments?.length, 1000);
});

test("Core artifact round-trips preserve full canonical payloads and latest revisions", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  const batchArtifact = batch();
  const firstEpisode = episode(1);
  const latestEpisode = {
    ...firstEpisode,
    revision: 2,
    outcomeMetrics: { score: 42 }
  };
  const findingArtifact = finding();
  const reviewArtifact = review();
  const comparisonArtifact: PlaytestComparison = {
    ...comparison(),
    metrics: [
      {
        metricId: "completion",
        metricVersion: 1,
        compatibility: "observational",
        meaningfulMargin: 0.02,
        guardrailMargin: null,
        orientedBenefitDelta: null,
        classification: "inconclusive",
        baseline: {
          arm: "baseline",
          assigned: 10,
          eligible: 10,
          missing: 0,
          independentUnits: 10,
          exposure: 10,
          estimate: 0.5,
          rawDelta: null,
          interval: null
        },
        candidate: {
          arm: "candidate",
          assigned: 10,
          eligible: 10,
          missing: 0,
          independentUnits: 10,
          exposure: 10,
          estimate: 0.5,
          rawDelta: null,
          interval: null
        },
        interval: null,
        sourceSemantics: {
          baseline: {
            metricId: "completion",
            metricVersion: 1,
            source: "deterministic",
            quantityHash: "a".repeat(64),
            sourceHash: "b".repeat(64),
            modality: "headless",
            independentUnit: "episode"
          },
          candidate: {
            metricId: "completion",
            metricVersion: 1,
            source: "deterministic",
            quantityHash: "a".repeat(64),
            sourceHash: "b".repeat(64),
            modality: "headless",
            independentUnit: "episode"
          }
        },
        guardrailStatus: "not-applicable",
        notes: "Fixture source fingerprints are retained verbatim."
      }
    ]
  };
  const encodedComparison = encodeComparison(comparisonArtifact);
  const {
    ownerDecisionBy: _ownerDecisionBy,
    ownerDisposition: _ownerDisposition,
    ...legacyComparisonFields
  } = comparisonArtifact;
  const legacyComparison = {
    ...legacyComparisonFields,
    schema: PLAYTESTS_COMPARISON_SCHEMA_V1
  };
  assert.deepEqual(
    decodeComparison({
      ...encodedComparison,
      payload_json: JSON.stringify(legacyComparison)
    } as unknown as Record<string, unknown>),
    {
      ...legacyComparison,
      schema: PLAYTESTS_COMPARISON_SCHEMA,
      ownerDecisionBy: null,
      ownerDisposition: null
    }
  );
  const recordedLegacyComparison = {
    ...legacyComparison,
    ownerDecisionAt: "2026-01-02T00:00:00.000Z",
    ownerDecisionReason: "Historical operator decision without identity."
  };
  const migratedRecordedDecision = decodeComparison({
    ...encodedComparison,
    payload_json: JSON.stringify(recordedLegacyComparison)
  } as unknown as Record<string, unknown>);
  assert.equal(migratedRecordedDecision.ownerDisposition, "not-recorded");
  assert.equal(migratedRecordedDecision.ownerDecisionBy, null);
  const benchmarkArtifact = benchmark();
  const experimentArtifact = experiment();

  const humanStudyArtifact = humanStudy();
  const humanSummaryArtifact = humanSummary("study-00001", 6);

  await repo.insertBatch(batchArtifact);
  await repo.insertEpisode(firstEpisode);
  await repo.insertEpisode(latestEpisode);
  await repo.insertEpisode(latestEpisode);
  await repo.insertFinding("workspace-a/game", findingArtifact);
  await repo.insertReview(reviewArtifact);
  await repo.insertComparison(comparisonArtifact);
  await repo.insertBenchmark(benchmarkArtifact);
  await repo.insertExperiment(experimentArtifact);
  await repo.insertHumanStudy(humanStudyArtifact);
  await repo.insertHumanSummary(humanSummaryArtifact);

  assert.deepEqual(
    await repo.getBatch("workspace-a/game", batchArtifact.batchId),
    batchArtifact
  );
  assert.deepEqual(
    await repo.getEpisode("workspace-a/game", firstEpisode.episodeId),
    latestEpisode
  );
  assert.deepEqual(
    await repo.getFinding("workspace-a/game", findingArtifact.findingId),
    findingArtifact
  );
  assert.deepEqual(
    await repo.getLatestFindingByFingerprint(
      "workspace-a/game",
      findingArtifact.fingerprint
    ),
    findingArtifact
  );
  assert.deepEqual(
    await repo.getLatestReview(
      "workspace-a/game",
      reviewArtifact.episodeId,
      reviewArtifact.reviewId
    ),
    reviewArtifact
  );
  assert.deepEqual(
    await repo.getLatestReviewForEpisode(
      "workspace-a/game",
      reviewArtifact.episodeId
    ),
    reviewArtifact
  );
  const synthesisArtifact = crossSessionSynthesis();
  await repo.insertCrossSessionSynthesis(synthesisArtifact);
  assert.deepEqual(
    await repo.getCrossSessionSynthesisForAnalysis(
      "workspace-a/game",
      synthesisArtifact.analysisId
    ),
    synthesisArtifact
  );

  assert.deepEqual(
    await repo.getLatestComparison(
      "workspace-a/game",
      comparisonArtifact.comparisonId
    ),
    comparisonArtifact
  );
  assert.deepEqual(
    await repo.getLatestBenchmark(
      "workspace-a/game",
      benchmarkArtifact.benchmarkId
    ),
    benchmarkArtifact
  );
  assert.deepEqual(
    await repo.getLatestExperiment(
      "workspace-a/game",
      experimentArtifact.experimentId
    ),
    experimentArtifact
  );
  assert.deepEqual(
    await repo.getLatestHumanStudy(
      "workspace-a/game",
      humanStudyArtifact.studyId
    ),
    humanStudyArtifact
  );
  const summaryRes = await repo.getHumanValidationSummary(
    "workspace-a/game",
    humanSummaryArtifact.studyId
  );
  assert.equal(summaryRes?.suppressionState, "unsuppressed");
  assert.equal(summaryRes?.retainedParticipants, 6);
  assert.ok(
    fake.calls.some((url) =>
      url.searchParams.get("query")?.includes("cityHash64(payload_json)")
    )
  );

  const insertedEpisodeRows = fake.tables.get("playtest_episodes") ?? [];
  assert.equal(insertedEpisodeRows.length, 3);
  assert.equal(
    JSON.parse(String(insertedEpisodeRows[1]?.payload_json)).revision,
    2
  );
  assert.equal(
    insertedEpisodeRows[1]?.trace_hash_manifest,
    latestEpisode.trace?.id
  );
});

test("human import resolves bounded episode links with parameterized workspace-scoped batches", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  const first = episode(101, "workspace-a/game");
  const latest = { ...first, revision: 2, outcome: "loss" as const };
  const other = episode(102, "workspace-b/game");
  await repo.insertEpisode(first);
  await repo.insertEpisode(latest);
  await repo.insertEpisode(other);

  const rows = await repo.getEpisodesByIds("workspace-a/game", [
    first.episodeId,
    other.episodeId,
    "missing-episode"
  ]);
  assert.deepEqual(
    rows.map((item) => item.episodeId),
    [first.episodeId]
  );
  assert.equal(rows[0]!.revision, 2);
  const query = fake.calls.at(-1)!;
  const sql = query.searchParams.get("query") ?? "";
  assert.match(sql, /episode_id IN \(/u);
  assert.doesNotMatch(sql, new RegExp(first.episodeId, "u"));
  assert.equal(query.searchParams.get("param_workspaceId"), "workspace-a/game");
  assert.equal(query.searchParams.get("param_episodeId0"), first.episodeId);
  assert.equal(query.searchParams.get("param_episodeId1"), other.episodeId);

  await assert.rejects(
    repo.getEpisodesByIds(
      "workspace-a/game",
      Array.from({ length: 201 }, (_, i) => String(i))
    ),
    /at most 200 bounded IDs/u
  );
});

test("filtered episode counts reflect the full 10k population and SQL binds values before pagination", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({
    clickhouseUrl: "http://clickhouse.test:8123",
    dbName: "test",
    fetchImpl: fake.fetchImpl
  });
  for (let index = 0; index < 10_000; index += 1) {
    const item = episode(
      index,
      index % 5 ? "workspace-a/game" : "workspace-b/game"
    );
    const encoded = encodeEpisode(item);
    const rows = fake.tables.get("playtest_episodes") ?? [];
    rows.push(encoded as unknown as Record<string, unknown>);
    fake.tables.set("playtest_episodes", rows);
  }
  const page = await repo.listEpisodes(
    {
      workspaceId: "workspace-a/game",
      buildSha: BUILD_SHA_A,
      cohort: "novice",
      status: "completed",
      gameOutcome: "win"
    },
    { limit: 7 }
  );
  const expected = (fake.tables.get("playtest_episodes") ?? []).filter(
    (row) =>
      row.workspace_id === "workspace-a/game" &&
      row.build_sha === BUILD_SHA_A &&
      row.cohort === "novice" &&
      row.status === "completed" &&
      row.game_outcome === "win"
  ).length;
  assert.equal(page.total, expected);
  const episodeSelect = fake.calls
    .map((url) => url.searchParams.get("query") ?? "")
    .find((query) =>
      query.startsWith("SELECT workspace_id, batch_id, episode_id")
    );
  assert.ok(episodeSelect?.includes("scenario, seed, build_sha, policy"));
  assert.equal(
    await repo.countEpisodes({
      workspaceId: "workspace-a/game",
      buildSha: BUILD_SHA_A,
      cohort: "novice",
      status: "completed",
      gameOutcome: "win"
    }),
    expected
  );
  assert.equal(page.rows.length, 7);
  assert.ok(page.nextCursor);
  const select = fake.calls.find((url) =>
    url.searchParams.get("query")?.includes("ORDER BY assigned_at DESC")
  )!;
  const sql = select.searchParams.get("query")!;
  assert.match(sql, /cohort = \{cohort:String\}/u);
  assert.match(sql, /game_outcome = \{gameOutcome:String\}/u);
  assert.ok(sql.indexOf("cohort =") < sql.indexOf("LIMIT"));
  assert.equal(
    select.searchParams.get("param_workspaceId"),
    "workspace-a/game"
  );
  assert.equal(select.searchParams.get("param_buildSha"), BUILD_SHA_A);
});

test("workspace scope and keyset cursors do not expose another workspace or repeat rows", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  for (let index = 0; index < 30; index += 1) {
    const item = episode(
      index,
      index < 20 ? "workspace-a/game" : "workspace-b/game"
    );
    const rows = fake.tables.get("playtest_episodes") ?? [];
    rows.push(encodeEpisode(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_episodes", rows);
  }
  const first = await repo.listEpisodes(
    { workspaceId: "workspace-a/game" },
    { limit: 8 }
  );
  const second = await repo.listEpisodes(
    { workspaceId: "workspace-a/game" },
    { limit: 8, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) }
  );
  assert.equal(first.total, 20);
  assert.ok(
    second.rows.every(
      (item) => item.identity.workspaceId === "workspace-a/game"
    )
  );
  assert.equal(
    new Set([...first.rows, ...second.rows].map((item) => item.episodeId)).size,
    16
  );
  await assert.rejects(
    repo.listEpisodes(
      { workspaceId: "workspace-a/game" },
      { cursor: "not-a-cursor" }
    ),
    PlaytestInvalidCursorError
  );
});

test("SQL-like workspace and filter values remain bound parameters", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  await repo.countEpisodes({
    workspaceId: "ws'; DROP TABLE playtest_episodes; --",
    scenario: "x' OR 1=1 --"
  });
  const query = fake.calls[0]!.searchParams.get("query")!;
  assert.doesNotMatch(query, /DROP TABLE|x' OR 1=1/u);
  assert.equal(
    fake.calls[0]!.searchParams.get("param_workspaceId"),
    "ws'; DROP TABLE playtest_episodes; --"
  );
  assert.equal(
    fake.calls[0]!.searchParams.get("param_scenario"),
    "x' OR 1=1 --"
  );
});

test("missing artifacts are distinct from malformed, unavailable, and failed ClickHouse sources", async () => {
  const missing = new PlaytestRepository({
    fetchImpl: async () => new Response("", { status: 200 })
  });
  assert.equal(await missing.getEpisode("workspace-a/game", "missing"), null);
  for (const fetchImpl of [
    (async () => new Response("not json", { status: 200 })) as typeof fetch,
    (async () =>
      Response.json(
        { total: "many" },
        {
          status: 200
        }
      )) as typeof fetch,
    (async () => new Response("denied", { status: 503 })) as typeof fetch,
    (async () => {
      throw new Error("offline");
    }) as typeof fetch
  ]) {
    const repo = new PlaytestRepository({ fetchImpl });
    await assert.rejects(
      repo.listEpisodes({ workspaceId: "workspace-a/game" }),
      PlaytestSourceUnavailableError
    );
  }
});

test("idempotent schema stores complete canonical payloads but no human-response table or raw trace/frame bytes", async () => {
  const queries: string[] = [];
  const repo = new PlaytestRepository({
    fetchImpl: async (input) => {
      queries.push(new URL(String(input)).searchParams.get("query") ?? "");
      return new Response("", { status: 200 });
    }
  });
  await repo.ensureSchema();
  await repo.ensureSchema();
  assert.equal(
    queries.filter((query) => query.includes("CREATE TABLE IF NOT EXISTS"))
      .length,
    22
  );
  assert.equal(
    queries.filter((query) =>
      query.includes("ADD COLUMN IF NOT EXISTS fingerprint")
    ).length,
    2
  );
  assert.equal(
    queries.filter(
      (query) =>
        query.includes("MODIFY COLUMN") && query.includes("Nullable(UInt32)")
    ).length,
    8
  );
  assert.equal(
    queries.filter(
      (query) =>
        query.includes("playtest_launch_intents") &&
        query.includes("DateTime64(3, 'UTC')")
    ).length,
    4
  );
  const createStatements = queries.filter((query) =>
    query.includes("CREATE TABLE IF NOT EXISTS")
  );
  assert.ok(
    createStatements
      .filter((query) => !query.includes("playtest_launch_intents"))
      .every((query) => query.includes("payload_json"))
  );
  assert.ok(
    createStatements.some(
      (query) =>
        query.includes("playtest_launch_intents") &&
        query.includes("actor_id String") &&
        query.includes("launch_intent_hash String") &&
        query.includes("TTL toDate(created_at) + INTERVAL 90 DAY DELETE")
    )
  );
  assert.ok(queries.some((query) => query.includes("trace_hash_manifest")));
  assert.ok(queries.some((query) => query.includes("playtest_human_studies")));
  assert.ok(
    queries.some((query) => query.includes("playtest_human_summaries"))
  );
  assert.ok(
    queries.every(
      (query) =>
        !/human_experience|participant_id|raw_trace|frame_bytes/u.test(query)
    )
  );
});

test("schema warmup migrates old episodes once and marks only protocol-proven adapter history", async () => {
  const fake = makeClickHouseFetch();
  const oldRows = [10, 11].map((index) => {
    const row = encodeEpisode(episode(index));
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    let buildShaIndex = row.build_sha;
    payload.schema = PLAYTESTS_EPISODE_SCHEMA_V4;
    delete payload.executionProvenance;
    if (index === 10) {
      const identity = payload.identity as Record<string, unknown>;
      identity.repository = "SimulatorLife/RacingGame";
      identity.buildSha = "a".repeat(40);
      buildShaIndex = "a".repeat(40);
      identity.gameBuild = "racing-build-v1";
      identity.configHash = "b".repeat(64);
      identity.observationSchemaHash = "c".repeat(64);
      identity.actionSchemaHash = "d".repeat(64);
      identity.eventSchemaHash = "e".repeat(64);
    } else {
      // The row is adapter-shaped but does not contain its negotiated protocol
      // fact, so the migration must not elevate it to proven adapter history.
      (payload.identity as Record<string, unknown>).protocolVersion = null;
    }
    return {
      ...row,
      build_sha: buildShaIndex,
      payload_json: JSON.stringify(payload)
    };
  });
  fake.tables.set(
    "playtest_episodes",
    oldRows as unknown as Record<string, unknown>[]
  );
  const repository = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  await repository.ensureSchema();

  const provenAdapter = await repository.getEpisode(
    "workspace-a/game",
    "episode-00010"
  );
  assert.ok(provenAdapter);
  assert.equal(provenAdapter.revision, 1);
  assert.equal(provenAdapter.executionProvenance.mode, "adapter-accelerated");
  assert.equal(provenAdapter.executionProvenance.source.kind, "repo-checkout");
  assert.equal(
    provenAdapter.executionProvenance.source.revision,
    "a".repeat(40)
  );
  assert.equal(
    provenAdapter.executionProvenance.source.revisionConfidence,
    "verified"
  );
  assert.equal(
    provenAdapter.executionProvenance.source.checkoutState,
    "unknown"
  );

  const uncertain = await repository.getEpisode(
    "workspace-a/game",
    "episode-00011"
  );
  assert.ok(uncertain);
  assert.equal(uncertain.executionProvenance.mode, "legacy-unknown");
  assert.equal(uncertain.executionProvenance.source.kind, "unknown");
  assert.equal(uncertain.executionProvenance.observationSource, "unknown");
  assert.equal(uncertain.executionProvenance.actionSource, "unknown");
  assert.equal(fake.tables.get("playtest_episodes")?.length, 4);

  await repository.ensureSchema();
  assert.equal(fake.tables.get("playtest_episodes")?.length, 4);
});

test("Data persists actor/workspace-scoped launch receipts and detects conflicting request keys", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  const intent: PlaytestLaunchIntent = {
    workspaceId: "workspace-a/game",
    actorId: "operator-a",
    requestId: "request-1",
    launchIntentHash: "a".repeat(64),
    batchId: "batch-request-1",
    assignmentCount: 2,
    createdAt: "2026-10-16T12:00:00.000Z",
    expiresAt: "2026-11-15T12:00:00.000Z"
  };
  await repo.insertLaunchIntent(intent);
  const persisted = fake.tables.get("playtest_launch_intents")?.[0];
  assert.equal(persisted?.created_at, "2026-10-16 12:00:00.000");
  assert.equal(persisted?.expires_at, "2026-11-15 12:00:00.000");
  assert.deepEqual(
    await repo.getLaunchIntent("workspace-a/game", "operator-a", "request-1"),
    intent
  );
  const reopened = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  assert.deepEqual(
    await reopened.getLaunchIntent(
      "workspace-a/game",
      "operator-a",
      "request-1"
    ),
    intent,
    "the receipt remains recoverable from a new Data repository instance"
  );
  assert.equal(
    await repo.getLaunchIntent("workspace-a/game", "operator-b", "request-1"),
    null
  );
  assert.equal(
    await repo.getLaunchIntent("workspace-b/game", "operator-a", "request-1"),
    null
  );

  await repo.insertLaunchIntent({
    ...intent,
    launchIntentHash: "b".repeat(64),
    batchId: "batch-conflicting-request"
  });
  await assert.rejects(
    repo.getLaunchIntent("workspace-a/game", "operator-a", "request-1"),
    /conflicting launch-intent records/u
  );
});

test("comparisons, benchmarks, and experiments support cursor pagination, full totals, and workspace isolation", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  // 1. Comparisons
  for (let index = 1; index <= 25; index += 1) {
    const item = comparison(
      index,
      index <= 15 ? "workspace-a/game" : "workspace-b/game"
    );
    const rows = fake.tables.get("playtest_comparisons") ?? [];
    rows.push(encodeComparison(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_comparisons", rows);
  }

  const compPage1 = await repo.listComparisons(
    { workspaceId: "workspace-a/game" },
    { limit: 6 }
  );
  assert.equal(compPage1.total, 15);
  assert.equal(compPage1.rows.length, 6);
  assert.ok(compPage1.nextCursor);
  assert.ok(
    compPage1.rows.every(
      (row) => row.provenance.workspaceId === "workspace-a/game"
    )
  );

  const compPage2 = await repo.listComparisons(
    { workspaceId: "workspace-a/game" },
    { limit: 6, cursor: compPage1.nextCursor! }
  );
  assert.equal(compPage2.total, 15);
  assert.equal(compPage2.rows.length, 6);
  assert.ok(compPage2.nextCursor);
  const compIds = new Set([
    ...compPage1.rows.map((r) => r.comparisonId),
    ...compPage2.rows.map((r) => r.comparisonId)
  ]);
  assert.equal(compIds.size, 12);

  const compFiltered = await repo.listComparisons({
    workspaceId: "workspace-a/game",
    decision: "eligible-for-owner-promotion"
  });
  assert.equal(compFiltered.total, 7);
  assert.equal(compFiltered.rows.length, 7);
  assert.equal(
    await repo.countComparisons({
      workspaceId: "workspace-a/game",
      decision: "eligible-for-owner-promotion"
    }),
    7
  );

  // 2. Benchmarks
  for (let index = 1; index <= 25; index += 1) {
    const item = benchmark(
      index,
      index <= 15 ? "workspace-a/game" : "workspace-b/game"
    );
    const rows = fake.tables.get("playtest_benchmarks") ?? [];
    rows.push(encodeBenchmark(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_benchmarks", rows);
  }

  const benchPage1 = await repo.listBenchmarks(
    { workspaceId: "workspace-a/game" },
    { limit: 5 }
  );
  assert.equal(benchPage1.total, 15);
  assert.equal(benchPage1.rows.length, 5);
  assert.ok(benchPage1.nextCursor);
  assert.ok(
    benchPage1.rows.every((row) => row.workspaceId === "workspace-a/game")
  );

  const benchPage2 = await repo.listBenchmarks(
    { workspaceId: "workspace-a/game" },
    { limit: 5, cursor: benchPage1.nextCursor! }
  );
  assert.equal(benchPage2.total, 15);
  assert.equal(benchPage2.rows.length, 5);
  const benchIds = new Set([
    ...benchPage1.rows.map((r) => r.benchmarkId),
    ...benchPage2.rows.map((r) => r.benchmarkId)
  ]);
  assert.equal(benchIds.size, 10);

  const benchFiltered = await repo.listBenchmarks({
    workspaceId: "workspace-a/game",
    referenceBuildSha: "a".repeat(40)
  });
  assert.equal(benchFiltered.total, 7);
  assert.equal(
    await repo.countBenchmarks({
      workspaceId: "workspace-a/game",
      referenceBuildSha: "a".repeat(40)
    }),
    7
  );

  // 3. Experiments
  for (let index = 1; index <= 25; index += 1) {
    const item = experiment(
      index,
      index <= 15 ? "workspace-a/game" : "workspace-b/game"
    );
    const rows = fake.tables.get("playtest_experiments") ?? [];
    rows.push(encodeExperiment(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_experiments", rows);
  }

  const expPage1 = await repo.listExperiments(
    { workspaceId: "workspace-a/game" },
    { limit: 4 }
  );
  assert.equal(expPage1.total, 15);
  assert.equal(expPage1.rows.length, 4);
  assert.ok(expPage1.nextCursor);
  assert.ok(
    expPage1.rows.every((row) => row.workspaceId === "workspace-a/game")
  );

  const expPage2 = await repo.listExperiments(
    { workspaceId: "workspace-a/game" },
    { limit: 4, cursor: expPage1.nextCursor! }
  );
  assert.equal(expPage2.total, 15);
  assert.equal(expPage2.rows.length, 4);
  const expIds = new Set([
    ...expPage1.rows.map((r) => r.experimentId),
    ...expPage2.rows.map((r) => r.experimentId)
  ]);
  assert.equal(expIds.size, 8);

  const expFiltered = await repo.listExperiments({
    workspaceId: "workspace-a/game",
    state: "approved"
  });
  assert.equal(expFiltered.total, 7);
  assert.equal(
    await repo.countExperiments({
      workspaceId: "workspace-a/game",
      state: "approved"
    }),
    7
  );
});

test("cross-session syntheses support workspace-scoped cursor pagination and full counts", async () => {
  const fake = makeClickHouseFetch();
  const repository = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  const rows = Array.from({ length: 18 }, (_, index) => {
    const workspaceId = index < 11 ? "workspace-a/game" : "workspace-b/game";
    const sequence = String(index + 1).padStart(3, "0");
    return crossSessionSynthesis({
      synthesisId: `synthesis-${sequence}`,
      analysisId: `analysis-${sequence}`,
      workspaceId,
      generatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString()
    });
  });
  fake.tables.set(
    "playtest_cross_session_syntheses",
    rows.map(
      (row) =>
        encodeCrossSessionSynthesis(row.workspaceId, row) as unknown as Record<
          string,
          unknown
        >
    )
  );

  const first = await repository.listCrossSessionSyntheses("workspace-a/game", {
    limit: 4
  });
  assert.equal(first.total, 11);
  assert.equal(first.rows.length, 4);
  assert.ok(first.nextCursor);
  assert.ok(first.rows.every((row) => row.workspaceId === "workspace-a/game"));
  const second = await repository.listCrossSessionSyntheses(
    "workspace-a/game",
    {
      limit: 4,
      cursor: first.nextCursor!
    }
  );
  assert.equal(second.total, 11);
  assert.equal(second.rows.length, 4);
  assert.ok(second.nextCursor);
  assert.equal(
    new Set([...first.rows, ...second.rows].map((row) => row.synthesisId)).size,
    8
  );
  assert.ok(
    fake.calls.every((url) => {
      const query = url.searchParams.get("query") ?? "";
      return (
        !query.includes("playtest_cross_session_syntheses") ||
        url.searchParams.get("param_workspaceId") === "workspace-a/game"
      );
    })
  );
});

test("human study metadata supports insertion, benchmark lookup, and filtered pagination", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  for (let index = 1; index <= 20; index += 1) {
    const item = humanStudy(
      index,
      index <= 12 ? "workspace-a/game" : "workspace-b/game"
    );
    const rows = fake.tables.get("playtest_human_studies") ?? [];
    rows.push(encodeHumanStudy(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_human_studies", rows);
  }

  const studyPage1 = await repo.listHumanStudies(
    { workspaceId: "workspace-a/game" },
    { limit: 5 }
  );
  assert.equal(studyPage1.total, 12);
  assert.equal(studyPage1.rows.length, 5);
  assert.ok(studyPage1.nextCursor);
  assert.ok(
    studyPage1.rows.every((row) => row.workspaceId === "workspace-a/game")
  );

  const studyPage2 = await repo.listHumanStudies(
    { workspaceId: "workspace-a/game" },
    { limit: 5, cursor: studyPage1.nextCursor! }
  );
  assert.equal(studyPage2.total, 12);
  assert.equal(studyPage2.rows.length, 5);
  const studyIds = new Set([
    ...studyPage1.rows.map((r) => r.studyId),
    ...studyPage2.rows.map((r) => r.studyId)
  ]);
  assert.equal(studyIds.size, 10);

  const approvedPage = await repo.listHumanStudies({
    workspaceId: "workspace-a/game",
    approved: true
  });
  assert.equal(approvedPage.total, 6);
  assert.equal(
    await repo.countHumanStudies({
      workspaceId: "workspace-a/game",
      approved: true
    }),
    6
  );

  const latestStudy = await repo.getLatestHumanStudy(
    "workspace-a/game",
    "study-00001"
  );
  assert.ok(latestStudy);
  assert.equal(latestStudy.studyId, "study-00001");

  const studyByBench = await repo.getLatestHumanStudyByBenchmark(
    "workspace-a/game",
    "benchmark-1"
  );
  assert.ok(studyByBench);
  assert.equal(studyByBench.workspaceId, "workspace-a/game");
});

test("human summary suppression enforces privacy for <5 retained participants vs unsuppressed for >=5", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  // 1. Unsuppressed summary with >= 5 retained participants
  const unsuppressedSummary = humanSummary("study-5", 5);
  await repo.insertHumanSummary(unsuppressedSummary);

  const res5 = await repo.getHumanValidationSummary(
    "workspace-a/game",
    "study-5"
  );
  assert.ok(res5);
  assert.equal(res5.suppressionState, "unsuppressed");
  if (res5.suppressionState === "unsuppressed") {
    assert.equal(res5.retainedParticipants, 5);
    assert.equal(res5.items.length, 1);
    assert.equal(res5.items[0]?.itemId, "ENJ");
    assert.equal(res5.items[0]?.mean, 2.5);
    assert.equal(res5.items[0]?.respondentCount, 5);
    assert.deepEqual(res5.items[0]?.categoryCounts, {
      "-3": 0,
      "-2": 0,
      "-1": 0,
      "0": 0,
      "1": 1,
      "2": 2,
      "3": 2
    });
  }

  // 2. Suppressed summary with < 5 retained participants (small-cell response)
  const suppressedSummary = humanSummary(
    "study-4",
    4,
    1,
    false,
    "workspace-a/game",
    "benchmark-suppressed"
  );
  await repo.insertHumanSummary(suppressedSummary);

  const res4 = await repo.getHumanValidationSummary(
    "workspace-a/game",
    "study-4"
  );
  assert.ok(res4);
  assert.equal(res4.suppressionState, "suppressed");
  assert.equal(
    res4.suppressionReason,
    "small-cell-privacy-retained-participants-under-5"
  );
  assert.equal("retainedParticipants" in res4, false);
  assert.equal("items" in res4, false);
  assert.equal("mean" in res4, false);
  assert.equal("distribution" in res4, false);
  assert.equal("categoryCounts" in res4, false);
  assert.equal("participantId" in res4, false);

  // 3. Querying by benchmark also applies suppression
  const benchSummarySuppressed =
    await repo.getHumanValidationSummaryByBenchmark(
      "workspace-a/game",
      "benchmark-suppressed"
    );
  assert.ok(benchSummarySuppressed);
  assert.equal(benchSummarySuppressed.suppressionState, "suppressed");

  const benchSummaryUnsuppressed =
    await repo.getHumanValidationSummaryByBenchmark(
      "workspace-a/game",
      "benchmark-1"
    );
  assert.ok(benchSummaryUnsuppressed);
  assert.equal(benchSummaryUnsuppressed.suppressionState, "unsuppressed");
});

test("withdrawals and tombstone revisions remove prior summary from active reads", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  // Revision 1: active unsuppressed summary with 6 retained participants
  await repo.insertHumanSummary(humanSummary("study-tombstone", 6, 1, false));

  const beforeWithdrawal = await repo.getHumanValidationSummary(
    "workspace-a/game",
    "study-tombstone"
  );
  assert.ok(beforeWithdrawal);
  assert.equal(beforeWithdrawal.suppressionState, "unsuppressed");

  // Revision 2: participant withdrawal / tombstone revision
  await repo.insertHumanSummary(humanSummary("study-tombstone", 0, 2, true));

  const afterWithdrawal = await repo.getHumanValidationSummary(
    "workspace-a/game",
    "study-tombstone"
  );
  assert.equal(afterWithdrawal, null);

  assert.equal(
    await repo.getLatestHumanSummary("workspace-a/game", "study-tombstone"),
    null
  );
});

test("human summary codec strictly rejects raw participant IDs, response IDs, and free text", () => {
  const base = humanSummary("study-leak", 5);

  assert.throws(
    () =>
      encodeHumanSummary({
        ...base,
        participantId: "p-12345"
      } as unknown as PlaytestHumanAggregateRecord),
    /Participant-identifying or raw response field "participantId" is prohibited/u
  );

  assert.throws(
    () =>
      encodeHumanSummary({
        ...base,
        pseudonymousParticipantId: "pseudo-12345"
      } as unknown as PlaytestHumanAggregateRecord),
    /Participant-identifying or raw response field "pseudonymousParticipantId" is prohibited/u
  );

  assert.throws(
    () =>
      encodeHumanSummary({
        ...base,
        freeText: "User said this was fun"
      } as unknown as PlaytestHumanAggregateRecord),
    /Participant-identifying or raw response field "freeText" is prohibited/u
  );

  assert.throws(
    () =>
      encodeHumanSummary({
        ...base,
        items: [
          {
            ...base.items[0]!,
            participantId: "leak"
          } as unknown as PlaytestHumanAggregateRecord["items"][number]
        ]
      }),
    /Raw participant or response fields are prohibited in human item summaries/u
  );
});

test("unavailable and malformed ClickHouse failures never appear as empty collections or zero counts across all entities", async () => {
  for (const fetchImpl of [
    (async () => new Response("not json", { status: 200 })) as typeof fetch,
    (async () =>
      Response.json(
        { total: "invalid-count" },
        { status: 200 }
      )) as typeof fetch,
    (async () =>
      new Response("service unavailable", { status: 503 })) as typeof fetch,
    (async () => {
      throw new Error("network partition");
    }) as typeof fetch
  ]) {
    const repo = new PlaytestRepository({ fetchImpl });

    await assert.rejects(
      repo.listComparisons({ workspaceId: "workspace-a/game" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.countComparisons({ workspaceId: "workspace-a/game" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getLatestComparison("workspace-a/game", "comp-1"),
      PlaytestSourceUnavailableError
    );

    await assert.rejects(
      repo.listBenchmarks({ workspaceId: "workspace-a/game" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.countBenchmarks({ workspaceId: "workspace-a/game" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getLatestBenchmark("workspace-a/game", "bench-1"),
      PlaytestSourceUnavailableError
    );

    await assert.rejects(
      repo.listExperiments({ workspaceId: "workspace-a/game" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.countExperiments({ workspaceId: "workspace-a/game" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getLatestExperiment("workspace-a/game", "exp-1"),
      PlaytestSourceUnavailableError
    );

    await assert.rejects(
      repo.listHumanStudies({ workspaceId: "workspace-a/game" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.countHumanStudies({ workspaceId: "workspace-a/game" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getLatestHumanStudy("workspace-a/game", "study-1"),
      PlaytestSourceUnavailableError
    );

    await assert.rejects(
      repo.getHumanValidationSummary("workspace-a/game", "study-1"),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getHumanValidationSummaryByBenchmark(
        "workspace-a/game",
        "benchmark-1"
      ),
      PlaytestSourceUnavailableError
    );
  }
});
