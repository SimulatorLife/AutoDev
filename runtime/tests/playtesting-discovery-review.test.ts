import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPlaytestDiscoverySessionReview,
  type PlaytestArtifactReference,
  type PlaytestDiscoveryEvidencePacket,
  type PlaytestDiscoverySessionReview,
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
  playtestAssignmentManifestHashInput,
  type PlaytestEpisode,
  type PlaytestVisualBatch
} from "@simulatorlife/autodev-core";
import type { WorkspaceCatalogRead } from "@simulatorlife/autodev-data";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestMcpServer,
  createPlaytestRunControl,
  type PlaytestingRepositoryOps,
  type PlaytestRunOwner
} from "../src/playtesting/mcp.ts";
import type {
  PlaytestAnalystProcess,
  PlaytestAnalystProcessInput,
  PlaytestAnalystProcessResult
} from "../src/playtesting/analyst-process.ts";

const WORKSPACE = "SimulatorLife/RacingGame";
const BATCH_ID = "batch-0123456789abcdef-rest";
const ASSIGNMENT_ID = "vis-assign-1";
const EPISODE_ID = "ep-0123456789abcdef-vis-assign-1";
const NOW = "2026-10-17T12:00:00.000Z";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr0sAAAAASUVORK5CYII=",
  "base64"
);

function manifest() {
  const draft = {
    schema: PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: "autonomous-visual" as const,
    batchId: BATCH_ID,
    workspaceId: WORKSPACE,
    targetId: "racing-game-local",
    targetApprovalId: "approval-racing-1",
    targetRevision: 1,
    targetOrigin: "http://127.0.0.1:5173",
    policyId: "smart-direct" as const,
    policyVersion: "1",
    cohortId: null,
    areasOfFocus: "Inspect race setup choices.",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 2,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 2,
      smartTokensPerEpisode: 2000,
      screenshotCountPerEpisode: 2,
      artifactBytesPerEpisode: 1024 * 1024
    },
    createdAt: NOW,
    assignments: [{ assignmentId: ASSIGNMENT_ID, ordinal: 0, maxSteps: 2 }]
  };
  return {
    ...draft,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(draft))
      .digest("hex")
  };
}

function visualBatch(): PlaytestVisualBatch {
  const frozenManifest = manifest();
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId: BATCH_ID,
    revision: 2,
    workspaceId: WORKSPACE,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    policyIds: ["smart-direct"],
    cohortIds: [],
    scenarioIds: [],
    unobservedAssignments: null,
    reviewPackets: [],
    reviewReceipts: [],
    status: "truncated",
    cancellationReason: null,
    failureReason: null,
    counts: {
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
    budget: {
      assignedEpisodes: 1,
      maxStepsPerEpisode: 2,
      wallTimeMs: 60_000,
      critiqueBudget: 0,
      actualCritiques: 0
    },
    startedAt: NOW,
    completedAt: "2026-10-17T12:00:10.000Z",
    createdAt: NOW,
    provenance: {
      workspaceId: WORKSPACE,
      buildSha: null,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt: NOW
    },
    evaluationIds: [],
    spanIds: [],
    executionMode: "autonomous-visual",
    repository: null,
    buildSha: null,
    gameBuild: null,
    configHash: null,
    rubricHash: null,
    actionSchemaHash: null,
    observationSchemaHash: null,
    eventSchemaHash: null,
    protocolVersion: null,
    assignmentInventory: {
      status: "frozen-visual",
      manifest: frozenManifest
    },
    coverageManifest: null,
    reviewSelection: {
      status: "unavailable",
      reason: "visual-discovery-session-level"
    }
  };
}

function visualEpisode(traceId: string, frameId: string): PlaytestEpisode {
  return {
    schema: PLAYTESTS_EPISODE_SCHEMA,
    episodeId: EPISODE_ID,
    revision: 5,
    batchId: BATCH_ID,
    assignmentId: ASSIGNMENT_ID,
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
        targetId: "racing-game-local",
        targetOrigin: "http://127.0.0.1:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    identity: {
      workspaceId: WORKSPACE,
      repository: null,
      buildSha: null,
      gameBuild: null,
      scenarioId: null,
      configHash: null,
      seed: null,
      protocolVersion: null,
      policyId: "smart-direct",
      policyVersion: "1",
      modelId: "autodev/smart",
      modelRevision: null,
      observationSchemaHash: "a".repeat(64),
      actionSchemaHash: "b".repeat(64),
      eventSchemaHash: "c".repeat(64),
      runtimeVersion: "runtime-test",
      environmentHash: "d".repeat(64),
      rngAlgorithm: null,
      rngVersion: null,
      rngInitialStateHash: null
    },
    scenarioFamily: null,
    policyCohort: null,
    strategy: "smart-direct-visual",
    status: "budget-truncated",
    termination: { reason: "step-limit", step: 1 },
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
    trace: { kind: "replay-segment", id: traceId },
    frames: [{ kind: "frame", id: frameId, step: 0, frameIndex: 0 }],
    stepCount: 1,
    metrics: [],
    findingIds: [],
    assignedAt: NOW,
    startedAt: NOW,
    completedAt: "2026-10-17T12:00:10.000Z",
    simulationWallMs: 10_000,
    logicalTicks: null,
    policyInferenceMs: 1500,
    nativeDurationMs: null,
    completeness: "partial",
    missingReasons: ["budget-truncated"]
  };
}

