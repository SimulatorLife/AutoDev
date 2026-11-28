import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_PLAYTESTING_ANALYSES_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_ANALYSIS_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_CAPABILITIES_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_COMPARISON_DECISION_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_DETAIL_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_HUMAN_CONSENT_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_HUMAN_IMPORT_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_HUMAN_QUARANTINES_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_HUMAN_STUDY_REGISTRATION_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_HUMAN_VALIDATION_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_HUMAN_WITHDRAWAL_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_PAGE_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
  CONTROL_API_PLAYTESTING_REVIEWS_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUN_CANCELLATION_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUN_REQUEST_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUN_STARTED_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUN_STATUS_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_RUNS_SCHEMA_ID,
  CONTROL_API_PLAYTESTING_WINDOW_SCHEMA_ID,
  controlApiPlaytestingActiveRunsResponseSchema,
  controlApiPlaytestingAnalysesResponseSchema,
  controlApiPlaytestingAnalysisDispatchResponseSchema,
  controlApiPlaytestingCapabilitiesPreflightSchema,
  controlApiPlaytestingCapabilitiesResponseSchema,
  controlApiPlaytestingComparisonDecisionRequestSchema,
  controlApiPlaytestingComparisonDecisionResponseSchema,
  controlApiPlaytestingEpisodeDetailResponseSchema,
  controlApiPlaytestingHumanConsentResponseSchema,
  controlApiPlaytestingHumanImportResponseSchema,
  controlApiPlaytestingHumanQuarantinesResponseSchema,
  controlApiPlaytestingHumanStudyRegistrationResponseSchema,
  controlApiPlaytestingHumanValidationResponseSchema,
  controlApiPlaytestingHumanWithdrawalResponseSchema,
  controlApiPlaytestingPageResponseSchema,
  controlApiPlaytestingReadinessResponseSchema,
  controlApiPlaytestingReviewsResponseSchema,
  controlApiPlaytestingRunCancellationResponseSchema,
  controlApiPlaytestingRunRequestLookupResponseSchema,
  controlApiPlaytestingRunStartedResponseSchema,
  controlApiPlaytestingRunStatusResponseSchema,
  controlApiPlaytestingWindowResponseSchema
} from "../src/control-api/playtesting.ts";
import { PLAYTESTS_EPISODE_SCHEMA } from "../src/playtesting/types.ts";

test("playtesting preflight contracts validate readiness and visual mode capabilities", () => {
  assert.equal(
    controlApiPlaytestingReadinessResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
      workspaceId: "owner/repo",
      status: "ready"
    }).success,
    true
  );
  assert.equal(
    controlApiPlaytestingReadinessResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
      workspaceId: "owner/repo",
      status: "starting"
    }).success,
    false
  );
  assert.equal(
    controlApiPlaytestingCapabilitiesPreflightSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_CAPABILITIES_SCHEMA_ID,
      workspaceId: "owner/repo",
      modeReadiness: {
        "adapter-accelerated": { status: "ready", reasons: [] },
        "autonomous-visual": {
          status: "check-required",
          reasons: [],
          targetStore: "available",
          targets: [{ target: {}, eligibility: "supported", reasons: [] }]
        },
        "scripted-regression": { status: "unavailable", reasons: [] }
      }
    }).success,
    true
  );
});

