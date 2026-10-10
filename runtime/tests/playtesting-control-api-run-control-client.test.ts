import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestControlApiRunClient,
  playtestControlApiRunClientFromEnvironment
} from "../src/playtesting/control-api-run-control-client.ts";
import {
  createPlaytestMcpServer,
  PlaytestMcpAuthorizationError,
  type PlaytestMcpSession,
  PlaytestMcpUnavailableError,
  type PlaytestRunControl
} from "../src/playtesting/mcp.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const WORKSPACE = "fixture/game";
const SESSION: PlaytestMcpSession = {
  workspaceId: WORKSPACE,
  role: "playtester",
  actor: "agent-1",
  taskId: "task-1",
  runId: "run-1"
};

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

test("Playtest Control API client forwards typed run operations and host-bound session identity", async () => {
  const calls: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: string | null;
  }> = [];
  const responses = [
    {
      schema: "autodev-control-playtesting-capabilities-v1",
      workspaceId: WORKSPACE,
      workspaceCatalog: "valid",
      workspaceEnabled: true,
      operatorActionsAvailable: true,
      approved: true,
      approvalRevision: 1,
      buildSha: "a".repeat(40),
      gameBuild: "fixture-build",
      allowedScenarios: ["tutorial"],
      approvedPolicies: ["random"],
      supportedPolicies: ["random"],
      runnablePolicies: ["random"],
      unsupportedApprovedPolicies: [],
      configurationStatus: "validated",
      runnableAssignments: [
        {
          scenarioId: "tutorial",
          scenarioFamily: "tutorial",
          policyId: "random",
          policyVersion: "hmac-sha256-v1",
          cohort: "exploratory",
          strategy: "uniform-legal-action",
          maxStepsPerEpisode: 20
        }
      ],
      policyProfiles: [
        {
          policyId: "random",
          version: "hmac-sha256-v1",
          cohort: "exploratory",
          strategy: "uniform-legal-action"
        }
      ],
      limits: {
        cpuCores: 1,
        memoryBytes: 64 * 1024 * 1024,
        processCount: 8,
        wallTimeMs: 60_000,
        artifactBytes: 1024 * 1024,
        workerCount: 1,
        episodeCount: 10,
        maxStepsPerEpisode: 20,
        critiqueCount: 0
      },
      issueReporting: "disabled",
      humanStudyAllowed: false,
      revokedAt: null,
      runPreflight: "required-at-start"
    },
    {
      schema: "autodev-control-playtesting-run-started-v1",
      workspaceId: WORKSPACE,
      batchId: "batch-1",
      status: "running"
    },
    {
      schema: "autodev-control-playtesting-runs-v1",
      workspaceId: WORKSPACE,
      runs: [
        {
          batchId: "batch-1",
          scenarioId: "tutorial",
          createdAt: "2026-10-10T00:00:00Z"
        }
      ]
    },
    {
      schema: "autodev-control-playtesting-run-status-v1",
      workspaceId: WORKSPACE,
      run: {
        batchId: "batch-1",
        status: "completed",
        cancellationReason: null,
        result: { episodeId: "episode-1", outcome: "win" },
        error: null
      }
    },
    {
      schema: "autodev-control-playtesting-run-cancellation-v1",
      workspaceId: WORKSPACE,
      batchId: "batch-1",
      cancellationRequested: false
    }
  ];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null
    });
    return jsonResponse(responses.shift());
  };
  const client = createPlaytestControlApiRunClient({
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "private-service-token",
    actor: "playtest-runtime",
    sessionRole: "playtester",
    fetcher
  });

  const capabilities = await client.getCapabilities(SESSION, WORKSPACE);
  assert.equal(capabilities.runnablePolicies[0], "random");
  const started = await client.startRun(SESSION, {
    scenario: "tutorial",
    policy: "random",
    seed: "seed-1"
  });
  assert.deepEqual(started, { batchId: "batch-1", status: "running" });
  const listed = await client.listActiveRuns(SESSION, WORKSPACE);
  assert.equal(listed.length, 1);
  const status = await client.waitForRun(SESSION, WORKSPACE, "batch-1", 100);
  assert.equal(status.status, "completed");
  const cancellation = await client.cancelRun(SESSION, WORKSPACE, "batch-1");
  assert.deepEqual(cancellation, {
    batchId: "batch-1",
    cancellationRequested: false
  });

  assert.equal(calls.length, 5);
  assert.match(
    calls[0]!.url,
    /\/control\/playtesting\/capabilities\?workspaceId=fixture%2Fgame/u
  );
  assert.equal(calls[1]!.method, "POST");
  assert.deepEqual(JSON.parse(calls[1]!.body!), {
    scenario: "tutorial",
    policy: "random",
    seed: "seed-1",
    workspaceId: WORKSPACE
  });
  for (const call of calls) {
    assert.equal(
      call.headers.get("authorization"),
      "Bearer private-service-token"
    );
    assert.equal(call.headers.get("x-autodev-actor"), "playtest-runtime");
    const session = JSON.parse(
      Buffer.from(
        call.headers.get("x-autodev-playtest-session")!,
        "base64url"
      ).toString("utf8")
    );
    assert.deepEqual(session, SESSION);
    assert.equal(new URL(call.url).hostname, "127.0.0.1");
  }
  assert.match(
    calls[2]!.url,
    /\/control\/playtesting\/runs\?workspaceId=fixture%2Fgame/u
  );
  assert.match(
    calls[3]!.url,
    /batch-1\?workspaceId=fixture%2Fgame&waitMs=100/u
  );
  assert.match(calls[4]!.url, /batch-1\/cancel\?workspaceId=fixture%2Fgame/u);
});

