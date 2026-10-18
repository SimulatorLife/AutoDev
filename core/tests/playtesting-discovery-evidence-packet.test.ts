import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertPlaytestDiscoveryEvidencePacket,
  assertPlaytestDiscoveryReviewDraft,
  assertPlaytestDiscoveryReviewGroundedInPacket,
  assertPlaytestDiscoverySessionReview,
  buildPlaytestDiscoveryEvidencePacket,
  playtestAssignmentManifestHashInput,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
  type PlaytestDiscoveryEvidencePacket,
  type PlaytestEpisode,
  type PlaytestVisualAssignmentManifest
} from "../src/playtesting/index.ts";

const WORKSPACE = "SimulatorLife/RacingGame";
const BATCH_ID = "batch-visual-discovery-1";
const EPISODE_ID = "ep-visual-discovery-1";

function visualManifest(): PlaytestVisualAssignmentManifest {
  const draft = {
    schema: PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: "autonomous-visual" as const,
    batchId: BATCH_ID,
    workspaceId: WORKSPACE,
    targetId: "racing-game-local",
    targetApprovalId: "approval-racinggame-1",
    targetRevision: 1,
    targetOrigin: "http://127.0.0.1:5173",
    policyId: "smart-direct" as const,
    policyVersion: "1",
    cohortId: null,
    areasOfFocus: "Explore the race setup screen.",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 2,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 4,
      smartTokensPerEpisode: 1000,
      screenshotCountPerEpisode: 4,
      artifactBytesPerEpisode: 1024 * 1024
    },
    createdAt: "2026-10-17T12:00:00.000Z",
    assignments: [{ assignmentId: "vis-assign-1", ordinal: 0, maxSteps: 2 }]
  };
  return {
    ...draft,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(draft))
      .digest("hex")
  };
}

function visualEpisode(manifest = visualManifest()): PlaytestEpisode {
  return {
    schema: PLAYTESTS_EPISODE_SCHEMA,
    episodeId: EPISODE_ID,
    revision: 3,
    batchId: manifest.batchId,
    assignmentId: manifest.assignments[0]!.assignmentId,
    branchLineage: null,
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: manifest.targetId,
        targetOrigin: manifest.targetOrigin
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    identity: {
      workspaceId: manifest.workspaceId,
      repository: null,
      buildSha: null,
      gameBuild: null,
      scenarioId: null,
      configHash: null,
      seed: null,
      policyId: "smart-direct",
      policyVersion: "1",
      modelId: "autodev/smart",
      modelRevision: null,
      observationSchemaHash: "a".repeat(64),
      actionSchemaHash: "b".repeat(64),
      eventSchemaHash: "c".repeat(64),
      protocolVersion: null,
      runtimeVersion: "runtime-test",
      environmentHash: "d".repeat(64),
      rngAlgorithm: null,
      rngVersion: null,
      rngInitialStateHash: null
    },
    scenarioFamily: null,
    policyCohort: null,
    strategy: "smart-direct-visual",
    status: "completed",
    termination: { reason: "step-limit", step: 2 },
    outcome: "unknown",
    outcomeMetrics: {},
    completionCounts: {
      assigned: 1,
      started: 1,
      completed: 0,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 1,
      reviewed: 0,
      eligible: 0
    },
    replayStatus: "unavailable",
    trace: { kind: "replay-segment", id: "trace-visual-1" },
    frames: [
      { kind: "frame", id: "frame-visual-0", step: 0, frameIndex: 0 },
      { kind: "frame", id: "frame-visual-1", step: 1, frameIndex: 1 }
    ],
    stepCount: 2,
    metrics: [],
    findingIds: [],
    assignedAt: "2026-10-17T12:00:00.000Z",
    startedAt: "2026-10-17T12:00:01.000Z",
    completedAt: "2026-10-17T12:00:05.000Z",
    simulationWallMs: 4000,
    logicalTicks: null,
    policyInferenceMs: 500,
    nativeDurationMs: null,
    completeness: "partial",
    missingReasons: ["budget-truncated"]
  };
}

function frame(frameId: string, step: number, sha256: string) {
  return {
    frameId,
    step,
    frameIndex: step,
    sha256,
    capturedAt: "2026-10-17T12:00:0" + String(step + 1) + ".000Z",
    captureWidthPx: 1280,
    captureHeightPx: 720,
    visibleStateRef: null,
    reason: "captured" as const,
    redactedSurfaces: []
  };
}

