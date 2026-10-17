import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestLaunchRequest
} from "@simulatorlife/autodev-core";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestControlApiRunClient,
  playtestControlApiRunClientFromEnvironment
} from "../src/playtesting/control-api-run-control-client.ts";
import {
  createPlaytestMcpServer,
  PlaytestMcpAuthorizationError,
  PlaytestMcpConflictError,
  type PlaytestMcpSession,
  PlaytestMcpUnavailableError,
  type PlaytestRunControl
} from "../src/playtesting/mcp.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

let launchRequestCounter = 0;

function nextLaunchRequestId(): string {
  launchRequestCounter += 1;
  return `client-test-request-${String(launchRequestCounter)}`;
}

function batchLaunch(input: {
  readonly workspaceId?: string;
  readonly requestId?: string;
  readonly capabilityRevision?: string;
  readonly assignments: readonly {
    readonly scenario: string;
    readonly policy: string;
    readonly seed: string;
    readonly goal?: string;
    readonly maxSteps?: number;
  }[];
}): PlaytestLaunchRequest {
  return {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "adapter-accelerated",
    workspaceId: input.workspaceId ?? WORKSPACE,
    requestId: input.requestId ?? nextLaunchRequestId(),
    capabilityRevision: input.capabilityRevision ?? "b".repeat(64),
    operation: { kind: "batch", assignments: input.assignments }
  };
}

