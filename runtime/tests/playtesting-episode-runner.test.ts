import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";
import test from "node:test";

import {
  assertPlaytestFindingEvidenceStatusConsistent,
  assertPlaytestSessionReviewHasEvidence,
  buildPlaytestComparison,
  buildPlaytestFindingIdentity,
  classifyPlaytestMetricComparison,
  type GameCaptureEvent,
  type GameMetricEvaluation,
  type PlaytestAssignmentBranch,
  type PlaytestCapabilityAdvertisement,
  type PlaytestCheckpointDigest,
  type PlaytestComparison,
  type PlaytestEpisode,
  type PlaytestFinding,
  playtestFindingIdentityHashInput,
  type PlaytestFixLineage,
  type PlaytestKnownEvidenceIndex,
  type PlaytestObservationContract,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  type PlaytestSessionReview,
  type WorkspacePlaytestApproval,
  type WorkspacePlaytestBuild
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
import {
  fixturePlaytestMetricRegistry,
  fixtureScoreEvaluation
} from "./support/playtesting-metric-registry.ts";

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
  engineBuild = GAME_BUILD,
  supportsBranching = false,
  supportsCaptureEvents = false
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
    optionalOperations: [
      ...(supportsBranching
        ? (["game.snapshot", "game.replay", "game.fork"] as const)
        : []),
      ...(supportsCaptureEvents ? (["game.captureEvents"] as const) : [])
    ],
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

/** The committed build a batch resolved from the approved checkout. */
function build(
  overrides: Partial<WorkspacePlaytestBuild> = {}
): WorkspacePlaytestBuild {
  return {
    buildSha: "a".repeat(40),
    gameBuild: GAME_BUILD,
    configHash: "b".repeat(64),
    ...overrides
  };
}

function approval(
  overrides: Partial<WorkspacePlaytestApproval> = {}
): WorkspacePlaytestApproval {
  return {
    schema: "autodev-workspace-playtest-approval-v2",
    workspaceId: WORKSPACE_ID,
    revision: 1,
    approvalId: "fixture-approval",
    checkoutRoot: "/tmp/approved-fixture-game",
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
    readonly singleLegalAction?: boolean;
    readonly noLegalActions?: boolean;
    readonly onStepRequest?: () => void;
    readonly episodeId?: string;
    readonly eventId?: string;
    readonly rngProvenanceVersion?: string;
    readonly rngReproducible?: boolean;
    readonly engineBuild?: string;
    readonly outcome?: "loss" | "win";
    readonly supportsBranching?: boolean;
    readonly supportsCaptureEvents?: boolean;
    readonly emitEventNotifications?: boolean;
    readonly captureEventsOmittedCount?: number;
    readonly branchStep?: number;
    readonly replayMismatch?: "hidden-state" | "rng" | "fork-state" | null;
    readonly branchAlternativeNotLegal?: boolean;
    readonly snapshotCorrupted?: boolean;
    readonly evaluations?: readonly GameMetricEvaluation[];
  } = {}
): FixtureSandbox {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sentMethods: string[] = [];
  const snapshotBytes = Buffer.from("synthetic checkpoint bytes", "utf8");
  const snapshotSha = createHash("sha256").update(snapshotBytes).digest("hex");
  const snapshotRef = {
    artifactId: "adapter-snapshot-1",
    sha256: snapshotSha,
    bytes: snapshotBytes.byteLength,
    mediaType: "application/vnd.fixture.snapshot"
  } as const;
  const snapshotStagingDirectory = options.supportsBranching
    ? mkdtempSync(path.join(tmpdir(), "autodev-branch-snapshot-"))
    : null;
  const snapshotPath = snapshotStagingDirectory
    ? path.join(snapshotStagingDirectory, snapshotSha)
    : null;
  if (snapshotPath) {
    const stagedSnapshotBytes = Buffer.from(snapshotBytes);
    if (options.snapshotCorrupted)
      stagedSnapshotBytes[0] = stagedSnapshotBytes[0]! ^ 1;
    writeFileSync(snapshotPath, stagedSnapshotBytes, { mode: 0o600 });
  }
  const exitListeners: Array<(cause: PlaytestAdapterExit) => void> = [];
  let requestBuffer = "";
  let revision = 0;
  let eventSequence = 0;
  let stepEvents: GameCaptureEvent[] = [];
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
  const handleBranchRequest = (
    method: string,
    id: string,
    params: Record<string, unknown>
  ): boolean => {
    if (method === "game.replay") {
      revision = options.branchStep ?? 2;
      const mismatch = options.replayMismatch;
      respond(id, {
        episodeId: "replayed-parent-1",
        revision,
        replayStatus: "verified",
        transitionHash: "d".repeat(64),
        firstDivergentStep: null,
        replayedThroughStep: params.throughStep,
        stateHash:
          mismatch === "hidden-state" ? "a".repeat(64) : "f".repeat(64),
        rngCheckpoint: {
          algorithm: "fixture-rng",
          version: "fixture-rng-v1",
          stateHash: mismatch === "rng" ? "a".repeat(64) : "e".repeat(64),
          reproducible: true
        },
        diagnostics: []
      });
      return true;
    }
    if (method === "game.snapshot") {
      const withArtifact = params.includeArtifact === true;
      respond(id, {
        episodeId: params.episodeId,
        revision,
        stateHash: "f".repeat(64),
        rngCheckpoint: {
          algorithm: "fixture-rng",
          version: "fixture-rng-v1",
          stateHash: "e".repeat(64),
          reproducible: true
        },
        snapshot: withArtifact ? snapshotRef : null,
        integrityHash: withArtifact ? snapshotSha : null
      });
      return true;
    }
    if (method === "game.fork") {
      revision = options.branchStep ?? 2;
      respond(id, {
        episodeId: "branch-episode-1",
        revision,
        initialStateHash:
          options.replayMismatch === "fork-state"
            ? "a".repeat(64)
            : "f".repeat(64),
        rngCheckpoint: {
          algorithm: "fixture-rng",
          version: "fixture-rng-v1",
          stateHash: "e".repeat(64),
          reproducible: true
        }
      });
      return true;
    }
    return false;
  };
  const handleGameRequest = (
    method: string,
    id: string,
    params: Record<string, unknown>
  ): void => {
    switch (method) {
      case "game.reset": {
        revision = 0;
        eventSequence = 0;
        stepEvents = [];
        respond(id, {
          episodeId: options.episodeId ?? "fixture-episode-1",
          revision,
          rngProvenance: {
            algorithm: "fixture-rng",
            version: options.rngProvenanceVersion ?? "fixture-rng-v1",
            initialStateHash: "e".repeat(64),
            reproducible: options.rngReproducible ?? true
          }
        });
        return;
      }
      case "game.observe": {
        respond(id, {
          episodeId: params.episodeId,
          revision,
          observation: { room: "hall", secret: "engine-only-value" },
          turnContext: null,
          frame: null
        });
        return;
      }
      case "game.legalActions": {
        respond(id, {
          episodeId: params.episodeId,
          revision,
          actions: options.noLegalActions
            ? []
            : options.singleLegalAction
              ? [{ actionId: "advance", description: "Advance" }]
              : options.branchAlternativeNotLegal
                ? [{ actionId: "advance", description: "Advance" }]
                : [
                    { actionId: "advance", description: "Advance" },
                    { actionId: "wait", description: "Wait" }
                  ]
        });
        return;
      }
      case "game.step": {
        options.onStepRequest?.();
        revision += 1;
        if (options.terminal === false) {
          respond(id, {
            episodeId: params.episodeId,
            revision,
            acceptedActionId: params.actionId,
            eventIds: [],
            terminal: false
          });
          return;
        }
        const event: GameCaptureEvent = {
          eventId: options.eventId ?? "event-1",
          type: "choice-applied",
          phaseId: "tutorial",
          step: 0,
          revision,
          actor: "player",
          fields: { secret: "hidden-event-value", visibleFact: "advance" }
        };
        stepEvents = [event];
        if (options.emitEventNotifications !== false) {
          eventSequence += 1;
          notify("game.event", {
            episodeId: params.episodeId,
            revision,
            eventSequence,
            event
          });
        }
        respond(id, {
          episodeId: params.episodeId,
          revision,
          acceptedActionId: params.actionId,
          eventIds: [options.eventId ?? "event-1"],
          terminal: true
        });
        return;
      }
      case "game.captureEvents": {
        const events =
          options.captureEventsOmittedCount === undefined
            ? stepEvents.filter(
                (event) =>
                  event.step >= Number(params.startStep) &&
                  event.step <= Number(params.endStep)
              )
            : [];
        respond(id, {
          episodeId: params.episodeId,
          revision,
          events,
          omittedCount: options.captureEventsOmittedCount ?? 0
        });
        return;
      }
      case "game.outcome": {
        respond(id, {
          episodeId: params.episodeId,
          revision,
          state: options.terminal === false ? "partial" : "terminal",
          outcome: {
            kind: options.outcome ?? "loss",
            secret: "privileged-outcome"
          },
          metrics: { score: 0 },
          evaluations: options.evaluations ?? [fixtureScoreEvaluation(0)],
          missingReasons: []
        });
        return;
      }
      case "game.cancel": {
        respond(id, {
          requestId: params.requestId,
          acknowledged: true,
          episodeDisposition: "unknown"
        });
        break;
      }
      default: {
        break;
      }
    }
  };
  const processRequest = (request: Record<string, unknown>): void => {
    const method = String(request.method);
    const id = String(request.id);
    const params = request.params as Record<string, unknown>;
    sentMethods.push(method);
    if (method === "game.capabilities") {
      respond(
        id,
        capabilities(
          options.engineBuild,
          options.supportsBranching,
          options.supportsCaptureEvents
        )
      );
      return;
    }
    if (handleBranchRequest(method, id, params)) return;
    handleGameRequest(method, id, params);
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
      stagingDirectory: snapshotStagingDirectory,
      artifacts:
        snapshotStagingDirectory && snapshotPath
          ? [
              {
                relativePath: snapshotSha,
                absolutePath: snapshotPath,
                size: snapshotBytes.byteLength
              }
            ]
          : []
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
      if (snapshotStagingDirectory) {
        rmSync(snapshotStagingDirectory, { recursive: true, force: true });
      }
    },
    sentMethods,
    closeNormally: () => stdin.end(),
    cancelCount: () => cancelCount,
    cleanupCount: () => cleanupCount
  };
}

