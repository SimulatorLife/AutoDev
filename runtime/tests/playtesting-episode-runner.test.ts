import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";
import test from "node:test";

import {
  assertPlaytestFindingEvidenceStatusConsistent,
  assertPlaytestSessionReviewHasEvidence,
  buildPlaytestComparison,
  classifyPlaytestMetricComparison,
  type PlaytestCapabilityAdvertisement,
  type PlaytestComparison,
  type PlaytestEpisode,
  type PlaytestFinding,
  type PlaytestFixLineage,
  type PlaytestKnownEvidenceIndex,
  type PlaytestNumericResult,
  type PlaytestObservationContract,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  type PlaytestSessionReview,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";

import type {
  PlaytestAdapterExit,
  PlaytestAdapterStreams
} from "../src/playtesting/adapter-client.ts";
import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import type {
  PlaytestSandboxHandle,
  PlaytestSandboxResult
} from "../src/playtesting/docker-sandbox.ts";
import { runPlaytestEpisode } from "../src/playtesting/episode-runner.ts";
import { createScoredPlaytestPolicy } from "../src/playtesting/policies.ts";

const WORKSPACE_ID = "owner/game";
const GAME_BUILD = "fixture-game-build-1";
const ENVIRONMENT_HASH = "d".repeat(64);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function capabilities(
  engineBuild = GAME_BUILD
): PlaytestCapabilityAdvertisement {
  const observationSchema = {
    type: "object",
    additionalProperties: false,
    properties: { room: { type: "string" }, secret: { type: "string" } },
    required: ["room", "secret"]
  };
  const actionSchema = {
    type: "object",
    additionalProperties: false,
    properties: { actionId: { type: "string" } },
    required: ["actionId"]
  };
  const eventSchema = {
    type: "object",
    additionalProperties: false,
    properties: { type: { type: "string" } },
    required: ["type"]
  };
  return {
    protocolVersion: 1,
    schemaHashAlgorithm: "sha256-canonical-json-v1",
    engineBuild,
    modes: ["headless"],
    scenarioIds: ["tutorial"],
    observationSchema,
    actionSchema,
    eventSchema,
    observationSchemaHash: hash(observationSchema),
    actionSchemaHash: hash(actionSchema),
    eventSchemaHash: hash(eventSchema),
    optionalOperations: [],
    quotas: {
      maxMessageBytes: 65_536,
      maxQueuedRequests: 8,
      ordinaryCallTimeoutMs: 2000,
      resetReplayTimeoutMs: 5000
    },
    deterministic: {
      seededRuns: true,
      rngVersion: "fixture-rng-v1",
      traceReplayable: true
    }
  };
}

function observationContract(): PlaytestObservationContract {
  return {
    schemaVersion: 1,
    schemaHash: capabilities().observationSchemaHash,
    mode: "headless",
    cohort: "novice",
    visibilityMode: "structured",
    fields: [
      {
        fieldPath: "room",
        unit: null,
        displayRounding: null,
        revelationTiming: "before-action",
        playerRuleRef: "fixture-rules/room"
      }
    ],
    uiEquivalence: "unverified",
    conformanceFixtureHash: null
  };
}

function approval(
  overrides: Partial<WorkspacePlaytestApproval> = {}
): WorkspacePlaytestApproval {
  return {
    schema: "autodev-workspace-playtest-approval-v1",
    workspaceId: WORKSPACE_ID,
    revision: 1,
    approvalId: "fixture-approval",
    checkoutRoot: "/tmp/approved-fixture-game",
    buildSha: "a".repeat(40),
    gameBuild: GAME_BUILD,
    playtestConfigHash: "b".repeat(64),
    adapterImageDigest: `ghcr.io/owner/adapter@sha256:${"c".repeat(64)}`,
    workingDirectory: ".",
    adapterCommand: ["/usr/bin/node", "adapter.mjs"],
    allowedScenarios: ["tutorial"],
    allowedPolicies: ["fixture-heuristic"],
    limits: {
      cpuCores: 1,
      memoryBytes: 256 * 1024 * 1024,
      processCount: 16,
      wallTimeMs: 30_000,
      artifactBytes: 16 * 1024 * 1024,
      workerCount: 1,
      episodeCount: 1,
      maxStepsPerEpisode: 20,
      critiqueCount: 0
    },
    retentionDays: 1,
    issueReporting: "disabled",
    humanStudyAllowed: false,
    approvedAt: "2026-10-10T00:00:00.000Z",
    approvedBy: "fixture-operator",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...overrides
  };
}

interface FixtureSandbox extends PlaytestSandboxHandle {
  readonly sentMethods: string[];
  readonly closeNormally: () => void;
  readonly cancelCount: () => number;
  readonly cleanupCount: () => number;
}

function sandboxFixture(
  options: {
    readonly terminal?: boolean;
    readonly noLegalActions?: boolean;
    readonly onStepRequest?: () => void;
    readonly episodeId?: string;
    readonly eventId?: string;
    readonly engineBuild?: string;
    readonly outcome?: "loss" | "win";
  } = {}
): FixtureSandbox {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sentMethods: string[] = [];
  const exitListeners: Array<(cause: PlaytestAdapterExit) => void> = [];
  let requestBuffer = "";
  let revision = 0;
  let eventSequence = 0;
  let cancelCount = 0;
  let cleanupCount = 0;
  let resultResolve!: (value: PlaytestSandboxResult) => void;
  let resultReject!: (error: Error) => void;
  const result = new Promise<PlaytestSandboxResult>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  const handleExit = (
    code: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    stdout.end();
    stderr.end();
    for (const listener of exitListeners)
      listener({ code, signal, stderrTail: [] });
  };
  const respond = (id: string, response: unknown): void => {
    stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id, result: response }) + "\n"
    );
  };
  const notify = (method: string, params: unknown): void => {
    stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };
  const processRequest = (request: Record<string, unknown>): void => {
    const method = String(request.method);
    const id = String(request.id);
    const params = request.params as Record<string, unknown>;
    sentMethods.push(method);
    if (method === "game.capabilities") {
      respond(id, capabilities(options.engineBuild));
      return;
    }
    if (method === "game.reset") {
      revision = 0;
      eventSequence = 0;
      respond(id, {
        episodeId: options.episodeId ?? "fixture-episode-1",
        revision,
        rngProvenance: {
          algorithm: "fixture-rng",
          version: "fixture-rng-v1",
          initialStateHash: "e".repeat(64),
          reproducible: true
        }
      });
      return;
    }
    if (method === "game.observe") {
      respond(id, {
        episodeId: params.episodeId,
        revision,
        observation: { room: "hall", secret: "engine-only-value" },
        turnContext: null,
        frame: null
      });
      return;
    }
    if (method === "game.legalActions") {
      respond(id, {
        episodeId: params.episodeId,
        revision,
        actions: options.noLegalActions
          ? []
          : [
              { actionId: "advance", description: "Advance" },
              { actionId: "wait", description: "Wait" }
            ]
      });
      return;
    }
    if (method === "game.step") {
      options.onStepRequest?.();
      if (options.terminal === false) {
        revision += 1;
        respond(id, {
          episodeId: params.episodeId,
          revision,
          acceptedActionId: params.actionId,
          eventIds: [],
          terminal: false
        });
        return;
      }
      revision += 1;
      eventSequence += 1;
      notify("game.event", {
        episodeId: params.episodeId,
        revision,
        eventSequence,
        event: {
          eventId: options.eventId ?? "event-1",
          type: "choice-applied",
          phaseId: "tutorial",
          step: 1,
          revision,
          actor: "player",
          fields: { secret: "hidden-event-value", visibleFact: "advance" }
        }
      });
      respond(id, {
        episodeId: params.episodeId,
        revision,
        acceptedActionId: params.actionId,
        eventIds: [options.eventId ?? "event-1"],
        terminal: true
      });
      return;
    }
    if (method === "game.outcome") {
      respond(id, {
        episodeId: params.episodeId,
        revision,
        state: options.terminal === false ? "partial" : "terminal",
        outcome: {
          kind: options.outcome ?? "loss",
          secret: "privileged-outcome"
        },
        metrics: { score: 0 },
        missingReasons: []
      });
      return;
    }
    if (method === "game.cancel") {
      respond(id, {
        requestId: params.requestId,
        acknowledged: true,
        episodeDisposition: "unknown"
      });
    }
  };
  stdin.on("data", (chunk: Buffer) => {
    requestBuffer += chunk.toString("utf8");
    let newline = requestBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = requestBuffer.slice(0, newline);
      requestBuffer = requestBuffer.slice(newline + 1);
      if (line.length > 0)
        processRequest(JSON.parse(line) as Record<string, unknown>);
      newline = requestBuffer.indexOf("\n");
    }
  });
  stdin.on("finish", () => {
    handleExit(0, null);
    resultResolve({
      runId: "fixture-run",
      containerName: "fixture-container",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 1,
      stdoutTail: [],
      stderrTail: [],
      stagingDirectory: null,
      artifacts: []
    });
  });
  const streams: PlaytestAdapterStreams = {
    stdin: stdin as Writable,
    stdout,
    stderr,
    onExit: (listener) => exitListeners.push(listener)
  };
  return {
    runId: "fixture-run",
    containerName: "fixture-container",
    stdin: streams.stdin,
    stdout: streams.stdout,
    stderr: streams.stderr,
    streams,
    onExit: streams.onExit,
    result,
    cancel: async () => {
      cancelCount += 1;
      handleExit(null, "SIGKILL");
      resultReject(new Error("fixture sandbox cancelled"));
    },
    cleanup: async () => {
      cleanupCount += 1;
    },
    sentMethods,
    closeNormally: () => stdin.end(),
    cancelCount: () => cancelCount,
    cleanupCount: () => cleanupCount
  };
}

