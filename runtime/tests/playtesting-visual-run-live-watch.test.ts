import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestBatch,
  type PlaytestEpisode,
  type PlaytestVisualBatch,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import type { WorkspaceCatalogRead } from "@simulatorlife/autodev-data";

import { handlePlaytestingControlApiRequest } from "../src/control-api/playtesting.ts";
import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestRunControl,
  type PlaytestingRepositoryOps
} from "../src/playtesting/mcp.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";
import { inMemoryPlaytestLaunchIntentRepository } from "./support/playtesting-launch-intents.ts";

const WORKSPACE = "SimulatorLife/RacingGame";

function workspaceCatalog(): WorkspaceCatalogRead {
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

function approvedTarget(
  entryUrl: string
): WorkspaceVisualPlaytestTargetApproval {
  const origin = new URL(entryUrl).origin;
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE,
    targetId: "local-fixture",
    revision: 1,
    approvalId: "approval-fixture-1",
    name: "Local visual fixture",
    entryUrl,
    allowedOrigins: [origin],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 4,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 4,
      smartTokensPerEpisode: 4000,
      screenshotCountPerEpisode: 5,
      artifactBytesPerEpisode: 4 * 1024 * 1024
    },
    approvedAt: "2026-10-17T12:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
}

async function listen(
  server: ReturnType<typeof createServer>
): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server did not bind a TCP port.");
  }
  return address.port;
}

async function closeServer(
  server: ReturnType<typeof createServer>
): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** A gate the fixture router opens when the expected decision request arrives. */
interface FixtureRequestSignal {
  readonly requested: Promise<void>;
  readonly release: () => void;
}

function createRequestSignal(): FixtureRequestSignal {
  let release: (() => void) | null = null;
  const requested = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    requested,
    release: () => {
      release?.();
    }
  };
}

/** Wait for the expected request, and fail the wait when it never arrives. */
function withTimeout<T>(
  requested: Promise<T>,
  message: string,
  timeoutMs: number
): Promise<T> {
  return Promise.race([
    requested,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);
    })
  ]);
}

/** The fixture game page the visual run drives. */
function createGameFixtureServer(): Server {
  return createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><html><body><main><h1>Race setup</h1><button>Start race</button></main></body></html>"
    );
  });
}

/** The fixture model router that answers the Smart-direct decision requests. */
interface FixtureRouter {
  readonly server: Server;
  readonly responses: ServerResponse[];
  readonly bodies: Record<string, unknown>[];
}

function createFixtureRouter(
  onRequest: (index: number) => void
): FixtureRouter {
  const responses: ServerResponse[] = [];
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      assert.equal(request.url, "/v1/responses");
      assert.equal(
        request.headers.authorization,
        "Bearer fixture-router-token"
      );
      bodies.push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >
      );
      responses.push(response);
      onRequest(responses.length);
    });
  });
  return { server, responses, bodies };
}

/** Wait until the persisted episode satisfies the fixture's expectation. */
async function waitForEpisode(
  episodeRows: ReadonlyMap<string, PlaytestEpisode>,
  episodeId: string,
  isReady: (episode: PlaytestEpisode) => boolean
): Promise<PlaytestEpisode | null> {
  let observed: PlaytestEpisode | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    observed = episodeRows.get(episodeId) ?? null;
    if (observed && isReady(observed)) break;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  return observed;
}

/** The control id the decision request offered to the model. */
function readFirstVisibleControlId(
  request: Record<string, unknown>
): string | undefined {
  const input = request.input as readonly {
    readonly content: readonly { readonly text?: string }[];
  }[];
  const visibleState = JSON.parse(String(input[0]?.content[0]?.text)) as {
    readonly controls: readonly { readonly controlId: string }[];
  };
  return visibleState.controls[0]?.controlId;
}