function branchLaunch(input: {
  readonly workspaceId?: string;
  readonly requestId?: string;
  readonly capabilityRevision?: string;
  readonly parentEpisodeId: string;
  readonly branchStep: number;
  readonly alternativeActionId: string;
  readonly policy?: string;
  readonly maxSteps?: number;
}): PlaytestLaunchRequest {
  const { workspaceId, requestId, capabilityRevision, ...operation } = input;
  return {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "adapter-accelerated",
    workspaceId: workspaceId ?? WORKSPACE,
    requestId: requestId ?? nextLaunchRequestId(),
    capabilityRevision: capabilityRevision ?? "b".repeat(64),
    operation: { kind: "branch", ...operation }
  };
}

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
      schema: "autodev-control-playtesting-capabilities-v3",
      workspaceId: WORKSPACE,
      capabilityRevision: "b".repeat(64),
      modeReadiness: {
        "adapter-accelerated": { status: "ready", reasons: [] },
        "autonomous-visual": {
          status: "unavailable",
          reasons: [
            {
              code: "visual-driver-unavailable",
              label: "Visual driver unavailable",
              message:
                "The isolated browser driver is not yet connected to the Runtime session owner and persisted visual evidence flow.",
              severity: "unavailable"
            }
          ],
          targetStore: "available",
          targets: [
            {
              target: {
                schema: "autodev-workspace-visual-playtest-target-v1",
                workspaceId: WORKSPACE,
                targetId: "local-game",
                revision: 1,
                approvalId: "visual-approval-1",
                name: "Local browser game",
                entryUrl: "http://localhost:5173/",
                allowedOrigins: ["http://localhost:5173"],
                inputCapabilities: ["keyboard", "pointer"],
                controlTimingClass: "turn-based",
                entryRequirements: "none",
                sandboxProfile: "transient-browser-profile",
                capturePolicy: "screenshots-only-redact-or-refuse",
                limits: {
                  episodeCount: 1,
                  maxStepsPerEpisode: 20,
                  wallTimeMs: 60_000,
                  smartRequestsPerEpisode: 5,
                  smartTokensPerEpisode: 5000,
                  screenshotCountPerEpisode: 20,
                  artifactBytesPerEpisode: 1_048_576
                },
                approvedAt: "2026-10-16T00:00:00.000Z",
                approvedBy: "operator-1",
                revokedAt: null,
                revokedBy: null,
                revocationReason: null
              },
              eligibility: "supported",
              reasons: []
            }
          ]
        },
        "scripted-regression": {
          status: "unavailable",
          reasons: [
            {
              code: "scripted-regression-unavailable",
              label: "Scripted regression unavailable",
              message:
                "Runtime does not yet have the approved scripted-regression launch path.",
              severity: "unavailable"
            }
          ]
        }
      },
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
      maxBatchAssignments: 10,
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
      admissibleSeeds: null,
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
      configuredIssueReporting: "disabled",
      humanStudyAllowed: false,
      revokedAt: null,
      runPreflight: "required-at-start"
    },
    {
      schema: "autodev-control-playtesting-run-started-v2",
      workspaceId: WORKSPACE,
      batchId: "batch-1",
      assignmentCount: 1,
      assignmentIds: ["a-0001"],
      createdAt: "2026-10-10T00:00:00Z",
      status: "running"
    },
    {
      schema: "autodev-control-playtesting-run-request-v1",
      workspaceId: WORKSPACE,
      requestId: "client-request-1",
      state: "accepted",
      batchId: "batch-1",
      assignmentCount: 1,
      assignmentIds: ["a-0001"],
      createdAt: "2026-10-10T00:00:00Z",
      status: "running"
    },
    {
      schema: "autodev-control-playtesting-runs-v1",
      workspaceId: WORKSPACE,
      runs: [
        {
          batchId: "batch-1",
          assignmentCount: 1,
          createdAt: "2026-10-10T00:00:00Z",
          status: {
            batchId: "batch-1",
            status: "running",
            cancellationReason: null,
            result: null,
            error: null
          }
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
        result: {
          batchId: "batch-1",
          assignmentCount: 1,
          outcomes: [
            {
              assignmentId: "a-0001",
              episodeId: "episode-1",
              state: "completed",
              started: true,
              eligible: true
            }
          ]
        },
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
  const launch = batchLaunch({
    requestId: "client-request-1",
    assignments: [{ scenario: "tutorial", policy: "random", seed: "seed-1" }]
  });
  const started = await client.startRun(SESSION, launch);
  assert.deepEqual(started, {
    batchId: "batch-1",
    assignmentCount: 1,
    assignmentIds: ["a-0001"],
    createdAt: "2026-10-10T00:00:00Z",
    status: "running"
  });
  const recovered = await client.lookupRunByRequest(
    SESSION,
    WORKSPACE,
    launch.requestId
  );
  assert.equal(recovered.state, "accepted");
  assert.equal(recovered.batchId, "batch-1");
  assert.deepEqual(recovered.assignmentIds, ["a-0001"]);
  const listed = await client.listActiveRuns(SESSION, WORKSPACE);
  assert.equal(listed.length, 1);
  const status = await client.waitForRun(SESSION, WORKSPACE, "batch-1", 100);
  assert.equal(status.status, "completed");
  const cancellation = await client.cancelRun(SESSION, WORKSPACE, "batch-1");
  assert.deepEqual(cancellation, {
    batchId: "batch-1",
    cancellationRequested: false
  });

  assert.equal(calls.length, 6);
  assert.match(
    calls[0]!.url,
    /\/control\/playtesting\/capabilities\?workspaceId=fixture%2Fgame/u
  );
  assert.equal(calls[1]!.method, "POST");
  assert.deepEqual(JSON.parse(calls[1]!.body!), launch);
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
    /\/control\/playtesting\/runs\/by-request\?workspaceId=fixture%2Fgame&requestId=client-request-1/u
  );
  assert.match(
    calls[3]!.url,
    /\/control\/playtesting\/runs\?workspaceId=fixture%2Fgame/u
  );
  assert.match(
    calls[4]!.url,
    /batch-1\?workspaceId=fixture%2Fgame&waitMs=100/u
  );
  assert.match(calls[5]!.url, /batch-1\/cancel\?workspaceId=fixture%2Fgame/u);
});