test("playtesting run control contracts validate launch, lookup, status, active runs, and cancellation", () => {
  assert.equal(
    controlApiPlaytestingRunStartedResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_RUN_STARTED_SCHEMA_ID,
      workspaceId: "owner/game",
      batchId: "batch-1",
      assignmentCount: 1,
      assignmentIds: ["a-1"],
      sessions: [{ assignmentId: "a-1", episodeId: "ep-1" }],
      createdAt: "2026-10-16T12:00:00.000Z",
      status: "running"
    }).success,
    true
  );
  assert.equal(
    controlApiPlaytestingRunStartedResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_RUN_STARTED_SCHEMA_ID,
      workspaceId: "owner/game",
      batchId: "batch-1",
      assignmentCount: 2,
      assignmentIds: ["a-1", "a-2"],
      sessions: [{ assignmentId: "a-1", episodeId: "ep-1" }],
      createdAt: "2026-10-16T12:00:00.000Z",
      status: "running"
    }).success,
    false
  );

  assert.equal(
    controlApiPlaytestingRunRequestLookupResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_RUN_REQUEST_SCHEMA_ID,
      workspaceId: "owner/game",
      requestId: "req-1",
      state: "not-found",
      batchId: null,
      assignmentCount: null,
      assignmentIds: [],
      sessions: [],
      createdAt: null,
      status: null
    }).success,
    true
  );
  assert.equal(
    controlApiPlaytestingRunRequestLookupResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_RUN_REQUEST_SCHEMA_ID,
      workspaceId: "owner/game",
      requestId: "req-1",
      state: "accepted",
      batchId: "batch-1",
      assignmentCount: 1,
      assignmentIds: ["a-1"],
      sessions: [{ assignmentId: "a-1", episodeId: "ep-1" }],
      createdAt: "2026-10-16T12:00:00.000Z",
      status: "completed"
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingActiveRunsResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_RUNS_SCHEMA_ID,
      workspaceId: "owner/game",
      runs: [
        {
          batchId: "batch-1",
          assignmentCount: 1,
          createdAt: "2026-10-16T12:00:00.000Z",
          sessions: [{ assignmentId: "a-1", episodeId: "ep-1" }],
          status: {
            batchId: "batch-1",
            status: "running",
            cancellationReason: null,
            result: null,
            error: null
          }
        }
      ]
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingRunStatusResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_RUN_STATUS_SCHEMA_ID,
      workspaceId: "owner/game",
      run: {
        batchId: "batch-1",
        status: "running",
        cancellationReason: null,
        result: null,
        error: null
      }
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingRunCancellationResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_RUN_CANCELLATION_SCHEMA_ID,
      workspaceId: "owner/game",
      batchId: "batch-1",
      cancellationRequested: true
    }).success,
    true
  );
});

