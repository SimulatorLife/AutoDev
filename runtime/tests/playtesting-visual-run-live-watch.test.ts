import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestBatch,
  type PlaytestEpisode,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import type { WorkspaceCatalogRead } from "@simulatorlife/autodev-data";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestRunControl,
  type PlaytestingRepositoryOps,
  type PlaytestRunControl
} from "../src/playtesting/mcp.ts";
import { handlePlaytestingControlApiRequest } from "../src/control-api/playtesting.ts";
import { inMemoryPlaytestLaunchIntentRepository } from "./support/playtesting-launch-intents.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

const WORKSPACE = "SimulatorLife/RacingGame";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr0sAAAAASUVORK5CYII=",
  "base64"
);

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
      maxStepsPerEpisode: 1,
      wallTimeMs: 30_000,
      smartRequestsPerEpisode: 1,
      smartTokensPerEpisode: 2000,
      screenshotCountPerEpisode: 2,
      artifactBytesPerEpisode: 2 * 1024 * 1024
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

test(
  "visual run persists a media-readable frame before Smart-direct responds",
  { timeout: 60_000 },
  async () => {
    const gameServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><html><body><main><h1>Race setup</h1><button>Start race</button></main></body></html>"
      );
    });
    const gamePort = await listen(gameServer);

    const routerResponses: ServerResponse[] = [];
    let releasePolicy: (() => void) | null = null;
    const policyRequested = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const routerServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        assert.equal(request.url, "/v1/responses");
        assert.equal(
          request.headers.authorization,
          "Bearer fixture-router-token"
        );
        routerResponses.push(response);
        releasePolicy?.();
      });
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
        limits: target.limits
      });
      assert.equal(started.assignmentCount, 1);
      assert.equal(started.status, "running");
      assert.ok(started.batchId);

      await Promise.race([
        policyRequested,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Smart-direct was not called.")),
            20_000
          )
        )
      ]);
      const episodeId =
        "ep-" +
        started.batchId.replace(/^batch-/u, "").slice(0, 16) +
        "-vis-assign-" +
        started.batchId.replace(/^batch-/u, "").slice(0, 12) +
        "-0";
      let liveEpisode: PlaytestEpisode | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        liveEpisode = episodeRows.get(episodeId) ?? null;
        if (liveEpisode?.status === "started" && liveEpisode.frames.length > 0)
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
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

      const heldRouterResponse = routerResponses[0];
      assert.ok(
        heldRouterResponse,
        "the fake router should receive the decision request"
      );
      heldRouterResponse.writeHead(200, { "content-type": "application/json" });
      heldRouterResponse.end(
        JSON.stringify({
          model: "fixture-smart-model",
          output_text: JSON.stringify({
            decision: "stop",
            intention: "Stop after inspecting the visible race setup.",
            prediction: "The race setup menu will remain visible.",
            reasonCode: "objective-achieved",
            action: null,
            stopReason: "objective-achieved"
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
      const completedEpisode = episodeRows.get(episodeId);
      assert.ok(completedEpisode?.trace);
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
            "&startStep=0&endStep=0"
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
      const traceEntry = windowBody.entries[0] as Record<string, unknown>;
      assert.equal(
        typeof (traceEntry.visibleObservation as Record<string, unknown>)
          .capturedAt,
        "string"
      );
      assert.equal(
        (traceEntry.authoritativeOutcome as Record<string, unknown>).actionKind,
        undefined,
        "the policy stopped without dispatching an action"
      );
    } finally {
      const heldRouterResponse = routerResponses[0];
      if (heldRouterResponse && !heldRouterResponse.writableEnded) {
        heldRouterResponse.writeHead(200, {
          "content-type": "application/json"
        });
        heldRouterResponse.end(
          JSON.stringify({
            model: "fixture-smart-model",
            output_text: JSON.stringify({
              decision: "stop",
              intention: "Stop after inspecting the visible race setup.",
              prediction: "The race setup menu will remain visible.",
              reasonCode: "objective-achieved",
              action: null,
              stopReason: "objective-achieved"
            }),
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
          })
        );
      }
      if (previousPort === undefined)
        delete process.env.CODEX_MODEL_ROUTER_PORT;
      else process.env.CODEX_MODEL_ROUTER_PORT = previousPort;
      if (previousToken === undefined)
        delete process.env.CODEX_ROUTER_AUTH_TOKEN;
      else process.env.CODEX_ROUTER_AUTH_TOKEN = previousToken;
      await runControl.shutdown();
      await closeServer(gameServer);
      await closeServer(routerServer);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
);