/** Answer every router response the fixture still holds open. */
function releaseHeldRouterResponses(
  responses: readonly ServerResponse[]
): void {
  for (const heldRouterResponse of responses) {
    if (heldRouterResponse.writableEnded) continue;
    heldRouterResponse.writeHead(200, {
      "content-type": "application/json"
    });
    heldRouterResponse.end(
      JSON.stringify({
        model: "fixture-smart-model",
        output_text: JSON.stringify({
          decision: "stop",
          intention: "Stop because the fixture is cleaning up.",
          prediction: "No further action is expected.",
          reasonCode: "fixture-cleanup",
          action: null,
          stopReason: "cannot-proceed",
          focusReport: {
            objective: null,
            inScope: [],
            forbiddenScope: [],
            stopCriteria: [],
            outcome: "unknown",
            summary: "The fixture ended without an objective assessment.",
            evidenceSteps: []
          }
        }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      })
    );
  }
}

/** Put one environment variable back the way the test found it. */
function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test(
  "visual reports persist checkpoints and cold-owner recovery preserves partial or unavailable state",
  { timeout: 60_000 },
  async () => {
    const gameServer = createGameFixtureServer();
    const gamePort = await listen(gameServer);

    const policySignal = createRequestSignal();
    const secondPolicySignal = createRequestSignal();
    const thirdPolicySignal = createRequestSignal();
    const {
      server: routerServer,
      responses: routerResponses,
      bodies: routerBodies
    } = createFixtureRouter((index) => {
      if (index === 1) policySignal.release();
      if (index === 2) secondPolicySignal.release();
      if (index === 3) thirdPolicySignal.release();
    });
    const routerPort = await listen(routerServer);
    const previousPort = process.env.CODEX_MODEL_ROUTER_PORT;
    const previousToken = process.env.CODEX_ROUTER_AUTH_TOKEN;
    process.env.CODEX_MODEL_ROUTER_PORT = String(routerPort);
    process.env.CODEX_ROUTER_AUTH_TOKEN = "fixture-router-token";

    const tempRoot = mkdtempSync(path.join(tmpdir(), "visual-run-live-watch-"));
    const artifactRoot = path.join(tempRoot, "artifacts");
    mkdirSync(artifactRoot, { mode: 0o700 });
    const artifacts = new PlaytestArtifactStore({
      workspaceId: WORKSPACE,
      rootDirectory: artifactRoot
    });
    const batchRows = new Map<string, PlaytestBatch>();
    const episodeRows = new Map<string, PlaytestEpisode>();
    const repository = {
      getBatch: async (_workspaceId: string, batchId: string) =>
        batchRows.get(batchId) ?? null,
      insertBatch: async (batch: PlaytestBatch) => {
        assert.deepEqual(
          batch.unobservedAssignments,
          [],
          "A newly frozen visual inventory persists an explicit empty no-episode outcome list."
        );
        batchRows.set(batch.batchId, batch);
      },
      getEpisode: async (_workspaceId: string, episodeId: string) =>
        episodeRows.get(episodeId) ?? null,
      insertEpisode: async (episode: PlaytestEpisode) => {
        episodeRows.set(episode.episodeId, episode);
      },
      listBatches: async () => ({
        rows: [...batchRows.values()],
        total: batchRows.size,
        nextCursor: null
      }),
      listEpisodes: async () => ({
        rows: [...episodeRows.values()],
        total: episodeRows.size,
        nextCursor: null
      })
    } as unknown as PlaytestingRepositoryOps;
    const target = approvedTarget("http://127.0.0.1:" + String(gamePort) + "/");
    const runControl = createPlaytestRunControl({
      artifactStoreForWorkspace: () => artifacts,
      playtestRepository: repository,
      launchIntentRepository: inMemoryPlaytestLaunchIntentRepository(),
      visualTargetRepository: {
        read: (_workspaceId: string, targetId: string) =>
          targetId === target.targetId ? target : null,
        list: () => [target]
      } as unknown as NonNullable<
        Parameters<typeof createPlaytestRunControl>[0]["visualTargetRepository"]
      >,
      readWorkspaceCatalog: workspaceCatalog
    });
    const session = {
      workspaceId: WORKSPACE,
      role: "playtester",
      actor: "playtester-1",
      taskId: "task-1",
      runId: "run-1"
    };
    let restartedRunControl: ReturnType<
      typeof createPlaytestRunControl
    > | null = null;
    try {
      const started = await runControl.startRun(session, {
        schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
        mode: "autonomous-visual",
        workspaceId: WORKSPACE,
        requestId: "visual-live-watch-1",
        capabilityRevision: "a".repeat(64),
        targetId: target.targetId,
        policyId: "smart-direct",
        areasOfFocus: "Inspect the race setup screen.",
        limits: {
          ...target.limits,
          maxStepsPerEpisode: 2,
          wallTimeMs: 30_000,
          smartRequestsPerEpisode: 2,
          smartTokensPerEpisode: 500,
          screenshotCountPerEpisode: 3,
          artifactBytesPerEpisode: 2 * 1024 * 1024
        }
      });
      assert.equal(started.assignmentCount, 1);
      assert.equal(started.status, "running");
      assert.ok(started.batchId);

      await withTimeout(
        policySignal.requested,
        "Smart-direct was not called.",
        20_000
      );
      const episodeId =
        "ep-" +
        started.batchId.replace(/^batch-/u, "").slice(0, 16) +
        "-vis-assign-" +
        started.batchId.replace(/^batch-/u, "").slice(0, 12) +
        "-0";
      const liveEpisode = await waitForEpisode(
        episodeRows,
        episodeId,
        (episode) => episode.status === "started" && episode.frames.length > 0
      );
      assert.ok(liveEpisode);
      assert.equal(liveEpisode.status, "started");
      assert.equal(liveEpisode.stepCount, 0);
      const liveFrame = liveEpisode.frames[0];
      assert.ok(liveFrame);
      const frameReference = artifacts.referenceForId(liveFrame.id);
      assert.ok(frameReference);
      const frameBytes = artifacts.readArtifact(frameReference).bytes;
      assert.deepEqual(
        [...frameBytes.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      );

      const response = responseRecorder();
      const mediaPath =
        "/control/playtesting/episodes/" +
        encodeURIComponent(episodeId) +
        "/media/" +
        encodeURIComponent(liveFrame.id);
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "GET",
          mediaPath + "?workspaceId=" + encodeURIComponent(WORKSPACE)
        ),
        response as unknown as ServerResponse,
        mediaPath,
        { actor: "console-viewer", role: "viewer" },
        {
          repository: {
            getEpisode: async () => liveEpisode
          } as never,
          artifactStoreForWorkspace: () => artifacts,
          readWorkspaceCatalog: workspaceCatalog
        }
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "image/png");
      assert.equal(response.headers["content-length"], frameReference.bytes);

      const firstRouterResponse = routerResponses[0];
      assert.ok(
        firstRouterResponse,
        "the fake router should receive the first decision request"
      );
      const firstRequest = routerBodies[0];
      assert.ok(firstRequest);
      assert.equal(
        firstRequest.max_output_tokens,
        500,
        "Smart-direct must use the request's reduced token budget, not the larger target ceiling."
      );
      const startControlId = readFirstVisibleControlId(firstRequest);
      assert.ok(startControlId);
      firstRouterResponse.writeHead(200, {
        "content-type": "application/json"
      });
      firstRouterResponse.end(
        JSON.stringify({
          model: "fixture-smart-model",
          output_text: JSON.stringify({
            decision: "act",
            intention: "Open the visible race setup control.",
            prediction: "The race screen may replace the setup screen.",
            reasonCode: "inspect-setup",
            action: { kind: "activate-control", controlId: startControlId },
            stopReason: null,
            focusReport: null
          }),
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120
          }
        })
      );

      await withTimeout(
        secondPolicySignal.requested,
        "The second Smart-direct decision was not called.",
        20_000
      );
      assert.equal(
        routerBodies[1]?.max_output_tokens,
        380,
        "Smart-direct must subtract the first response usage from the reduced per-episode token budget."
      );
      const checkpointEpisode = await waitForEpisode(
        episodeRows,
        episodeId,
        (episode) => episode.playerDebrief.status === "partial"
      );
      assert.equal(checkpointEpisode?.playerDebrief.status, "partial");
      if (checkpointEpisode?.playerDebrief.status !== "partial") return;
      assert.equal(
        checkpointEpisode.playerDebrief.checkpoint.intention,
        "Open the visible race setup control."
      );
      assert.deepEqual(checkpointEpisode.playerDebrief.checkpoint.evidence, {
        kind: "frame",
        id: frameReference.artifactId,
        step: 0,
        frameIndex: 0
      });

      const secondRouterResponse = routerResponses[1];
      assert.ok(
        secondRouterResponse,
        "the fake router should receive the stop decision"
      );
      secondRouterResponse.writeHead(200, {
        "content-type": "application/json"
      });
      secondRouterResponse.end(
        JSON.stringify({
          model: "fixture-smart-model",
          output_text: JSON.stringify({
            decision: "stop",
            intention: "The setup remains visible, so stop safely.",
            prediction: "The setup menu will remain visible.",
            reasonCode: "objective-achieved",
            action: null,
            stopReason: "objective-achieved",
            focusReport: {
              objective: "Inspect the race setup screen.",
              inScope: ["Visible setup menu"],
              forbiddenScope: ["Starting the race"],
              stopCriteria: ["Stop with setup menu visible."],
              outcome: "achieved",
              summary: "The setup menu is visible; I stopped before racing.",
              evidenceSteps: [0, 1]
            }
          }),
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120
          }
        })
      );
      const finalStatus = await runControl.waitForRun(
        session,
        WORKSPACE,
        started.batchId,
        30_000
      );
      assert.equal(finalStatus.status, "completed");
      assert.equal(
        routerResponses.length,
        2,
        "the report reuses the terminal decision instead of adding a model request"
      );
      const completedEpisode = episodeRows.get(episodeId);
      assert.ok(completedEpisode?.trace);
      assert.equal(completedEpisode.playerDebrief.status, "complete");
      assert.equal(
        completedEpisode.outcome,
        "unknown",
        "a player-reported focus outcome never becomes a verified game outcome"
      );
      if (completedEpisode.playerDebrief.status !== "complete") return;
      assert.equal(
        completedEpisode.playerDebrief.focusInterpretation.outcome,
        "achieved"
      );
      assert.equal(
        completedEpisode.playerDebrief.focusInterpretation.requestedFocus,
        "Inspect the race setup screen."
      );
      const secondFrame = completedEpisode.frames[1];
      assert.ok(secondFrame);
      assert.deepEqual(
        completedEpisode.playerDebrief.focusInterpretation.evidence,
        [
          {
            kind: "frame",
            id: frameReference.artifactId,
            step: 0,
            frameIndex: 0
          },
          {
            kind: "frame",
            id: secondFrame.id,
            step: 1,
            frameIndex: 1
          }
        ]
      );
      assert.equal(completedEpisode?.trace.kind, "replay-segment");
      const tracePath =
        "/control/playtesting/episodes/" +
        encodeURIComponent(episodeId) +
        "/windows/" +
        encodeURIComponent(completedEpisode.trace.id);
      const traceResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "GET",
          tracePath +
            "?workspaceId=" +
            encodeURIComponent(WORKSPACE) +
            "&startStep=0&endStep=1"
        ),
        traceResponse as unknown as ServerResponse,
        tracePath,
        { actor: "console-viewer", role: "viewer" },
        {
          repository: {
            getEpisode: async () => completedEpisode
          } as never,
          artifactStoreForWorkspace: () => artifacts,
          readWorkspaceCatalog: workspaceCatalog
        }
      );
      assert.equal(traceResponse.statusCode, 200);
      const windowBody = responseBody(traceResponse);
      assert.ok(Array.isArray(windowBody?.entries));
      assert.equal(windowBody.entries.length, 2);
      const traceEntry = windowBody.entries[0] as Record<string, unknown>;
      assert.equal(
        typeof (traceEntry.visibleObservation as Record<string, unknown>)
          .capturedAt,
        "string"
      );
      assert.equal(
        (traceEntry.authoritativeOutcome as Record<string, unknown>).actionKind,
        "activate-control",
        "the first admitted decision is recorded as an action"
      );
      const stopEntry = windowBody.entries[1] as Record<string, unknown>;
      assert.equal(
        (stopEntry.authoritativeOutcome as Record<string, unknown>).stopReason,
        "objective-achieved"
      );

      const interruptedRun = await runControl.startRun(session, {
        schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
        mode: "autonomous-visual",
        workspaceId: WORKSPACE,
        requestId: "visual-live-watch-router-failure",
        capabilityRevision: "a".repeat(64),
        targetId: target.targetId,
        policyId: "smart-direct",
        areasOfFocus: "Inspect the race setup screen.",
        limits: target.limits
      });
      await withTimeout(
        thirdPolicySignal.requested,
        "The failure-injection Smart request was not called.",
        20_000
      );
      const failedPolicyResponse = routerResponses[2];
      assert.ok(failedPolicyResponse);
      failedPolicyResponse.writeHead(503, {
        "content-type": "application/json"
      });
      failedPolicyResponse.end(
        JSON.stringify({ error: "fixture router unavailable" })
      );

      const failedRunStatus = await runControl.waitForRun(
        session,
        WORKSPACE,
        interruptedRun.batchId,
        30_000
      );
      assert.equal(failedRunStatus.status, "failed");
      const failedEpisodeId =
        "ep-" +
        interruptedRun.batchId.replace(/^batch-/u, "").slice(0, 16) +
        "-vis-assign-" +
        interruptedRun.batchId.replace(/^batch-/u, "").slice(0, 12) +
        "-0";
      const failedEpisode = episodeRows.get(failedEpisodeId);
      assert.ok(failedEpisode);
      assert.equal(failedEpisode.status, "infrastructure-failed");
      assert.deepEqual(failedEpisode.playerDebrief, {
        schema: "autodev-playtest-player-debrief-v1",
        status: "unavailable",
        reason: "interrupted-before-checkpoint"
      });
      assert.equal(failedEpisode.outcome, "unknown");

      const completedBatch = batchRows.get(started.batchId);
      assert.ok(completedBatch?.executionMode === "autonomous-visual");
      const checkpointSnapshot: PlaytestEpisode = {
        ...checkpointEpisode,
        revision: completedEpisode.revision + 1,
        status: "started",
        termination: { reason: "unknown", step: null },
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
        completedAt: null,
        completeness: "partial",
        missingReasons: []
      };
      const runningCheckpointBatch: PlaytestVisualBatch = {
        ...completedBatch,
        revision: completedBatch.revision + 1,
        status: "running",
        cancellationReason: null,
        failureReason: null,
        counts: {
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
        completedAt: null
      };
      batchRows.set(started.batchId, runningCheckpointBatch);
      episodeRows.set(episodeId, checkpointSnapshot);

      const recoveryRepository: PlaytestingRepositoryOps = {
        ...repository,
        listBatches: async (filter) => {
          const rows = [...batchRows.values()].filter(
            (batch) =>
              batch.workspaceId === filter.workspaceId &&
              (filter.status === undefined || batch.status === filter.status)
          );
          return { rows, total: rows.length, nextCursor: null };
        },
        listEpisodes: async (filter) => {
          const rows = [...episodeRows.values()].filter(
            (episode) =>
              episode.identity.workspaceId === filter.workspaceId &&
              (filter.batchId === undefined ||
                episode.batchId === filter.batchId)
          );
          return { rows, total: rows.length, nextCursor: null };
        }
      };
      restartedRunControl = createPlaytestRunControl({
        artifactStoreForWorkspace: () => artifacts,
        playtestRepository: recoveryRepository,
        launchIntentRepository: inMemoryPlaytestLaunchIntentRepository(),
        visualTargetRepository: {
          read: (_workspaceId: string, targetId: string) =>
            targetId === target.targetId ? target : null,
          list: () => [target]
        } as unknown as NonNullable<
          Parameters<
            typeof createPlaytestRunControl
          >[0]["visualTargetRepository"]
        >,
        readWorkspaceCatalog: workspaceCatalog
      });
      assert.deepEqual(
        await restartedRunControl.listActiveRuns(session, WORKSPACE),
        []
      );
      const recoveredCheckpointEpisode = episodeRows.get(episodeId);
      const recoveredCheckpointBatch = batchRows.get(started.batchId);
      assert.equal(recoveredCheckpointEpisode?.status, "infrastructure-failed");
      assert.equal(recoveredCheckpointEpisode?.playerDebrief.status, "partial");
      if (recoveredCheckpointEpisode?.playerDebrief.status !== "partial") {
        return;
      }
      assert.equal(
        recoveredCheckpointEpisode.playerDebrief.reason,
        "episode-interrupted"
      );
      assert.equal(
        recoveredCheckpointEpisode.revision,
        checkpointSnapshot.revision + 1
      );
      assert.equal(recoveredCheckpointBatch?.status, "failed");
      assert.equal(
        recoveredCheckpointBatch?.failureReason,
        "nonterminal-batch-recovered"
      );

      const noCheckpointSnapshot: PlaytestEpisode = {
        ...failedEpisode,
        revision: failedEpisode.revision + 1,
        status: "started",
        termination: { reason: "unknown", step: null },
        trace: null,
        stepCount: 0,
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
        completedAt: null,
        completeness: "unknown",
        missingReasons: [],
        playerDebrief: {
          schema: "autodev-playtest-player-debrief-v1",
          status: "pending",
          reason: "episode-in-progress"
        }
      };
      const failedBatch = batchRows.get(interruptedRun.batchId);
      assert.ok(failedBatch?.executionMode === "autonomous-visual");
      const runningWithoutCheckpoint: PlaytestVisualBatch = {
        ...failedBatch,
        revision: failedBatch.revision + 1,
        status: "running",
        cancellationReason: null,
        failureReason: null,
        counts: {
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
        completedAt: null
      };
      batchRows.set(interruptedRun.batchId, runningWithoutCheckpoint);
      episodeRows.set(failedEpisodeId, noCheckpointSnapshot);
      assert.deepEqual(
        await restartedRunControl.listActiveRuns(session, WORKSPACE),
        []
      );
      const unavailableEpisode = episodeRows.get(failedEpisodeId);
      assert.equal(unavailableEpisode?.status, "infrastructure-failed");
      assert.deepEqual(unavailableEpisode?.playerDebrief, {
        schema: "autodev-playtest-player-debrief-v1",
        status: "unavailable",
        reason: "interrupted-before-checkpoint"
      });
      assert.equal(batchRows.get(interruptedRun.batchId)?.status, "failed");
    } finally {
      releaseHeldRouterResponses(routerResponses);
      restoreEnvironment("CODEX_MODEL_ROUTER_PORT", previousPort);
      restoreEnvironment("CODEX_ROUTER_AUTH_TOKEN", previousToken);
      await runControl.shutdown();
      await restartedRunControl?.shutdown();
      await closeServer(gameServer);
      await closeServer(routerServer);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
);