function catalog(): WorkspaceCatalogRead {
  return {
    status: "valid",
    workspaces: [
      {
        id: WORKSPACE,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      }
    ]
  } as WorkspaceCatalogRead;
}

function mcpResult(result: {
  readonly content?: readonly { readonly text?: string }[];
  readonly isError?: boolean;
}): unknown {
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

test("visual discovery dispatch prepares one packet and stores only hypothesis review", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "playtest-discovery-review-"));
  const artifacts = new PlaytestArtifactStore({
    rootDirectory: root,
    workspaceId: WORKSPACE
  });
  const frameRef = artifacts.writeArtifact({
    artifactId: "frame-racing-0",
    mediaType: "image/png",
    bytes: PNG
  }).reference;
  const trace = artifacts.writeWindow({
    artifactId: "trace-racing-0",
    entries: [
      {
        step: 0,
        phaseId: "race-setup",
        revisionBefore: 0,
        revisionAfter: 1,
        observationVisibility: "visual-only",
        visibleObservation: {
          capturedAt: NOW,
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
          privacyState: "clear",
          controls: [
            {
              controlId: "btn-stage",
              role: "button",
              name: "Stage 1",
              bounds: { x: 20, y: 20, width: 120, height: 40 },
              enabled: true,
              focused: false
            }
          ],
          warnings: [],
          phase: "race-setup",
          progress: null
        },
        legalActionIds: ["btn-stage"],
        selectedActionId: "btn-stage",
        preActionPrediction: {
          intention: "Inspect the visible stage choice.",
          predictedVisibleEffect: "The stage choice remains visible.",
          reasonCode: "explore"
        },
        authoritativeOutcome: {
          status: "dispatched",
          actionKind: "activate-control",
          observationId: "obs-racing-0",
          actionDetail: { controlId: "btn-stage" },
          dispatchedAt: "2026-10-17T12:00:02.000Z",
          receiptAt: "2026-10-17T12:00:02.001Z",
          refusalReason: null
        },
        events: [],
        frameRefs: [
          {
            kind: "frame",
            id: frameRef.artifactId,
            step: 0,
            frameIndex: 0
          }
        ]
      }
    ]
  }).reference;
  const episode = visualEpisode(trace.artifactId, frameRef.artifactId);
  const batch = visualBatch();
  let latestDiscoveryReview: unknown = null;
  let insertedDiscoveryReviewCount = 0;
  const repository = {
    getBatch: async () => batch,
    getEpisode: async () => episode,
    getLatestDiscoveryReviewForEpisode: async () =>
      latestDiscoveryReview as never,
    insertDiscoveryReview: async (record: unknown) => {
      insertedDiscoveryReviewCount += 1;
      latestDiscoveryReview = record;
    },
    insertReview: async () => {},
    getLatestReviewForEpisode: async () => null,
    getLatestReview: async () => null,
    listEpisodes: async () => ({
      rows: [episode],
      total: 1,
      nextCursor: null
    }),
    listCrossSessionSyntheses: async () => ({
      rows: [],
      total: 0,
      nextCursor: null
    }),
    getCrossSessionSynthesisForAnalysis: async () => null
  } as unknown as PlaytestingRepositoryOps;
  const analystInputs: PlaytestAnalystProcessInput[] = [];
  const finishProcess: ((result: PlaytestAnalystProcessResult) => void)[] = [];
  const runControl = createPlaytestRunControl({
    artifactStoreForWorkspace: () => artifacts,
    playtestRepository: repository,
    readWorkspaceCatalog: catalog,
    launchAnalystProcess: (input) => {
      analystInputs.push(input);
      return {
        completion: new Promise((resolve) => {
          finishProcess.push(resolve);
        }),
        terminate() {}
      } satisfies PlaytestAnalystProcess;
    }
  });

  try {
    const operatorSession = {
      workspaceId: WORKSPACE,
      role: "operator",
      actor: "operator-1"
    };
    const dispatch = await runControl.dispatchCrossSessionReview(
      operatorSession,
      WORKSPACE,
      [episode.episodeId]
    );
    const dispatchedRun = dispatch.run;
    assert.ok(dispatchedRun);
    assert.equal(dispatchedRun.analysisKind, "discovery");
    const analystInput = analystInputs[0]!;
    assert.equal(analystInput.analysisKind, "discovery");
    assert.equal(analystInput.metricAggregation, null);
    assert.equal(dispatch.packets.length, 1);
    const dispatchedPacket = dispatch.packets[0]!;
    assert.equal("analysisKind" in dispatchedPacket.packet, true);
    assert.equal(
      dispatch.packets[0]?.artifact.mediaType,
      PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE
    );

    const analystSession = {
      workspaceId: WORKSPACE,
      role: "playtest-analyst",
      actor: "analyst-1",
      taskId: "analysis-task",
      runId: "analysis-run",
      analysisId: dispatchedRun.analysisId,
      analysisKind: "discovery" as const,
      selectedEpisodeIds: [episode.episodeId]
    };
    const mcp = createPlaytestMcpServer({
      sessionProvider: { current: () => analystSession },
      playtestRepository: repository,
      playtestRunControl: null,
      artifactStoreForWorkspace: () => artifacts,
      readWorkspaceCatalog: catalog
    });
    const prepare = await (mcp as any)._registeredTools[
      "playtest.prepareReview"
    ].handler({ episodeId: episode.episodeId });
    const prepared = mcpResult(prepare) as {
      readonly analysisKind: string;
      readonly packet: PlaytestDiscoveryEvidencePacket;
      readonly packetArtifact: PlaytestArtifactReference;
    };
    assert.equal(prepared.analysisKind, "discovery");
    assert.equal(prepared.packet.packetId, dispatchedPacket.packet.packetId);
    assert.equal(
      prepared.packetArtifact.sha256,
      dispatchedPacket.artifact.sha256
    );
    assert.equal(prepared.packet.frames[0]?.frameId, frameRef.artifactId);

    const submission = {
      episodeId: episode.episodeId,
      packetId: prepared.packet.packetId,
      packetArtifactId: prepared.packetArtifact.artifactId,
      packetSha256: prepared.packetArtifact.sha256,
      chronologicalSummary:
        "The visible race setup displayed a stage selection that remained on screen.",
      observations: [
        {
          hypothesisId: "obs-1",
          status: "hypothesis",
          text: "The race setup displayed a selectable Stage 1 button.",
          evidenceRefs: [
            {
              kind: "frame",
              id: frameRef.artifactId,
              step: 0,
              frameIndex: 0
            }
          ]
        }
      ],
      interpretations: [
        {
          hypothesisId: "int-1",
          status: "not-observed",
          text: "The selected stage did not visibly advance to the race.",
          evidenceRefs: [
            {
              kind: "frame",
              id: frameRef.artifactId,
              step: 0,
              frameIndex: 0
            }
          ]
        }
      ],
      alternativeExplanations: [],
      experiments: []
    };
    const submit = await (mcp as any)._registeredTools[
      "playtest.submitDiscoveryReview"
    ].handler(submission);
    assert.equal(submit.isError, undefined);
    const review = mcpResult(submit) as PlaytestDiscoverySessionReview;
    assertPlaytestDiscoverySessionReview(review);
    assert.equal(review.status, "hypothesis");
    assert.equal(review.evidencePacket.packetId, prepared.packet.packetId);
    assert.equal(review.workspaceId, WORKSPACE);
    assert.equal(insertedDiscoveryReviewCount, 1);

    const duplicate = await (mcp as any)._registeredTools[
      "playtest.submitDiscoveryReview"
    ].handler(submission);
    assert.equal(duplicate.isError, undefined);
    assert.equal(
      (mcpResult(duplicate) as { readonly reviewId: string }).reviewId,
      review.reviewId
    );
    assert.equal(insertedDiscoveryReviewCount, 1);

    const strictSchema = (mcp as any)._registeredTools[
      "playtest.submitDiscoveryReview"
    ].inputSchema;
    assert.equal(
      (await strictSchema.safeParseAsync({ ...submission, score: 9 })).success,
      false
    );
    const submittedObservation = submission.observations[0]!;
    const submittedInterpretation = submission.interpretations[0]!;
    const scoredSubmission = await (mcp as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
      workspaceId: WORKSPACE,
      episodeId: episode.episodeId,
      packetId: prepared.packet.packetId,
      packetArtifactId: prepared.packetArtifact.artifactId,
      packetSha256: prepared.packetArtifact.sha256,
      chronologicalSummary: "This visual session has evidence.",
      status: "hypothesis",
      evidenceRefs: submittedObservation.evidenceRefs,
      observations: [
        {
          text: submittedObservation.text,
          evidenceRefs: submittedObservation.evidenceRefs
        }
      ],
      interpretations: [
        {
          text: submittedInterpretation.text,
          evidenceRefs: submittedInterpretation.evidenceRefs
        }
      ],
      dimensionEvidence: [],
      alternativeExplanations: [],
      reportCompleteness: {
        crossSessionContext: {
          status: "unavailable",
          reason: "No sibling session was supplied."
        },
        alternatives: {
          status: "none-identified",
          reason: "No alternative was found in this single-frame packet."
        },
        experiments: {
          status: "none-recommended",
          reason: "No confirmatory metric was authorized."
        },
        followUp: { status: "none", reason: "No further action is needed." }
      },
      experiments: [],
      findings: [],
      rubricHash: "fabricated"
    });
    assert.equal(scoredSubmission.isError, true);
    finishProcess[0]?.({
      exitCode: 0,
      signal: null,
      timedOut: false,
      launchFailed: false
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = await runControl.listAnalystReviewRuns(
      operatorSession,
      WORKSPACE
    );
    assert.equal(status.runs[0]?.status, "completed");
    assert.equal(status.runs[0]?.reviews[0]?.reviewId, review.reviewId);
  } finally {
    await runControl.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