function branchExecution(
  branchStep = 2,
  alternativeActionId = "wait"
): NonNullable<Parameters<typeof runPlaytestEpisode>[0]["branch"]> {
  const advertised = capabilities(GAME_BUILD, true);
  const parentEpisode: PlaytestEpisode = {
    schema: "autodev-playtest-episode-v5",
    episodeId: "parent-episode-1",
    revision: 4,
    batchId: "parent-batch-1",
    assignmentId: "a-0001",
    branchLineage: null,
    executionProvenance: {
      mode: "adapter-accelerated",
      source: {
        kind: "repo-checkout",
        repository: WORKSPACE_ID,
        revision: build().buildSha,
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
    identity: {
      workspaceId: WORKSPACE_ID,
      repository: WORKSPACE_ID,
      buildSha: build().buildSha,
      gameBuild: GAME_BUILD,
      scenarioId: "tutorial",
      configHash: build().configHash,
      seed: "seed-1",
      rngInitialStateHash: "e".repeat(64),
      rngAlgorithm: "fixture-rng",
      rngVersion: "fixture-rng-v1",
      policyId: "fixture-heuristic",
      policyVersion: "1",
      modelId: null,
      modelRevision: null,
      observationSchemaHash: advertised.observationSchemaHash,
      actionSchemaHash: advertised.actionSchemaHash,
      eventSchemaHash: advertised.eventSchemaHash,
      protocolVersion: 1,
      runtimeVersion: "runtime-v1",
      environmentHash: ENVIRONMENT_HASH
    },
    scenarioFamily: "tutorial",
    policyCohort: "novice",
    strategy: "advance-first",
    status: "completed",
    termination: { reason: "game-terminal", step: 3 },
    outcome: "loss",
    outcomeMetrics: {},
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
    trace: { kind: "replay-segment", id: "parent-trace-1" },
    frames: [],
    stepCount: 4,
    metrics: [],
    findingIds: [],
    assignedAt: "2026-10-10T00:00:00.000Z",
    startedAt: "2026-10-10T00:00:00.000Z",
    completedAt: "2026-10-10T00:00:01.000Z",
    simulationWallMs: 10,
    logicalTicks: 4,
    policyInferenceMs: 1,
    nativeDurationMs: null,
    completeness: "complete",
    missingReasons: []
  };
  const parentTrace = {
    artifactId: "parent-trace-1",
    sha256: "c".repeat(64),
    bytes: 1024,
    mediaType: "application/x-ndjson"
  } as const;
  const parentCheckpoint: PlaytestCheckpointDigest = {
    stateHash: "f".repeat(64),
    rngCheckpoint: {
      algorithm: "fixture-rng",
      version: "fixture-rng-v1",
      stateHash: "e".repeat(64),
      reproducible: true
    }
  };
  const manifest: PlaytestAssignmentBranch = {
    parentEpisodeId: parentEpisode.episodeId,
    parentEpisodeRevision: parentEpisode.revision,
    parentBatchId: parentEpisode.batchId,
    branchStep,
    parentTrace,
    parentCheckpoint,
    alternativeActionId,
    rngPolicy: "same-stream",
    rngPolicyVersion: "same-stream-state-v1"
  };
  return { manifest, parentEpisode };
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
    build: build(),
    sandbox,
    artifacts,
    batchId: "batch-1",
    assignmentId: "a-0001",
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
    metricRegistry: fixturePlaytestMetricRegistry(WORKSPACE_ID),
    rubricHash: "e".repeat(64),
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
  const sandbox = sandboxFixture({
    evaluations: [fixtureScoreEvaluation(0)]
  });
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
        policy: testPolicy
      })
    );
    assert.ok(
      result.episode,
      JSON.stringify({ failure: result.failure, methods: sandbox.sentMethods })
    );
    assert.equal(result.episode.status, "completed");
    assert.equal(result.episode.outcome, "loss");
    assert.equal(result.episode.completionCounts.completed, 1);
    assert.equal(result.episode.stepCount, 1);
    assert.equal(result.episode.identity.workspaceId, WORKSPACE_ID);
    assert.equal(result.episode.identity.seed, "seed-1");
    assert.equal(result.episode.identity.rngInitialStateHash, "e".repeat(64));
    assert.equal(
      result.episode.executionProvenance.mode,
      "adapter-accelerated"
    );
    assert.equal(
      result.episode.executionProvenance.source.kind,
      "repo-checkout"
    );
    assert.equal(
      result.episode.executionProvenance.source.revision,
      build().buildSha
    );
    assert.equal(
      result.episode.executionProvenance.source.revisionConfidence,
      "verified"
    );
    assert.equal(
      result.episode.executionProvenance.observationSource,
      "engine-adapter"
    );
    assert.equal(
      result.episode.executionProvenance.actionSource,
      "engine-policy"
    );
    assert.deepEqual(policyObservation, { room: "hall" });
    assert.deepEqual(
      result.episode.metrics.map((metric) => metric.metricId),
      ["fixture-score"]
    );
    assert.equal(result.episode.metrics[0]?.numerator, 0);
    assert.equal(result.episode.metrics[0]?.denominator, 1);
    assert.equal(result.episode.metrics[0]?.opportunityCount, 1);
    assert.equal(result.episode.metrics[0]?.coverage, 1);
    assert.equal(result.episode.metrics[0]?.estimate, 0);
    assert.equal(
      result.episode.metrics[0]?.provenance.evaluatorHash,
      "f".repeat(64)
    );
    assert.equal(
      result.episode.metrics[0]?.provenance.rubricHash,
      "e".repeat(64)
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

test("episode runner retrieves exact-step events from the generic adapter binding", async () => {
  const temporary = store();
  const sandbox = sandboxFixture({
    supportsCaptureEvents: true,
    emitEventNotifications: false
  });
  try {
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts)
    );
    assert.ok(result.episode);
    assert.equal(result.episode.status, "completed");
    assert.deepEqual(sandbox.sentMethods, [
      "game.capabilities",
      "game.reset",
      "game.observe",
      "game.legalActions",
      "game.step",
      "game.captureEvents",
      "game.outcome"
    ]);
    assert.equal(result.steps[0]?.eventRefs[0]?.id, "event-1");
    assert.equal(result.steps[0]?.eventRefs[0]?.step, 0);
    assert.ok(!result.episode.missingReasons.includes("infrastructure-failed"));
    assert.ok(result.traceReference);
    const trace = new TextDecoder().decode(
      temporary.artifacts.readWindow(result.traceReference).bytes
    );
    assert.match(trace, /"eventId":"event-1"/u);
    assert.doesNotMatch(trace, /hidden-event-value/u);
  } finally {
    temporary.cleanup();
  }
});