test("MCP packet preparation accepts only the packet-preparation response variant", async () => {
  const session: PlaytestMcpSession = {
    ...SESSION,
    role: "operator"
  };
  const response = {
    schema: "autodev-control-playtesting-analysis-v1",
    operation: "prepare",
    workspaceId: WORKSPACE,
    requested: 1,
    packets: [],
    receipts: [],
    budget: [],
    analysis: null
  };
  let body = "";
  const client = createPlaytestControlApiRunClient({
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "analyst-service-token",
    actor: "playtest-runtime",
    sessionRole: "operator",
    fetcher: async (_input, init) => {
      body = String(init?.body ?? "");
      return jsonResponse(response);
    }
  });
  assert.deepEqual(
    await client.prepareCrossSessionReview(session, WORKSPACE, ["episode-1"]),
    { packets: [], receipts: [], budget: [] }
  );
  assert.deepEqual(JSON.parse(body), { episodeIds: ["episode-1"] });

  const wrongOperation = createPlaytestControlApiRunClient({
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "analyst-service-token",
    actor: "playtest-runtime",
    sessionRole: "operator",
    fetcher: async () => jsonResponse({ ...response, operation: "dispatch" })
  });
  await assert.rejects(
    wrongOperation.prepareCrossSessionReview(session, WORKSPACE, ["episode-1"]),
    PlaytestMcpUnavailableError
  );
});

