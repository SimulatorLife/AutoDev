import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertPlaytestDiscoveryEvidencePacket,
  assertPlaytestEvidenceLocatorsWithinPacket,
  assertPlaytestDiscoveryReviewDraft,
  assertPlaytestDiscoveryReviewGroundedInPacket,
  assertPlaytestDiscoverySessionReview,
  buildPlaytestDiscoveryEvidencePacket,
  canonicalPlaytestJson,
  playtestAssignmentManifestHashInput,
  type PlaytestDiscoveryEvidencePacket,
  type PlaytestDiscoveryEvidencePacketV3,
  type PlaytestDiscoveryVisibleControl,
  type PlaytestDiscoveryVisibleState,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MAX_TOKENS,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V2,
  PLAYTESTS_DISCOVERY_CONTROL_NAME_MAX_LENGTH,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V3,
  PLAYTESTS_DISCOVERY_MAX_CONTROLS_PER_STEP,
  playtestDiscoveryEvidencePacketHashInput,
  type PlaytestEpisode,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
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
    playerDebrief: {
      schema: "autodev-playtest-player-debrief-v1",
      status: "unavailable",
      reason: "player-report-not-authored"
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

function visibleState(
  step: number,
  controls: readonly {
    readonly controlId: string;
    readonly role: string;
    readonly name: string;
    readonly enabled: boolean;
  }[]
): PlaytestDiscoveryVisibleState {
  return {
    capturedAt: "2026-10-17T12:00:0" + String(step + 1) + ".000Z",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    privacyState: "clear",
    phase: "race-setup",
    progress: null,
    warnings: [],
    controls,
    observedControlCount: controls.length,
    omittedControlCount: 0,
    truncatedNameCount: 0
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
    visibleObservation: visibleState(step, [
      {
        controlId,
        role: "button",
        name: "Stage " + String(step + 1),
        enabled: true
      }
    ]),
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
    frameIds: [frameId]
  };
}

function buildPacket(
  overrides: Partial<
    Parameters<typeof buildPlaytestDiscoveryEvidencePacket>[0]
  > = {}
): PlaytestDiscoveryEvidencePacketV3 {
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

test("discovery packet v3 bounds the visible state and keeps v1/v2 artifacts readable", () => {
  const packet = buildPacket();
  assert.equal(packet.schema, PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V3);
  assert.deepEqual(packet.playerSelfReport, visualEpisode().playerDebrief);
  // A v1/v2 artifact carries the recorded observation and the affordance
  // index; the historical readers still accept it.
  const legacyStepEvidence = packet.stepEvidence.map((step) => ({
    ...step,
    visibleObservation: {
      phase: step.phaseId,
      controls: step.visibleObservation.controls
    },
    affordanceNotes: []
  }));
  const legacy = {
    ...packet,
    stepEvidence: legacyStepEvidence
  };
  const { playerSelfReport: _selfReport, ...historical } = legacy;
  const v1 = {
    ...historical,
    schema: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA
  };
  assert.doesNotThrow(() => assertPlaytestDiscoveryEvidencePacket(v1));
  const { areasOfFocus: _focus, ...immutableV1 } = historical;
  assert.doesNotThrow(() =>
    assertPlaytestDiscoveryEvidencePacket({
      ...immutableV1,
      schema: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA
    })
  );
  assert.doesNotThrow(() =>
    assertPlaytestDiscoveryEvidencePacket({
      ...legacy,
      schema: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V2
    })
  );
  assert.throws(
    () =>
      assertPlaytestDiscoveryEvidencePacket({
        ...v1,
        playerSelfReport: packet.playerSelfReport
      }),
    /unknown or missing fields/u
  );
});

test("v2 hash covers playerSelfReport and validates report states and frame receipts", () => {
  const packet = buildPacket();
  const hash = (value: PlaytestDiscoveryEvidencePacketV3) =>
    createHash("sha256")
      .update(playtestDiscoveryEvidencePacketHashInput(value))
      .digest("hex");
  assert.equal(hash(packet), packet.packetHash);
  assert.notEqual(
    hash({
      ...packet,
      playerSelfReport: {
        schema: "autodev-playtest-player-debrief-v1",
        status: "absent",
        reason: "legacy-no-report"
      }
    }),
    packet.packetHash
  );

  const reports = [
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "absent",
      reason: "legacy-no-report"
    },
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "pending",
      reason: "episode-in-progress"
    },
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "unavailable",
      reason: "player-report-not-authored"
    },
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "not-applicable",
      reason: "non-reflective-policy"
    },
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "partial",
      reason: "checkpoint-only",
      source: {
        authorRole: "player",
        policyId: "smart-direct",
        policyVersion: "1",
        modelId: "autodev/smart",
        modelVersion: null
      },
      checkpoint: {
        schema: "autodev-playtest-player-checkpoint-v1",
        intention: "Inspect stage",
        predictedVisibleEffect: "Stage remains visible",
        evidence: {
          kind: "frame",
          id: "frame-visual-0",
          step: 0,
          frameIndex: 0
        }
      }
    },
    {
      schema: "autodev-playtest-player-debrief-v1",
      status: "complete",
      source: {
        authorRole: "player",
        policyId: "smart-direct",
        policyVersion: "1",
        modelId: "autodev/smart",
        modelVersion: null
      },
      focusInterpretation: {
        schema: "autodev-playtest-focus-interpretation-v1",
        requestedFocus: null,
        objective: null,
        inScope: [],
        forbiddenScope: [],
        stopCriteria: [],
        outcome: "unattempted",
        assessmentSource: "smart-direct-self-report",
        evidence: [
          { kind: "frame", id: "frame-visual-0", step: 0, frameIndex: 0 }
        ]
      },
      summary: "I inspected the stages."
    }
  ];
  for (const report of reports)
    assert.doesNotThrow(() =>
      assertPlaytestDiscoveryEvidencePacket({
        ...packet,
        playerSelfReport: report
      })
    );
  const invalidRef = {
    ...reports[4]!,
    checkpoint: {
      ...(reports[4] as { checkpoint: object }).checkpoint,
      evidence: { kind: "frame", id: "unknown", step: 9, frameIndex: 0 }
    }
  };
  assert.throws(
    () =>
      assertPlaytestDiscoveryEvidencePacket({
        ...packet,
        playerSelfReport: invalidRef
      }),
    /does not resolve/u
  );

  const omittedReport = {
    ...reports[4]!,
    checkpoint: {
      ...(reports[4] as { checkpoint: object }).checkpoint,
      evidence: { kind: "frame", id: "receipt-frame", step: 1, frameIndex: 0 }
    }
  };
  const omittedPacket = {
    ...packet,
    playerSelfReport: omittedReport,
    omittedFrames: [
      ...packet.omittedFrames,
      { frameId: "receipt-frame", step: 1, reason: "missing" as const }
    ]
  };
  assert.doesNotThrow(() =>
    assertPlaytestDiscoveryEvidencePacket(omittedPacket)
  );
  assert.throws(
    () =>
      assertPlaytestEvidenceLocatorsWithinPacket(
        [{ kind: "frame", id: "receipt-frame", step: 1, frameIndex: 0 }],
        omittedPacket
      ),
    /frame locator is absent/u
  );
});

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