test("episode runner refuses reset RNG provenance that contradicts capabilities", async () => {
  const temporary = store();
  try {
    for (const mismatch of [
      { rngProvenanceVersion: "other-rng-v1" },
      { rngReproducible: false }
    ]) {
      const sandbox = sandboxFixture(mismatch);
      const result = await runPlaytestEpisode(
        runOptions(sandbox, temporary.artifacts)
      );
      assert.ok(result.episode);
      assert.equal(result.episode.status, "infrastructure-failed");
      assert.ok(
        result.episode.missingReasons.includes("infrastructure-failed")
      );
      assert.deepEqual(sandbox.sentMethods, [
        "game.capabilities",
        "game.reset"
      ]);
    }
  } finally {
    temporary.cleanup();
  }
});

test("episode runner preserves omitted events as named missing evidence", async () => {
  const temporary = store();
  const sandbox = sandboxFixture({
    supportsCaptureEvents: true,
    emitEventNotifications: false,
    captureEventsOmittedCount: 1
  });
  try {
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts)
    );
    assert.ok(result.episode);
    assert.ok(
      result.episode.missingReasons.includes(
        "missing-action-or-revision-events"
      )
    );
    assert.ok(result.episode.missingReasons.includes("infrastructure-failed"));
  } finally {
    temporary.cleanup();
  }
});