function policy() {
  return createScoredPlaytestPolicy({
    id: "fixture-heuristic",
    version: "1",
    cohort: "novice",
    strategy: "advance-first",
    score: (_context, actionId) => (actionId === "advance" ? 1 : 0)
  });
}

function store(): {
  readonly artifacts: PlaytestArtifactStore;
  readonly root: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-episode-runner-"));
  return {
    root,
    artifacts: new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: WORKSPACE_ID
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function runOptions(
  sandbox: PlaytestSandboxHandle,
  artifacts: PlaytestArtifactStore,
  overrides: Partial<Parameters<typeof runPlaytestEpisode>[0]> = {}
): Parameters<typeof runPlaytestEpisode>[0] {
  return {
    approval: approval(),
    sandbox,
    artifacts,
    batchId: "batch-1",
    repository: WORKSPACE_ID,
    scenarioId: "tutorial",
    scenarioFamily: "tutorial",
    seed: "seed-1",
    goal: "finish the tutorial",
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    runtimeVersion: "runtime-v1",
    environmentHash: ENVIRONMENT_HASH,
    policy: policy(),
    observationContract: observationContract(),
    maxSteps: 5,
    now: () => Date.parse("2026-10-10T00:00:00.000Z"),
    classifyOutcome: (outcome) =>
      isRecord(outcome) && (outcome.kind === "loss" || outcome.kind === "win")
        ? outcome.kind
        : "unknown",
    projectPublicOutcome: (outcome) =>
      isRecord(outcome) && typeof outcome.kind === "string"
        ? { kind: outcome.kind }
        : null,
    ...overrides
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("episode runner executes one approved episode, filters hidden observation/event/outcome fields, and records provenance", async () => {
  const temporary = store();
  const sandbox = sandboxFixture();
  let policyObservation: unknown;
  const testPolicy = createScoredPlaytestPolicy({
    id: "fixture-heuristic",
    version: "1",
    cohort: "novice",
    strategy: "advance-first",
    score: (context, actionId) => {
      policyObservation = context.observation;
      return actionId === "advance" ? 1 : 0;
    }
  });
  try {
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts, {
        policy: testPolicy,
        evaluate: ({ outcome, events, provenance }) => {
          const score = outcome.metrics.score ?? null;
          return [
            {
              metricId: "fixture-score",
              metricVersion: 1,
              numerator: score ?? 0,
              denominator: 1,
              coverage: 1,
              unit: "points",
              estimate: score,
              missing: 0,
              missingReasons: [],
              independentUnits: 1,
              provenance,
              notes: `observed ${events.length} source event`
            }
          ];
        }
      })
    );
    assert.ok(result.episode);
    assert.equal(result.episode.status, "completed");
    assert.equal(result.episode.outcome, "loss");
    assert.equal(result.episode.completionCounts.completed, 1);
    assert.equal(result.episode.stepCount, 1);
    assert.equal(result.episode.identity.workspaceId, WORKSPACE_ID);
    assert.equal(result.episode.identity.seed, "seed-1");
    assert.deepEqual(policyObservation, { room: "hall" });
    assert.deepEqual(
      result.episode.metrics.map((metric) => metric.metricId),
      ["fixture-score"]
    );
    assert.ok(result.traceReference);
    const stored = temporary.artifacts.readWindow(result.traceReference!);
    const text = new TextDecoder().decode(stored.bytes);
    assert.doesNotMatch(
      text,
      /engine-only-value|hidden-event-value|privileged-outcome/u
    );
    assert.match(text, /"visibleObservation":\{"room":"hall"\}/u);
    assert.match(text, /"eventId":"event-1"/u);
    assert.deepEqual(sandbox.sentMethods, [
      "game.capabilities",
      "game.reset",
      "game.observe",
      "game.legalActions",
      "game.step",
      "game.outcome"
    ]);
    assert.equal(sandbox.cleanupCount(), 1);
    assert.equal(sandbox.cancelCount(), 0);
  } finally {
    temporary.cleanup();
  }
});

test("synthetic 1,000-episode improvement cycle records evidence, finding, comparison, and a hold next-cycle state", async () => {
  const temporary = store();
  const baselineBuild = "a".repeat(40);
  const candidateBuild = "b".repeat(40);
  const baselineGameBuild = GAME_BUILD;
  const candidateGameBuild = "fixture-game-build-2";
  const pairs = 500;
  const injectedRegressionCount = 50;
  const episodes: PlaytestEpisode[] = [];
  const baselineOutcomes: number[] = [];
  const candidateOutcomes: number[] = [];
  const baselineBatchId = "batch-synthetic-baseline";
  const candidateBatchId = "batch-synthetic-candidate";
  const generatedAt = "2026-10-10T00:00:00.000Z";
  const metricId = "tutorial-completion";
  const metricVersion = 1;

  const evaluate = ({
    outcome,
    provenance
  }: Parameters<
    NonNullable<Parameters<typeof runPlaytestEpisode>[0]["evaluate"]>
  >[0]): readonly PlaytestNumericResult[] => {
    const estimate =
      isRecord(outcome.outcome) && outcome.outcome.kind === "win" ? 1 : 0;
    return [
      {
        metricId,
        metricVersion,
        numerator: estimate,
        denominator: 1,
        coverage: 1,
        unit: "proportion",
        estimate,
        missing: 0,
        missingReasons: [],
        independentUnits: 1,
        provenance,
        notes: "Synthetic fixture objective endpoint; not a human outcome."
      }
    ];
  };

  try {
    for (let index = 0; index < pairs; index += 1) {
      const seed = "seed-" + String(index).padStart(4, "0");
      for (const arm of ["baseline", "candidate"] as const) {
        const candidate = arm === "candidate";
        const buildSha = candidate ? candidateBuild : baselineBuild;
        const gameBuild = candidate ? candidateGameBuild : baselineGameBuild;
        const injectedLoss = candidate && index < injectedRegressionCount;
        const episodeId = arm + "-episode-" + String(index).padStart(4, "0");
        const result = await runPlaytestEpisode(
          runOptions(
            sandboxFixture({
              episodeId,
              eventId: arm + "-event-" + String(index).padStart(4, "0"),
              engineBuild: gameBuild,
              outcome: injectedLoss ? "loss" : "win"
            }),
            temporary.artifacts,
            {
              approval: approval({ buildSha, gameBuild }),
              batchId: candidate ? candidateBatchId : baselineBatchId,
              seed,
              measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
              evaluate
            }
          )
        );
        assert.ok(result.episode, `missing episode for ${arm} ${seed}`);
        assert.equal(result.episode.status, "completed");
        assert.equal(result.episode.identity.seed, seed);
        assert.equal(result.episode.identity.buildSha, buildSha);
        assert.equal(result.episode.identity.gameBuild, gameBuild);
        episodes.push(result.episode);
        const estimate = result.episode.metrics[0]?.estimate;
        assert.equal(typeof estimate, "number");
        (candidate ? candidateOutcomes : baselineOutcomes).push(estimate!);
      }
    }

    assert.equal(episodes.length, 1000);
    assert.equal(
      new Set(episodes.map((episode) => episode.episodeId)).size,
      1000
    );
    assert.equal(baselineOutcomes.filter((value) => value === 1).length, pairs);
    assert.equal(
      candidateOutcomes.filter((value) => value === 0).length,
      injectedRegressionCount
    );

    const candidateWitness = episodes.find(
      (episode) =>
        episode.batchId === candidateBatchId && episode.outcome === "loss"
    )!;
    const episodeEvidence = {
      kind: "episode" as const,
      id: candidateWitness.episodeId
    };
    const evidenceIndex: PlaytestKnownEvidenceIndex = {
      episodeIds: new Set(episodes.map((episode) => episode.episodeId)),
      eventEpisodeOf: new Map(),
      eventRelevantRuleOf: new Map(),
      reviewIds: new Set(),
      findingIds: new Set(),
      comparisonIds: new Set(),
      frameEpisodeOf: new Map()
    };
    const finding: PlaytestFinding = {
      findingId: "finding-synthetic-tutorial-regression",
      version: 1,
      title: "Tutorial completion regressed on the candidate build",
      description: `${injectedRegressionCount} of ${pairs} paired candidate episodes reached the injected defect outcome.`,
      severity: "major",
      status: "open",
      verificationStage: "not-yet-validated",
      evidenceStatus: "hypothesis",
      affectedEpisodes: injectedRegressionCount,
      totalEligibleEpisodes: pairs,
      affectedOpportunities: injectedRegressionCount,
      totalEligibleOpportunities: pairs,
      affectedCohorts: [candidateWitness.policyCohort],
      evidenceRefs: [episodeEvidence],
      experimentIds: ["experiment-synthetic-regression"],
      issueRefs: [],
      lastVerifiedBuild: null,
      nextReviewAt: null
    };
    assertPlaytestFindingEvidenceStatusConsistent(finding, evidenceIndex);

    const review: PlaytestSessionReview = {
      schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
      reviewId: "review-synthetic-regression",
      version: 1,
      episodeId: candidateWitness.episodeId,
      supersedes: null,
      authorRole: "playtest-analyst",
      authorId: "synthetic-acceptance-analyst",
      rubricHash: "c".repeat(64),
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      provenance: {
        workspaceId: WORKSPACE_ID,
        buildSha: candidateBuild,
        measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
        generatedAt
      },
      chronologicalSummary:
        "The synthetic candidate fixture produced the injected loss outcome.",
      authoritativeMetrics: candidateWitness.metrics,
      observations: ["The adapter returned the preregistered loss outcome."],
      interpretations: [
        "This is a synthetic mechanics signal, not a human-experience claim."
      ],
      anchors: [],
      alternativeExplanations: [
        "The fixture intentionally injected the defect."
      ],
      experiments: [],
      status: "hypothesis",
      findings: [finding],
      evidenceRefs: [episodeEvidence],
      createdAt: generatedAt,
      notes:
        "Synthetic acceptance evidence only; no game or human session was run."
    };
    assertPlaytestSessionReviewHasEvidence({
      reviewId: review.reviewId,
      evidenceRefs: review.evidenceRefs,
      findings: review.findings
    });

    const pairedBenefitDifferences = baselineOutcomes.map(
      (baseline, index) => candidateOutcomes[index]! - baseline
    );
    const meanBenefit =
      pairedBenefitDifferences.reduce((sum, value) => sum + value, 0) / pairs;
    const baselineEstimate =
      baselineOutcomes.reduce((sum, value) => sum + value, 0) / pairs;
    const candidateEstimate =
      candidateOutcomes.reduce((sum, value) => sum + value, 0) / pairs;
    const baselineSummary = {
      arm: "baseline" as const,
      assigned: pairs,
      eligible: pairs,
      missing: 0,
      independentUnits: pairs,
      exposure: pairs,
      estimate: baselineEstimate,
      rawDelta: null,
      interval: null
    };
    const candidateSummary = {
      arm: "candidate" as const,
      assigned: pairs,
      eligible: pairs,
      missing: 0,
      independentUnits: pairs,
      exposure: pairs,
      estimate: candidateEstimate,
      rawDelta: candidateEstimate - baselineEstimate,
      interval: null
    };
    const metricComparison = classifyPlaytestMetricComparison({
      metricId,
      metricVersion,
      compatibility: "paired-initial-condition",
      meaningfulMargin: 0.05,
      guardrailMargin: null,
      orientedBenefitDelta: meanBenefit,
      interval: null,
      baseline: baselineSummary,
      candidate: candidateSummary
    });
    assert.equal(metricComparison.classification, "inconclusive");
    assert.equal(metricComparison.orientedBenefitDelta, -0.1);

    const comparison: PlaytestComparison = buildPlaytestComparison({
      comparisonId: "comparison-synthetic-regression",
      version: 1,
      benchmarkId: "benchmark-synthetic-tutorial",
      experimentId: "experiment-synthetic-regression",
      baseline: { id: baselineBuild, version: 1 },
      candidate: { id: candidateBuild, version: 1 },
      freezeStatus: "frozen",
      pairing: {
        mode: "paired-initial-condition",
        pairMap: Object.fromEntries(
          Array.from({ length: pairs }, (_, index) => [
            "seed-" + String(index).padStart(4, "0"),
            "baseline-episode-" +
              String(index).padStart(4, "0") +
              "|candidate-episode-" +
              String(index).padStart(4, "0")
          ])
        ),
        rngAlgorithm: "fixture-rng",
        rngStreamVersion: "fixture-rng-v1",
        couplingDiagnostics: ["same seed and deterministic fixture adapter"],
        exclusions: []
      },
      sourceFindingIds: [finding.findingId],
      episodeRefs: [episodeEvidence],
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      metrics: [metricComparison],
      primaryMetricId: metricId,
      provenance: {
        workspaceId: WORKSPACE_ID,
        buildSha: candidateBuild,
        measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
        generatedAt
      },
      notes: "Synthetic acceptance comparison: no human or real-game claim."
    });
    assert.equal(comparison.decision, "hold-inconclusive");
    const nextCycle: PlaytestFixLineage = {
      findingId: finding.findingId,
      experimentId: "experiment-synthetic-regression",
      issueRef: null,
      pullRequestRef: null,
      candidateBuildSha: candidateBuild,
      retestBatchIds: [candidateBatchId],
      comparisonIds: [comparison.comparisonId],
      verificationStage: "insufficient-evidence",
      recurrenceCount: 0,
      lastVerifiedBuild: null,
      nextReviewAt: null
    };
    assert.equal(nextCycle.comparisonIds[0], comparison.comparisonId);
    assert.equal(nextCycle.verificationStage, "insufficient-evidence");

    const batches = [baselineBatchId, candidateBatchId].map(
      (batchId, index) => ({
        schema: PLAYTESTS_BATCH_SCHEMA,
        batchId,
        revision: 1,
        workspaceId: WORKSPACE_ID,
        repository: WORKSPACE_ID,
        buildSha: index === 0 ? baselineBuild : candidateBuild,
        gameBuild: index === 0 ? baselineGameBuild : candidateGameBuild,
        configHash: approval().playtestConfigHash,
        rubricHash: "c".repeat(64),
        actionSchemaHash: episodes[0]!.identity.actionSchemaHash,
        observationSchemaHash: episodes[0]!.identity.observationSchemaHash,
        eventSchemaHash: episodes[0]!.identity.eventSchemaHash,
        measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
        protocolVersion: 1 as const,
        policyIds: ["fixture-heuristic"],
        cohortIds: ["novice"],
        scenarioIds: ["tutorial"],
        samplingPlan: null,
        status: "completed" as const,
        counts: {
          assigned: pairs,
          started: pairs,
          completed: pairs,
          crashed: 0,
          infrastructureFailed: 0,
          cancelled: 0,
          budgetTruncated: 0,
          reviewed: 0,
          eligible: pairs
        },
        budget: {
          assignedEpisodes: pairs,
          maxStepsPerEpisode: 5,
          wallTimeMs: 30_000,
          critiqueBudget: 0,
          actualCritiques: 0
        },
        startedAt: generatedAt,
        completedAt: generatedAt,
        createdAt: generatedAt,
        provenance: {
          workspaceId: WORKSPACE_ID,
          buildSha: index === 0 ? baselineBuild : candidateBuild,
          measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
          generatedAt
        },
        evaluationIds: [],
        spanIds: []
      })
    );
    assert.equal(
      batches.reduce((sum, batch) => sum + batch.counts.assigned, 0),
      1000
    );
    assert.equal(review.episodeId, candidateWitness.episodeId);
    assert.equal(
      episodes.filter((episode) => episode.status === "completed").length,
      1000
    );
  } finally {
    temporary.cleanup();
  }
});

test("episode runner records a hard step budget as truncated, never as a game loss", async () => {
  const temporary = store();
  const sandbox = sandboxFixture({ terminal: false });
  try {
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts, { maxSteps: 1 })
    );
    assert.equal(result.episode?.status, "budget-truncated");
    assert.equal(result.episode?.outcome, "unknown");
    assert.deepEqual(result.episode?.missingReasons, ["budget-truncated"]);
    assert.equal(result.failure?.category, "budget-truncated");
  } finally {
    temporary.cleanup();
  }
});