test("the packet carries a step's visible evidence once, so a real session fits its budget", () => {
  // A real game's visible state is large: one step carries every visible
  // control and its name. The packet carries that state once per step, so a
  // session of a real game fits the analyst's budget.
  const marker = (step: number, index: number) =>
    "Racer " + String(step) + "-" + String(index) + " - Position 1 - Lap 1";
  const bulky = (step: number, frameId: string) => ({
    ...stepEvidence(step, frameId),
    visibleObservation: visibleState(
      step,
      Array.from({ length: 20 }, (_, index) => ({
        controlId: "control-" + String(step) + "-" + String(index),
        role: "button",
        name: (
          marker(step, index) +
          ", 99% of the lap - Delta gap unavailable before race start - " +
          "mechanically healthy - Tire age 0 laps"
        ).slice(0, PLAYTESTS_DISCOVERY_CONTROL_NAME_MAX_LENGTH),
        enabled: true
      }))
    )
  });
  const packet = buildPacket({
    tokenBudget: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MAX_TOKENS,
    stepEvidence: [bulky(0, "frame-visual-0"), bulky(1, "frame-visual-1")]
  });
  assertPlaytestDiscoveryEvidencePacket(packet);
  const window = packet.selectedWindows[0];
  assert.ok(window);
  // The window says which steps it covers and which frames they captured;
  // the visible state itself is carried once, in the step evidence.
  assert.deepEqual(
    window.steps.map((step) => step.step),
    [0, 1]
  );
  assert.ok(
    window.steps.every((step) => !("visibleObservation" in step)),
    "the window does not repeat the step's visible observation"
  );
  assert.equal(
    canonicalPlaytestJson(packet).split(marker(1, 7)).length - 1,
    1,
    "the visible state of a step is in the packet exactly once"
  );
});