interface SyntheticArmConfiguration {
  readonly name: "baseline" | "candidate";
  readonly batchId: string;
  readonly buildSha: string;
  readonly gameBuild: string;
}

async function runSyntheticArm(input: {
  readonly artifacts: PlaytestArtifactStore;
  readonly arm: SyntheticArmConfiguration;
  readonly seed: string;
  readonly index: number;
  readonly metricId: string;
  readonly metricRegistry: ReturnType<typeof fixturePlaytestMetricRegistry>;
  readonly injectedLoss: boolean;
}): Promise<{ readonly episode: PlaytestEpisode; readonly estimate: number }> {
  const episodeId =
    input.arm.name + "-episode-" + String(input.index).padStart(4, "0");
  const result = await runPlaytestEpisode(
    runOptions(
      sandboxFixture({
        episodeId,
        eventId:
          input.arm.name + "-event-" + String(input.index).padStart(4, "0"),
        engineBuild: input.arm.gameBuild,
        outcome: input.injectedLoss ? "loss" : "win",
        evaluations: [
          fixtureScoreEvaluation(input.injectedLoss ? 0 : 1, input.metricId)
        ]
      }),
      input.artifacts,
      {
        build: build({
          buildSha: input.arm.buildSha,
          gameBuild: input.arm.gameBuild
        }),
        batchId: input.arm.batchId,
        assignmentId: "a-" + String(input.index + 1).padStart(4, "0"),
        seed: input.seed,
        measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
        metricRegistry: input.metricRegistry
      }
    )
  );
  assert.ok(
    result.episode,
    "missing episode for " + input.arm.name + " " + input.seed
  );
  assert.equal(result.episode.status, "completed");
  assert.equal(result.episode.identity.seed, input.seed);
  assert.equal(result.episode.identity.buildSha, input.arm.buildSha);
  assert.equal(result.episode.identity.gameBuild, input.arm.gameBuild);
  const estimate = result.episode.metrics[0]?.estimate;
  assert.equal(typeof estimate, "number");
  return { episode: result.episode, estimate: estimate! };
}