test("Playtest Control API client fails closed for non-loopback URLs and incomplete host credentials", () => {
  assert.throws(
    () =>
      createPlaytestControlApiRunClient({
        baseUrl: "https://api.example.com",
        serviceToken: "token",
        actor: "playtest-runtime",
        sessionRole: "playtester"
      }),
    /loopback/u
  );
  const configured = playtestControlApiRunClientFromEnvironment({
    AUTODEV_CONTROL_API_BASE_URL: "http://127.0.0.1:4101",
    AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "token",
    AUTODEV_PLAYTEST_CONTROL_API_ACTOR: "playtest-runtime",
    AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtester",
    AUTODEV_PLAYTEST_ROLE: "playtester"
  });
  assert.equal(typeof configured.startRun, "function");
  assert.throws(
    () =>
      playtestControlApiRunClientFromEnvironment({
        AUTODEV_CONTROL_API_BASE_URL: "http://127.0.0.1:4101",
        AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "token",
        AUTODEV_PLAYTEST_CONTROL_API_ACTOR: "playtest-runtime",
        AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtester"
      }),
    PlaytestMcpUnavailableError
  );
});

test("Playtest Control API client converts typed authorization errors without leaking responses", async () => {
  const fetcher: typeof fetch = async () =>
    jsonResponse(
      {
        error: {
          code: "autodev_control_playtesting_forbidden",
          message:
            "The trusted playtest session is not authorized for this workspace."
        }
      },
      403
    );
  const client = createPlaytestControlApiRunClient({
    baseUrl: "http://localhost:4101",
    serviceToken: "token",
    actor: "playtest-runtime",
    sessionRole: "playtester",
    fetcher
  });
  await assert.rejects(
    client.waitForRun(SESSION, WORKSPACE, "batch-1", 0),
    PlaytestMcpAuthorizationError
  );
});