test("episode runner rejects an unapproved policy before adapter negotiation", async () => {
  const temporary = store();
  const sandbox = sandboxFixture();
  const forbidden = createScoredPlaytestPolicy({
    id: "not-approved",
    version: "1",
    cohort: "novice",
    strategy: "forbidden",
    score: () => 0
  });
  try {
    await assert.rejects(
      runPlaytestEpisode(
        runOptions(sandbox, temporary.artifacts, { policy: forbidden })
      ),
      /not permitted by the workspace approval/u
    );
    assert.deepEqual(sandbox.sentMethods, []);
  } finally {
    temporary.cleanup();
  }
});

test("episode runner rejects policy-selected actions outside current legal actions", async () => {
  const temporary = store();
  const sandbox = sandboxFixture();
  const malicious = {
    ...policy(),
    id: "fixture-heuristic",
    chooseAction: () => ({ actionId: "injected", prediction: null })
  };
  try {
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts, { policy: malicious })
    );
    assert.equal(result.episode?.status, "infrastructure-failed");
    assert.equal(result.episode?.outcome, "unknown");
    assert.equal(result.failure?.category, "policy");
    assert.equal(sandbox.sentMethods.includes("game.step"), false);
  } finally {
    temporary.cleanup();
  }
});

test("episode cancellation uses game.cancel before process-tree termination and preserves partial evidence", async () => {
  const temporary = store();
  const controller = new AbortController();
  const sandbox = sandboxFixture({
    onStepRequest: () => controller.abort()
  });
  try {
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts, { signal: controller.signal })
    );
    assert.equal(result.episode?.status, "cancelled");
    assert.equal(result.episode?.outcome, "unknown");
    assert.ok(result.episode?.missingReasons.includes("cancelled"));
    assert.ok(sandbox.sentMethods.includes("game.cancel"));
    assert.ok(sandbox.cancelCount() > 0);
    assert.ok(result.traceReference);
    const trace = temporary.artifacts.readWindow(result.traceReference!);
    assert.match(
      new TextDecoder().decode(trace.bytes),
      /"selectedActionId":"advance"/u
    );
  } finally {
    temporary.cleanup();
  }
});