async function runSyntheticImprovementEpisodes(input: {
  readonly artifacts: PlaytestArtifactStore;
  readonly pairs: number;
  readonly injectedRegressionCount: number;
  readonly baseline: SyntheticArmConfiguration;
  readonly candidate: SyntheticArmConfiguration;
  readonly metricId: string;
  readonly metricRegistry: ReturnType<typeof fixturePlaytestMetricRegistry>;
}): Promise<{
  readonly episodes: PlaytestEpisode[];
  readonly baselineOutcomes: number[];
  readonly candidateOutcomes: number[];
}> {
  const episodes: PlaytestEpisode[] = [];
  const baselineOutcomes: number[] = [];
  const candidateOutcomes: number[] = [];
  for (let index = 0; index < input.pairs; index += 1) {
    const seed = "seed-" + String(index).padStart(4, "0");
    const baseline = await runSyntheticArm({
      artifacts: input.artifacts,
      arm: input.baseline,
      seed,
      index,
      metricId: input.metricId,
      metricRegistry: input.metricRegistry,
      injectedLoss: false
    });
    const candidate = await runSyntheticArm({
      artifacts: input.artifacts,
      arm: input.candidate,
      seed,
      index,
      metricId: input.metricId,
      metricRegistry: input.metricRegistry,
      injectedLoss: index < input.injectedRegressionCount
    });
    episodes.push(baseline.episode, candidate.episode);
    baselineOutcomes.push(baseline.estimate);
    candidateOutcomes.push(candidate.estimate);
  }
  return { episodes, baselineOutcomes, candidateOutcomes };
}