test("playtesting capabilities, analysis, review, page, episode detail, and human-study contracts enforce invariants", () => {
  assert.equal(
    controlApiPlaytestingCapabilitiesResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_CAPABILITIES_SCHEMA_ID,
      workspaceId: "owner/game",
      capabilityRevision: "a".repeat(64),
      workspaceCatalog: "valid",
      workspaceEnabled: true,
      operatorActionsAvailable: true,
      modeReadiness: {
        "adapter-accelerated": { status: "ready", reasons: [] },
        "autonomous-visual": {
          status: "unavailable",
          reasons: [
            {
              code: "driver-unavailable",
              label: "Driver unavailable",
              message: "No driver running.",
              severity: "unavailable"
            }
          ],
          targetStore: "unavailable",
          targets: [],
          policies: [{ policyId: "smart-direct", status: "ready", reasons: [] }]
        },
        "scripted-regression": { status: "ready", reasons: [] }
      },
      approved: false,
      approvalRevision: null,
      buildSha: null,
      gameBuild: null,
      allowedScenarios: [],
      approvedPolicies: [],
      supportedPolicies: ["random"],
      runnablePolicies: [],
      unsupportedApprovedPolicies: [],
      configurationStatus: "not-checked",
      maxBatchAssignments: 0,
      runnableAssignments: [],
      admissibleSeeds: null,
      policyProfiles: [],
      limits: null,
      issueReporting: "disabled",
      configuredIssueReporting: "disabled",
      humanStudyAllowed: false,
      revokedAt: null,
      runPreflight: "required-at-start"
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingAnalysisDispatchResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_ANALYSIS_SCHEMA_ID,
      operation: "dispatch",
      workspaceId: "owner/game",
      requested: 1,
      packets: [{ episodeId: "ep-1", batchId: "b-1", packetId: "p-1" }],
      receipts: [],
      budget: [],
      analysis: {
        analysisId: "analysis-1",
        workspaceId: "owner/game",
        status: "running",
        createdAt: "2026-10-16T12:00:00.000Z",
        finishedAt: null,
        requestedEpisodeIds: ["ep-1"],
        packets: [{ episodeId: "ep-1", batchId: "b-1", packetId: "p-1" }],
        receipts: [],
        budget: [],
        reviews: [],
        synthesisId: null,
        error: null
      }
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingAnalysesResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_ANALYSES_SCHEMA_ID,
      workspaceId: "owner/game",
      runs: [],
      syntheses: []
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingReviewsResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_REVIEWS_SCHEMA_ID,
      workspaceId: "owner/game",
      total: 0,
      rows: [],
      nextCursor: null
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingComparisonDecisionRequestSchema.safeParse({
      workspaceId: "owner/game",
      comparisonId: "comparison-1",
      expectedVersion: 1,
      disposition: "hold",
      reason: "Hold build."
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingComparisonDecisionResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_COMPARISON_DECISION_SCHEMA_ID,
      workspaceId: "owner/game",
      comparison: {
        comparisonId: "comparison-1",
        version: 2,
        ownerDisposition: "hold",
        ownerDecisionReason: "Hold build.",
        ownerDecisionBy: "console-operator"
      }
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingHumanValidationResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_HUMAN_VALIDATION_SCHEMA_ID,
      workspaceId: "owner/game",
      studyId: "study-1",
      buildSha: "a".repeat(40),
      preference: null,
      summary: {
        revision: 1,
        benchmarkId: null,
        instrument: "miniPXI",
        measurementVersion: "v2",
        suppressionState: "suppressed",
        retainedParticipants: null,
        items: [
          {
            itemId: "ENJ",
            suppressionState: "suppressed",
            mean: null,
            respondentCount: null,
            missingCount: null,
            categoryCounts: null,
            unit: "native",
            participantId: "must-reject"
          }
        ],
        constructs: [],
        pairedDifferences: []
      }
    }).success,
    false
  );

  assert.equal(
    controlApiPlaytestingHumanImportResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_HUMAN_IMPORT_SCHEMA_ID,
      workspaceId: "owner/game",
      studyId: "study-1",
      revision: 1,
      acceptedCount: 1,
      unchangedCount: 0,
      rejectedCount: 0,
      rejectedByReason: {},
      quarantinedCount: 0,
      retainedParticipants: 1
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingHumanConsentResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_HUMAN_CONSENT_SCHEMA_ID,
      workspaceId: "owner/game",
      studyId: "study-1",
      recorded: true
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingHumanWithdrawalResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_HUMAN_WITHDRAWAL_SCHEMA_ID,
      workspaceId: "owner/game",
      studyId: "study-1",
      revision: 2,
      retainedParticipants: 0
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingHumanQuarantinesResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_HUMAN_QUARANTINES_SCHEMA_ID,
      workspaceId: "owner/game",
      studyId: "study-1",
      quarantines: [],
      preferenceQuarantines: []
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingHumanStudyRegistrationResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_HUMAN_STUDY_REGISTRATION_SCHEMA_ID,
      workspaceId: "owner/game",
      studyId: "study-1",
      benchmarkId: "bench-1",
      approved: true,
      idempotent: false
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingPageResponseSchema("findings").safeParse({
      schema: CONTROL_API_PLAYTESTING_PAGE_SCHEMA_ID,
      workspaceId: "owner/game",
      resource: "findings",
      readOnly: true,
      page: { rows: [], total: 0, nextCursor: null }
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingEpisodeDetailResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_DETAIL_SCHEMA_ID,
      workspaceId: "owner/game",
      resource: "episode",
      readOnly: true,
      record: {
        schema: PLAYTESTS_EPISODE_SCHEMA,
        episodeId: "ep-1",
        revision: 1,
        batchId: "batch-1",
        executionProvenance: {
          mode: "adapter-accelerated",
          source: {
            kind: "repo-checkout",
            repository: "owner/game",
            revision: "a".repeat(40),
            revisionConfidence: "verified",
            checkoutState: "clean",
            artifactFingerprint: null,
            targetId: null,
            targetOrigin: null
          },
          observationSource: "engine-adapter",
          actionSource: "engine-policy",
          derivedFrom: null
        },
        identity: { workspaceId: "owner/game" },
        termination: { reason: "unknown", step: null },
        stepCount: 0,
        metrics: [],
        frames: []
      },
      latestReview: null,
      latestDiscoveryReview: null,
      visualAssignment: null
    }).success,
    true
  );

  assert.equal(
    controlApiPlaytestingWindowResponseSchema.safeParse({
      schema: CONTROL_API_PLAYTESTING_WINDOW_SCHEMA_ID,
      workspaceId: "owner/game",
      episodeId: "ep-1",
      artifactId: "trace-1",
      sha256: "a".repeat(64),
      mediaType: "application/x-ndjson",
      startStep: 0,
      endStep: 10,
      sourceLineCount: 2,
      omittedLineCount: 0,
      entries: [{ step: 0 }]
    }).success,
    true
  );
});