function stepEvidence(step: number, frameId: string) {
  const controlId = "control-" + String(step + 1);
  const intention = "Inspect visible stage " + String(step + 1) + ".";
  const prediction =
    "The stage " + String(step + 1) + " panel will remain visible.";
  return {
    step,
    phaseId: "race-setup",
    observationVisibility: "visual-only" as const,
    visibleObservation: {
      phase: "race-setup",
      controls: [
        {
          controlId,
          role: "button",
          name: "Stage " + String(step + 1),
          enabled: true
        }
      ]
    },
    selectedActionId: controlId,
    legalActionIds: [controlId],
    preActionPrediction: { intention, predictedVisibleEffect: prediction },
    authoritativeOutcome: { status: "dispatched" },
    actionReceipt: {
      receiptId: "receipt-" + String(step + 1),
      step,
      observationId: "observation-" + String(step + 1),
      status: "dispatched" as const,
      refusalReason: null,
      selectedActionId: controlId,
      inputKind: "semantic-control" as const,
      controlId,
      safeKey: null,
      coordinates: null,
      intention,
      predictedVisibleEffect: prediction,
      visibleConsequence: { status: "not-observed" },
      receivedAt: "2026-10-17T12:00:0" + String(step + 1) + ".000Z"
    },
    observationNotes: [],
    affordanceNotes: [],
    frameIds: [frameId]
  };
}

function buildPacket(
  overrides: Partial<
    Parameters<typeof buildPlaytestDiscoveryEvidencePacket>[0]
  > = {}
): PlaytestDiscoveryEvidencePacket {
  const manifest = visualManifest();
  const episode = visualEpisode(manifest);
  const frames = [
    frame("frame-visual-0", 0, "1".repeat(64)),
    frame("frame-visual-1", 1, "2".repeat(64))
  ];
  return buildPlaytestDiscoveryEvidencePacket({
    packetId: "packet-discovery-visual-1",
    episode,
    visualBatch: {
      batchId: manifest.batchId,
      workspaceId: manifest.workspaceId,
      assignmentManifest: manifest
    },
    stepEvidence: [
      stepEvidence(0, "frame-visual-0"),
      stepEvidence(1, "frame-visual-1")
    ],
    frames,
    frameHashes: Object.fromEntries(
      frames.map((candidate) => [candidate.frameId, candidate.sha256])
    ),
    traceHash: "3".repeat(64),
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    modelId: "autodev/smart",
    modelRevision: null,
    promptHash: null,
    tokenBudget: 8192,
    chronologicalSummary:
      "The player-visible run opened the race setup and showed two selectable stages.",
    generatedAt: "2026-10-17T12:01:00.000Z",
    ...overrides
  });
}

test("visual discovery packet is content-addressed, hypothesis-only, and contains visible evidence", () => {
  const packet = buildPacket();
  assertPlaytestDiscoveryEvidencePacket(packet);
  assert.match(packet.packetHash, /^[a-f0-9]{64}$/u);
  assert.equal(packet.analysisKind, "discovery");
  assert.equal(packet.target.targetId, "racing-game-local");
  assert.equal(packet.model.modelId, "autodev/smart");
  assert.equal(packet.model.modelRevision, null);
  assert.equal(packet.stepEvidence.length, 2);
  assert.equal(packet.frames.length, 2);
  assert.equal(packet.visibleEvidenceOnly, true);
  assert.equal("rubricHash" in packet, false);
  assert.equal("coverageManifest" in packet, false);
  assert.equal("metrics" in packet, false);
});

test("discovery packet rejects adapter episodes and mismatched target/assignment identity", () => {
  const manifest = visualManifest();
  const packetInput = {
    packetId: "packet-discovery-visual-1",
    episode: visualEpisode(manifest),
    visualBatch: {
      batchId: manifest.batchId,
      workspaceId: manifest.workspaceId,
      assignmentManifest: manifest
    },
    stepEvidence: [
      stepEvidence(0, "frame-visual-0"),
      stepEvidence(1, "frame-visual-1")
    ],
    frames: [
      frame("frame-visual-0", 0, "1".repeat(64)),
      frame("frame-visual-1", 1, "2".repeat(64))
    ],
    frameHashes: {
      "frame-visual-0": "1".repeat(64),
      "frame-visual-1": "2".repeat(64)
    },
    traceHash: "3".repeat(64),
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    modelId: null,
    modelRevision: null,
    promptHash: null,
    tokenBudget: 8192,
    chronologicalSummary: "The visible stages were selectable.",
    generatedAt: "2026-10-17T12:01:00.000Z"
  } as const;
  const visualProvenance = visualEpisode(manifest).executionProvenance;
  const adapterEpisode = {
    ...visualEpisode(manifest),
    executionProvenance: {
      ...visualProvenance,
      mode: "adapter-accelerated"
    }
  } as unknown as PlaytestEpisode;
  assert.throws(
    () =>
      buildPlaytestDiscoveryEvidencePacket({
        ...packetInput,
        episode: adapterEpisode
      }),
    /Adapter-accelerated episodes require/u
  );
  assert.throws(
    () =>
      buildPlaytestDiscoveryEvidencePacket({
        ...packetInput,
        visualBatch: {
          ...packetInput.visualBatch,
          assignmentManifest: {
            ...manifest,
            targetId: "other-target"
          }
        }
      }),
    /target binding/u
  );
});