test("persisted episode identity is Runtime-owned, so a game's seed-derived episode id never collides across builds", async () => {
  const temporary = store();
  try {
    // RacingGame-style adapters derive their episode handle from the seed, so
    // the same seed on a new commit returns the same handle.
    const run = async (batchId: string, buildSha: string) =>
      runPlaytestEpisode(
        runOptions(
          sandboxFixture({ episodeId: "game-episode-from-seed" }),
          temporary.artifacts,
          { batchId, build: build({ buildSha }) }
        )
      );
    const first = await run("batch-old-commit", "a".repeat(40));
    const second = await run("batch-new-commit", "c".repeat(40));
    assert.equal(first.episode?.episodeId, "batch-old-commit.a-0001");
    assert.equal(second.episode?.episodeId, "batch-new-commit.a-0001");
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
  const baselineBatchId = "batch-synthetic-baseline";
  const candidateBatchId = "batch-synthetic-candidate";
  const generatedAt = "2026-10-10T00:00:00.000Z";
  const metricId = "tutorial-completion";
  const metricVersion = 1;
  const metricRegistry = fixturePlaytestMetricRegistry(WORKSPACE_ID, metricId);

  try {
    const { episodes, baselineOutcomes, candidateOutcomes } =
      await runSyntheticImprovementEpisodes({
        artifacts: temporary.artifacts,
        pairs,
        injectedRegressionCount,
        baseline: {
          name: "baseline",
          batchId: baselineBatchId,
          buildSha: baselineBuild,
          gameBuild: baselineGameBuild
        },
        candidate: {
          name: "candidate",
          batchId: candidateBatchId,
          buildSha: candidateBuild,
          gameBuild: candidateGameBuild
        },
        metricId,
        metricRegistry
      });
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
    const findingIdentity = buildPlaytestFindingIdentity({
      workspaceId: candidateWitness.identity.workspaceId,
      mechanicKey: "tutorial-completion-regression",
      failureSignature: {
        events: ["step-stuck"],
        action: "advance",
        witness: "witness-tutorial-completion"
      },
      scope: {
        scenarioFamily: candidateWitness.scenarioFamily,
        phase: "phase-tutorial",
        modality: "headless"
      }
    });
    const findingFingerprint = createHash("sha256")
      .update(playtestFindingIdentityHashInput(findingIdentity))
      .digest("hex");
    const finding: PlaytestFinding = {
      identity: findingIdentity,
      fingerprint: findingFingerprint,
      findingId: "finding-" + findingFingerprint,
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
      evidencePacket: null,
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
      observations: [
        {
          text: "The adapter returned the preregistered loss outcome.",
          evidenceRefs: [episodeEvidence]
        }
      ],
      interpretations: [
        {
          text: "This is a synthetic mechanics signal, not a human-experience claim.",
          evidenceRefs: [episodeEvidence]
        }
      ],
      anchors: [],
      alternativeExplanations: [
        "The fixture intentionally injected the defect."
      ],
      reportCompleteness: {
        crossSessionContext: {
          status: "unavailable",
          reason: "This synthetic session has no cross-session synthesis."
        },
        alternatives: { status: "provided" },
        experiments: {
          status: "none-recommended",
          reason: "This mechanics fixture does not recommend an experiment."
        },
        followUp: {
          status: "proposed",
          text: "Inspect the synthetic finding in a separate validation run."
        }
      },
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
      observations: review.observations,
      interpretations: review.interpretations,
      alternativeExplanations: review.alternativeExplanations,
      experiments: review.experiments,
      reportCompleteness: review.reportCompleteness,
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

    const frozenPairingEvidence = {
      requestedMode: "paired-initial-condition" as const,
      allocationPlanHash: createHash("sha256")
        .update("synthetic-acceptance-seed-allocation-v1")
        .digest("hex"),
      pairs: Array.from({ length: pairs }, (_, index) => {
        const suffix = String(index).padStart(4, "0");
        const seed = "seed-" + suffix;
        const stateHash = createHash("sha256")
          .update("initial-state:" + seed)
          .digest("hex");
        const rngSequenceHash = createHash("sha256")
          .update("rng-sequence:" + seed)
          .digest("hex");
        const side = (arm: "baseline" | "candidate") => ({
          episodeId: arm + "-episode-" + suffix,
          scenarioId: "tutorial",
          seedAllocationId: "assignment-" + seed,
          policyInformationHash: createHash("sha256")
            .update("fixture-heuristic-v1/tutorial/empty-memory")
            .digest("hex"),
          initialStateHash: stateHash,
          rngAlgorithm: "fixture-rng",
          rngStreamVersion: "fixture-rng-v1",
          rngSequenceHash
        });
        return {
          pairId: "pair-" + seed,
          baseline: side("baseline"),
          candidate: side("candidate")
        };
      })
    };

    const comparison: PlaytestComparison = buildPlaytestComparison({
      comparisonId: "comparison-synthetic-regression",
      version: 1,
      benchmarkId: "benchmark-synthetic-tutorial",
      experimentId: "experiment-synthetic-regression",
      baseline: { id: baselineBuild, version: 1 },
      candidate: { id: candidateBuild, version: 1 },
      freezeStatus: "frozen",
      pairingEvidence: frozenPairingEvidence,
      sourceFindingIds: [finding.findingId],
      episodeRefs: [episodeEvidence],
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      metrics: [
        {
          metricId,
          metricVersion,
          meaningfulMargin: 0.05,
          guardrailMargin: null,
          orientedBenefitDelta: meanBenefit,
          interval: null,
          baseline: baselineSummary,
          candidate: candidateSummary,
          baselineUnitIds: frozenPairingEvidence.pairs.map(
            (pair) => pair.baseline.episodeId
          ),
          candidateUnitIds: frozenPairingEvidence.pairs.map(
            (pair) => pair.candidate.episodeId
          ),
          missingnessPlan: {
            maximumMissingFraction: 0,
            sensitivityBounds: "not-needed"
          },
          precisionPlan: {
            minimumIndependentUnits: 1,
            maximumIntervalWidth: null
          },
          baselineSemantics: {
            metricId,
            metricVersion,
            source: "deterministic",
            quantityHash: createHash("sha256")
              .update("fixture-tutorial-completion-quantity-v1")
              .digest("hex"),
            sourceHash: createHash("sha256")
              .update("fixture-tutorial-completion-evaluator-v1")
              .digest("hex"),
            modality: "headless",
            independentUnit: "episode"
          },
          candidateSemantics: {
            metricId,
            metricVersion,
            source: "deterministic",
            quantityHash: createHash("sha256")
              .update("fixture-tutorial-completion-quantity-v1")
              .digest("hex"),
            sourceHash: createHash("sha256")
              .update("fixture-tutorial-completion-evaluator-v1")
              .digest("hex"),
            modality: "headless",
            independentUnit: "episode"
          }
        }
      ],
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
        configHash: build().configHash,
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

test("episode runner proves replay, hidden-state/RNG equality, snapshot, fork, legal intervention and durable lineage", async () => {
  const temporary = store();
  const sandbox = sandboxFixture({ supportsBranching: true, branchStep: 2 });
  try {
    const branch = branchExecution(2, "wait");
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts, { branch })
    );
    assert.ok(
      result.episode,
      JSON.stringify({ failure: result.failure, methods: sandbox.sentMethods })
    );
    assert.equal(result.episode.status, "completed");
    assert.equal(result.episode.outcome, "loss");
    assert.equal(result.episode.stepCount, 1);
    assert.deepEqual(sandbox.sentMethods, [
      "game.capabilities",
      "game.replay",
      "game.snapshot",
      "game.fork",
      "game.observe",
      "game.legalActions",
      "game.snapshot",
      "game.step",
      "game.outcome"
    ]);
    assert.equal(result.steps[0]?.selectedActionId, "wait");
    assert.deepEqual(
      result.steps[0]?.checkpoint,
      branch.manifest.parentCheckpoint
    );
    assert.equal(result.episode.identity.rngInitialStateHash, "e".repeat(64));
    assert.deepEqual(result.episode.branchLineage, {
      ...branch.manifest,
      replayTransitionHash: "d".repeat(64),
      snapshotArtifact: result.episode.branchLineage?.snapshotArtifact,
      snapshotIntegrityHash:
        result.episode.branchLineage?.snapshotIntegrityHash,
      forkStateHash: "f".repeat(64),
      forkRngCheckpoint: branch.manifest.parentCheckpoint.rngCheckpoint,
      continuationPolicyId: "fixture-heuristic",
      continuationPolicyVersion: "1"
    });
    assert.equal(
      result.episode.branchLineage?.snapshotArtifact?.sha256,
      result.episode.branchLineage?.snapshotIntegrityHash
    );
    assert.ok(result.episode.branchLineage?.snapshotArtifact);
    assert.equal(result.episode.completeness, "complete");
    assert.deepEqual(result.episode.missingReasons, []);
    assert.ok(result.traceReference);
    const trace = new TextDecoder().decode(
      temporary.artifacts.readWindow(result.traceReference!).bytes
    );
    assert.match(trace, /"checkpoint":\{"stateHash":"f{64}"/u);
  } finally {
    await sandbox.cleanup();
    temporary.cleanup();
  }
});

test("branch runner refuses hidden-state and extra-RNG replay mismatches before fork", async (t) => {
  for (const mismatch of ["hidden-state", "rng"] as const) {
    await t.test(mismatch, async () => {
      const temporary = store();
      const sandbox = sandboxFixture({
        supportsBranching: true,
        branchStep: 2,
        replayMismatch: mismatch
      });
      try {
        const result = await runPlaytestEpisode(
          runOptions(sandbox, temporary.artifacts, {
            branch: branchExecution()
          })
        );
        assert.equal(result.episode, null);
        assert.ok(result.failure);
        assert.ok(sandbox.sentMethods.includes("game.replay"));
        assert.equal(sandbox.sentMethods.includes("game.fork"), false);
        assert.equal(sandbox.sentMethods.includes("game.step"), false);
      } finally {
        await sandbox.cleanup();
        temporary.cleanup();
      }
    });
  }
});

test("branch runner keeps gameplay outcome but marks a corrupted retained snapshot incomplete", async () => {
  const temporary = store();
  const sandbox = sandboxFixture({
    supportsBranching: true,
    branchStep: 2,
    snapshotCorrupted: true
  });
  try {
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts, { branch: branchExecution() })
    );
    assert.ok(result.episode);
    assert.equal(result.episode.status, "completed");
    assert.equal(result.episode.completeness, "partial");
    assert.ok(result.episode.missingReasons.includes("infrastructure-failed"));
    assert.equal(result.episode.branchLineage?.snapshotArtifact, null);
    assert.match(
      result.episode.branchLineage?.snapshotIntegrityHash ?? "",
      /^[a-f0-9]{64}$/u
    );
  } finally {
    await sandbox.cleanup();
    temporary.cleanup();
  }
});

test("branch runner rechecks the alternative against current legal actions before executing", async () => {
  const temporary = store();
  const sandbox = sandboxFixture({
    supportsBranching: true,
    branchStep: 2,
    branchAlternativeNotLegal: true
  });
  try {
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts, {
        branch: branchExecution(2, "wait")
      })
    );
    assert.ok(
      result.episode,
      JSON.stringify({ failure: result.failure, methods: sandbox.sentMethods })
    );
    assert.notEqual(result.episode.status, "completed");
    assert.equal(result.episode.outcome, "unknown");
    assert.equal(sandbox.sentMethods.includes("game.fork"), true);
    assert.equal(sandbox.sentMethods.includes("game.step"), false);
  } finally {
    await sandbox.cleanup();
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

test("episode stores loop-guard reason and the unexecuted stopping step", async () => {
  const temporary = store();
  const sandbox = sandboxFixture({
    terminal: false,
    singleLegalAction: true
  });
  try {
    const result = await runPlaytestEpisode(
      runOptions(sandbox, temporary.artifacts)
    );
    assert.equal(result.failure?.category, "loop-guard");
    assert.equal(result.loopDetectedAtStep, 2);
    assert.equal(result.episode?.status, "budget-truncated");
    assert.deepEqual(result.episode?.termination, {
      reason: "loop-guard",
      step: 2
    });
    assert.equal(result.episode?.stepCount, 2);
    assert.equal(result.steps.at(-1)?.step, 2);
    assert.ok(result.traceReference);
    const traceLines = new TextDecoder()
      .decode(temporary.artifacts.readWindow(result.traceReference!).bytes)
      .trim()
      .split("\n");
    const stopEntry = JSON.parse(traceLines.at(-1)!) as {
      readonly step: number;
      readonly executed: boolean;
    };
    assert.equal(stopEntry.step, 2);
    assert.equal(stopEntry.executed, false);
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