test("full packet preparation retains its separate 16-session response bound", async () => {
  let fetchCount = 0;
  const client = createPlaytestControlApiRunClient({
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "packet-reader-token",
    actor: "playtest-runtime",
    sessionRole: "operator",
    fetcher: async () => {
      fetchCount += 1;
      return jsonResponse({});
    }
  });
  await assert.rejects(
    client.prepareCrossSessionReview(
      { ...SESSION, role: "operator" },
      WORKSPACE,
      Array.from({ length: 17 }, (_, index) => `episode-${index + 1}`)
    ),
    /Packet preparation requires 1-16 distinct sessions/u
  );
  assert.equal(fetchCount, 0);
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
  assert.ok(configured);
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

test("analyst MCP setup does not require a Control API run-control credential", () => {
  assert.equal(
    playtestControlApiRunClientFromEnvironment({
      AUTODEV_PLAYTEST_ROLE: "playtest-analyst"
    }),
    null
  );
  assert.throws(
    () =>
      playtestControlApiRunClientFromEnvironment({
        AUTODEV_PLAYTEST_ROLE: "playtest-analyst",
        AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtester"
      }),
    /does not match/u
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

test("Playtest Control API client preserves requestId conflicts as non-retryable conflicts", async () => {
  const client = createPlaytestControlApiRunClient({
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "token",
    actor: "playtest-runtime",
    sessionRole: "playtester",
    fetcher: async () =>
      jsonResponse(
        {
          error: {
            code: "autodev_control_playtesting_request_id_conflict",
            message: "This requestId is already bound to another payload."
          }
        },
        409
      )
  });
  await assert.rejects(
    client.startRun(
      SESSION,
      batchLaunch({
        requestId: "conflicting-request-1",
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "seed-1" }
        ]
      })
    ),
    PlaytestMcpConflictError
  );
});

test("Playtesting Control API client forwards an attributed, expected-revision owner decision", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const actor = "root-operator";
  const session: PlaytestMcpSession = {
    workspaceId: WORKSPACE,
    role: "operator",
    actor,
    taskId: "task-decision",
    runId: "run-decision"
  };
  const client = createPlaytestControlApiRunClient({
    baseUrl: "http://127.0.0.1:4101",
    serviceToken: "decision-service-token",
    actor: "runtime-service",
    sessionRole: "operator",
    fetcher: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return jsonResponse({
        schema: "autodev-control-playtesting-comparison-decision-v1",
        workspaceId: WORKSPACE,
        comparison: {
          comparisonId: "comparison-1",
          version: 3,
          ownerDecisionBy: actor,
          ownerDisposition: "hold",
          ownerDecisionReason: "Wait for the independent confirmation run."
        }
      });
    }
  });
  const result = await client.recordComparisonDecision(
    session,
    WORKSPACE,
    "comparison-1",
    2,
    "hold",
    "Wait for the independent confirmation run."
  );
  assert.equal(result.version, 3);
  assert.equal(
    requestUrl,
    "http://127.0.0.1:4101/control/playtesting/comparisons/comparison-1/decision"
  );
  assert.equal(requestInit?.method, "POST");
  assert.equal(JSON.parse(String(requestInit?.body)).expectedVersion, 2);
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("x-autodev-actor"), "runtime-service");
  assert.equal(
    JSON.parse(
      Buffer.from(
        headers.get("x-autodev-playtest-session")!,
        "base64url"
      ).toString("utf8")
    ).actor,
    actor
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
    async recordComparisonDecision() {
      throw new Error(
        "Owner-decision route is not used by this run-only fixture."
      );
    },
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
      maxBatchAssignments: 10,
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
      admissibleSeeds: null,
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
      configuredIssueReporting: "disabled",
      humanStudyAllowed: false,
      revokedAt: null,
      runPreflight: "required-at-start"
    }),
    async startRun(receivedSession, request) {
      delegated.push({ operation: "start", session: receivedSession, request });
      return {
        batchId: "batch-remote-1",
        assignmentCount:
          request.mode === "adapter-accelerated" &&
          request.operation.kind === "batch"
            ? request.operation.assignments.length
            : 1,
        assignmentIds: ["a-0001"],
        createdAt: "2026-10-10T00:00:00.000Z",
        status: "running"
      };
    },
    async lookupRunByRequest(_receivedSession, _workspaceId, requestId) {
      return {
        requestId,
        state: "not-found",
        batchId: null,
        assignmentCount: null,
        assignmentIds: [],
        createdAt: null,
        status: null
      };
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
          assignmentCount: 1,
          createdAt: "2026-10-10T00:00:00.000Z",
          status: {
            batchId: "batch-remote-1",
            status: "running",
            cancellationReason: null,
            result: null,
            error: null
          }
        }
      ];
    },
    async prepareCrossSessionReview() {
      return { packets: [], receipts: [], budget: [] };
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

    const capabilitiesResponse = await tool("playtest.capabilities")({
      workspaceId: WORKSPACE
    });
    const capabilityRevision = JSON.parse(capabilitiesResponse.content[0].text)
      .capabilityRevision as string;

    const runResponse = await tool("playtest.run")({
      launchRequest: batchLaunch({
        capabilityRevision,
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "remote-seed" }
        ]
      })
    });
    const run = JSON.parse(runResponse.content[0].text);
    assert.deepEqual(run, {
      batchId: "batch-remote-1",
      assignmentCount: 1,
      assignmentIds: ["a-0001"],
      createdAt: "2026-10-10T00:00:00.000Z",
      status: "running"
    });

    const branchRequest = branchLaunch({
      requestId: "remote-branch-request-1",
      capabilityRevision,
      parentEpisodeId: "episode-parent",
      branchStep: 4,
      alternativeActionId: "cool-down",
      policy: "random",
      maxSteps: 8
    });
    const branchResponse = await tool("playtest.branch")({
      launchRequest: branchRequest
    });
    assert.equal(
      branchResponse.isError,
      undefined,
      branchResponse.content[0].text
    );
    assert.deepEqual(JSON.parse(branchResponse.content[0].text), {
      batchId: "batch-remote-1",
      assignmentCount: 1,
      assignmentIds: ["a-0001"],
      createdAt: "2026-10-10T00:00:00.000Z",
      status: "running"
    });
    assert.deepEqual(
      (delegated[1] as { request: unknown }).request,
      branchRequest
    );

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
      ["start", "start", "list", "wait", "cancel"]
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