test("discovery packet rejects mismatched frame hash and invalid packet citations", () => {
  const manifest = visualManifest();
  const packet = buildPacket();
  assert.throws(
    () =>
      buildPlaytestDiscoveryEvidencePacket({
        packetId: "packet-discovery-visual-2",
        episode: visualEpisode(manifest),
        visualBatch: {
          batchId: manifest.batchId,
          workspaceId: manifest.workspaceId,
          assignmentManifest: manifest
        },
        stepEvidence: [
          stepEvidence(0, "frame-visual-0"),
          stepEvidence(1, "frame-visual-1")
        ],
        frames: [
          frame("frame-visual-0", 0, "4".repeat(64)),
          frame("frame-visual-1", 1, "2".repeat(64))
        ],
        frameHashes: {
          "frame-visual-0": "1".repeat(64),
          "frame-visual-1": "2".repeat(64)
        },
        traceHash: "3".repeat(64),
        measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
        modelId: null,
        modelRevision: null,
        promptHash: null,
        tokenBudget: 8192,
        chronologicalSummary: "The visible stages were selectable.",
        generatedAt: "2026-10-17T12:01:00.000Z"
      }),
    /frame sha256 contradicts/u
  );

  const draft = {
    reviewId: "review-discovery-1",
    packetId: packet.packetId,
    chronologicalSummary:
      "Two stage controls were visible in the selected frames.",
    observations: [
      {
        hypothesisId: "obs-1",
        status: "hypothesis" as const,
        text: "The stage controls were visible.",
        evidenceRefs: [{ kind: "episode" as const, id: EPISODE_ID }]
      }
    ],
    interpretations: [
      {
        hypothesisId: "int-1",
        status: "not-observed" as const,
        text: "The packet does not show whether selecting a stage starts the race.",
        evidenceRefs: [
          { kind: "replay-segment" as const, id: "trace-visual-1" }
        ]
      }
    ],
    alternativeExplanations: [],
    experiments: [],
    authorRole: "playtest-analyst" as const
  };
  assertPlaytestDiscoveryReviewDraft(draft);
  assert.doesNotThrow(() =>
    assertPlaytestDiscoveryReviewGroundedInPacket(draft, packet)
  );
  assert.throws(
    () =>
      assertPlaytestDiscoveryReviewGroundedInPacket(
        {
          ...draft,
          observations: [
            {
              ...draft.observations[0]!,
              evidenceRefs: [
                { kind: "frame", id: "frame-not-supplied", step: 99 }
              ]
            }
          ]
        },
        packet
      ),
    /frame locator is absent from the selected evidence packet/u
  );
  assert.throws(
    () =>
      assertPlaytestDiscoveryReviewDraft({
        ...draft,
        score: 9
      }),
    /unknown or missing fields/u
  );
});

test("persisted discovery review schema refuses metric and rubric claims", () => {
  const review = {
    schema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
    analysisKind: "discovery",
    reviewId: "review-discovery-1",
    version: 1,
    workspaceId: WORKSPACE,
    batchId: BATCH_ID,
    episodeId: EPISODE_ID,
    supersedes: null,
    evidencePacket: {
      packetId: "packet-discovery-visual-1",
      artifact: {
        artifactId: "packet-discovery-visual-1",
        sha256: "4".repeat(64),
        bytes: 512,
        mediaType: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE
      }
    },
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    chronologicalSummary: "The selected frames show two selectable stages.",
    observations: [
      {
        hypothesisId: "obs-1",
        status: "hypothesis",
        text: "The stage options were visible.",
        evidenceRefs: [{ kind: "frame", id: "frame-visual-0", step: 0 }]
      }
    ],
    interpretations: [],
    alternativeExplanations: [],
    experiments: [],
    evidenceRefs: [{ kind: "frame", id: "frame-visual-0", step: 0 }],
    createdAt: "2026-10-17T12:02:00.000Z",
    status: "hypothesis"
  };
  assertPlaytestDiscoverySessionReview(review);
  assert.throws(
    () =>
      assertPlaytestDiscoverySessionReview({
        ...review,
        rubricHash: "invented-rubric"
      }),
    /unknown or missing fields/u
  );
});