test("the packet refuses a visible state outside its bounded contract", () => {
  const tooLong = "n".repeat(PLAYTESTS_DISCOVERY_CONTROL_NAME_MAX_LENGTH + 1);
  const base = stepEvidence(0, "frame-visual-0");
  const withControls = (
    controls: readonly PlaytestDiscoveryVisibleControl[]
  ) => ({
    ...base,
    visibleObservation: {
      ...base.visibleObservation,
      controls
    }
  });
  const second = stepEvidence(1, "frame-visual-1");
  // A name longer than the contract allows.
  assert.throws(
    () =>
      buildPacket({
        stepEvidence: [
          withControls([
            {
              controlId: "control-1",
              role: "button",
              name: tooLong,
              enabled: true
            }
          ]),
          second
        ]
      }),
    /visible (state|control) is malformed or outside its bounded contract/u
  );
  // More controls than the contract allows.
  assert.throws(
    () =>
      buildPacket({
        stepEvidence: [
          withControls(
            Array.from(
              { length: PLAYTESTS_DISCOVERY_MAX_CONTROLS_PER_STEP + 1 },
              (_, index) => ({
                controlId: "control-" + String(index),
                role: "button",
                name: "Stage",
                enabled: true
              })
            )
          ),
          second
        ]
      }),
    /visible (state|control) is malformed or outside its bounded contract/u
  );
  // A visible state that does not account for every observed control.
  assert.throws(
    () =>
      buildPacket({
        stepEvidence: [
          {
            ...base,
            visibleObservation: {
              ...base.visibleObservation,
              observedControlCount: 7
            }
          },
          second
        ]
      }),
    /does not account for every observed control/u
  );
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
    alternativeExplanations: [
      {
        hypothesisId: "alt-1",
        status: "hypothesis" as const,
        text: "The stage label may refer only to preview selection.",
        evidenceRefs: [{ kind: "episode" as const, id: EPISODE_ID }]
      }
    ],
    experiments: [
      {
        hypothesis: "Check whether the selected stage starts a race.",
        falsifier: "The same control leaves the setup screen unchanged.",
        controls: ["Stage 1"],
        budget: "One visual decision.",
        evidenceRefs: [
          { kind: "replay-segment" as const, id: "trace-visual-1" }
        ]
      }
    ],
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
      assertPlaytestDiscoveryReviewGroundedInPacket(
        {
          ...draft,
          alternativeExplanations: [
            {
              ...draft.alternativeExplanations[0]!,
              evidenceRefs: [{ kind: "episode", id: "not-in-packet" }]
            }
          ]
        },
        packet
      ),
    /episode locator points outside/u
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

function nullFocusManifest(): PlaytestVisualAssignmentManifest {
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
    areasOfFocus: null,
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

test("discovery packet propagates operator-requested focus from the frozen manifest and refuses to treat it as evidence", () => {
  const packet = buildPacket();
  assert.equal(
    packet.areasOfFocus,
    "Explore the race setup screen.",
    "Discovery packet must copy areasOfFocus verbatim from the frozen manifest."
  );
  assert.equal(
    packet.areasOfFocus !== null,
    true,
    "areasOfFocus must remain a non-null operator prompt when the manifest declares one."
  );
  assert.equal(
    "rubricHash" in packet,
    false,
    "areasOfFocus must not be reinterpreted as scored/confirmatory evidence."
  );
});

test("discovery packet keeps areasOfFocus as null when the frozen manifest declares null", () => {
  const manifest = nullFocusManifest();
  const packet = buildPacket({
    visualBatch: {
      batchId: manifest.batchId,
      workspaceId: manifest.workspaceId,
      assignmentManifest: manifest
    }
  });
  assertPlaytestDiscoveryEvidencePacket(packet);
  assert.equal(
    packet.areasOfFocus,
    null,
    "A null operator focus must travel as null, not as an empty string."
  );
});

test("discovery packet content-hash identity covers areasOfFocus so tamper changes the hash", () => {
  const packet = buildPacket();
  const originalFocus = packet.areasOfFocus;
  const hashInput = (value: PlaytestDiscoveryEvidencePacket) =>
    createHash("sha256")
      .update(playtestDiscoveryEvidencePacketHashInput(value))
      .digest("hex");
  assert.equal(
    packet.packetHash,
    hashInput(packet),
    "Recorded packetHash must match the canonical hash of the packet value."
  );
  const tamperedFocus: PlaytestDiscoveryEvidencePacket = {
    ...packet,
    areasOfFocus: "Switch to a different operator focus."
  };
  const tamperedNull: PlaytestDiscoveryEvidencePacket = {
    ...packet,
    areasOfFocus: null
  };
  assert.notEqual(
    hashInput(packet),
    hashInput(tamperedFocus),
    "Changing areasOfFocus must invalidate the content hash."
  );
  assert.notEqual(
    hashInput(packet),
    hashInput(tamperedNull),
    "Nulling areasOfFocus must invalidate the content hash."
  );
  assert.equal(
    originalFocus,
    "Explore the race setup screen.",
    "Tampering comparison must not mutate the source packet."
  );
});

test("discovery packet rejects an areasOfFocus outside the bounded focus contract", () => {
  const packet = buildPacket();
  const oversized: PlaytestDiscoveryEvidencePacket = {
    ...packet,
    areasOfFocus: "x".repeat(2001)
  };
  assert.throws(
    () => assertPlaytestDiscoveryEvidencePacket(oversized),
    /areasOfFocus is outside its bounded focus contract/u
  );
  const blank: PlaytestDiscoveryEvidencePacket = {
    ...packet,
    areasOfFocus: ""
  };
  assert.throws(
    () => assertPlaytestDiscoveryEvidencePacket(blank),
    /areasOfFocus is outside its bounded focus contract/u
  );
});