test("Playtesting MCP delegates run lifecycle through the authenticated shared Control API owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "playtesting-remote-owner-"));
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  const repositoryRoot = path.join(root, "repo");
  mkdirSync(path.join(repositoryRoot, "config"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, "config", "workspaces.json"),
    JSON.stringify({
      schema: "autodev-workspaces-v1",
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ]
    }),
    "utf8"
  );
  const oldToken = process.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN;
  const oldActor = process.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR;
  const oldRole = process.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE;
  const token = "scoped-token-for-mcp-test";
  const actor = "playtester-agent";
  process.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN = token;
  process.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR = actor;
  process.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE = "playtester";
  const session: PlaytestMcpSession = {
    workspaceId: WORKSPACE,
    role: "playtester",
    actor,
    taskId: "task-remote-1",
    runId: "run-remote-1"
  };
  const delegated: unknown[] = [];
  const runOwner: PlaytestRunControl = {
    getCapabilities: (_receivedSession, workspaceId) => ({
      workspaceId,
      workspaceEnabled: true,
      workspaceCatalog: "valid",
      approved: true,
      approvalRevision: 1,
      buildSha: "a".repeat(40),
      gameBuild: "fixture-build",
      allowedScenarios: ["tutorial"],
      approvedPolicies: ["random"],
      supportedPolicies: ["random"],
      runnablePolicies: ["random"],
      unsupportedApprovedPolicies: [],
      configurationStatus: "validated",
      runnableAssignments: [
        {
          scenarioId: "tutorial",
          scenarioFamily: "tutorial",
          policyId: "random",
          policyVersion: "hmac-sha256-v1",
          cohort: "exploratory",
          strategy: "uniform-legal-action",
          maxStepsPerEpisode: 20
        }
      ],
      policyProfiles: [
        {
          policyId: "random",
          version: "hmac-sha256-v1",
          cohort: "exploratory",
          strategy: "uniform-legal-action"
        }
      ],
      limits: {
        cpuCores: 1,
        memoryBytes: 64 * 1024 * 1024,
        processCount: 8,
        wallTimeMs: 60_000,
        artifactBytes: 1024 * 1024,
        workerCount: 1,
        episodeCount: 10,
        maxStepsPerEpisode: 20,
        critiqueCount: 0
      },
      issueReporting: "disabled",
      humanStudyAllowed: false,
      revokedAt: null,
      runPreflight: "required-at-start"
    }),
    async startRun(receivedSession, request) {
      delegated.push({ operation: "start", session: receivedSession, request });
      return { batchId: "batch-remote-1", status: "running" };
    },
    listActiveRuns(receivedSession, workspaceId) {
      delegated.push({
        operation: "list",
        session: receivedSession,
        workspaceId
      });
      return [
        {
          batchId: "batch-remote-1",
          scenarioId: "tutorial",
          createdAt: "2026-10-10T00:00:00.000Z"
        }
      ];
    },
    async waitForRun(receivedSession, workspaceId, batchId, waitMs) {
      delegated.push({
        operation: "wait",
        session: receivedSession,
        workspaceId,
        batchId,
        waitMs
      });
      return {
        batchId,
        status: "completed",
        cancellationReason: null,
        result: { episodeId: "episode-remote-1", outcome: "win" },
        error: null
      };
    },
    cancelRun(receivedSession, workspaceId, batchId) {
      delegated.push({
        operation: "cancel",
        session: receivedSession,
        workspaceId,
        batchId
      });
      return { batchId, cancellationRequested: true };
    }
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const requestBody = typeof init?.body === "string" ? init.body : "";
    const request = Object.assign(
      Readable.from(requestBody.length === 0 ? [] : [requestBody]),
      {
        method: init?.method ?? "GET",
        url: url.pathname + url.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries())
      }
    ) as IncomingMessage;
    const response = responseRecorder();
    const handled = await handleControlApiRequest(
      request,
      response as unknown as ServerResponse,
      url.pathname,
      {
        repositoryRoot,
        playtestingRunControl: runOwner
      }
    );
    assert.equal(handled, true);
    return Response.json(JSON.parse(response.body || "{}"), {
      status: response.statusCode
    });
  };
  try {
    const runControl = createPlaytestControlApiRunClient({
      baseUrl: "http://127.0.0.1:4101",
      serviceToken: token,
      actor,
      sessionRole: "playtester",
      fetcher
    });
    const artifacts = new PlaytestArtifactStore({
      workspaceId: WORKSPACE,
      rootDirectory: path.join(root, "artifacts")
    });
    const mcp = createPlaytestMcpServer({
      sessionProvider: { current: () => session },
      artifactStoreForWorkspace: () => artifacts,
      playtestRunControl: runControl
    });
    const tool = (name: string) => (mcp as any)._registeredTools[name].handler;

    const runResponse = await tool("playtest.run")({
      scenario: "tutorial",
      policy: "random",
      seed: "remote-seed"
    });
    const run = JSON.parse(runResponse.content[0].text);
    assert.deepEqual(run, { batchId: "batch-remote-1", status: "running" });

    const activeResponse = await tool("playtest.activeRuns")({});
    assert.equal(
      activeResponse.isError,
      undefined,
      activeResponse.content[0].text
    );
    assert.equal(JSON.parse(activeResponse.content[0].text).runs.length, 1);

    const waitResponse = await tool("playtest.wait")({
      batchId: run.batchId,
      waitMs: 5
    });
    assert.equal(
      JSON.parse(waitResponse.content[0].text).result.episodeId,
      "episode-remote-1"
    );

    const cancelResponse = await tool("playtest.cancel")({
      batchId: run.batchId
    });
    assert.equal(
      JSON.parse(cancelResponse.content[0].text).cancellationRequested,
      true,
      cancelResponse.content[0].text
    );

    assert.deepEqual(
      delegated.map((entry) => (entry as { operation: string }).operation),
      ["start", "list", "wait", "cancel"]
    );
    for (const entry of delegated) {
      assert.deepEqual(
        (entry as { session: PlaytestMcpSession }).session,
        session
      );
    }
  } finally {
    if (oldToken === undefined)
      delete process.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN;
    else process.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN = oldToken;
    if (oldActor === undefined)
      delete process.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR;
    else process.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR = oldActor;
    if (oldRole === undefined)
      delete process.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE;
    else process.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE = oldRole;
    rmSync(root, { recursive: true, force: true });
  }
});
