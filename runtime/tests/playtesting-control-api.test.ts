import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  PlaytestInvalidCursorError,
  PlaytestSourceUnavailableError,
  RestrictedHumanResponseRepository
} from "@simulatorlife/autodev-data/playtesting";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import {
  handlePlaytestingControlApiRequest,
  type PlaytestingReadRepository
} from "../src/control-api/playtesting.ts";
import {
  handlePlaytestingRunControlRequest,
  type PlaytestingRunControlApiOptions
} from "../src/control-api/playtesting-run-control.ts";
import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";
import type {
  HumanPlaytestStudy,
  PlaytestBenchmark,
  PlaytestEpisode
} from "@simulatorlife/autodev-core";
import type { PlaytestingHumanStudyRepository } from "../src/control-api/playtesting-human-studies.ts";
import { PlaytestSandboxUnavailableError } from "../src/playtesting/docker-sandbox.ts";
import type {
  PlaytestRunCapabilities,
  PlaytestRunControl
} from "../src/playtesting/mcp.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const WORKSPACE = "fixture/game";

function request(method: string, url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    url,
    headers: { host: "127.0.0.1" }
  }) as IncomingMessage;
}

function catalog() {
  return {
    status: "valid" as const,
    workspaces: [
      {
        id: WORKSPACE,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      }
    ]
  };
}

function readRepository(
  overrides: Partial<PlaytestingReadRepository> = {}
): PlaytestingReadRepository {
  const empty = async () => ({ rows: [], total: 0, nextCursor: null });
  return {
    listBatches: empty,
    listEpisodes: empty,
    listFindings: empty,
    listComparisons: empty,
    listBenchmarks: empty,
    listExperiments: empty,
    listHumanStudies: empty,
    getEpisode: async () => null,
    getLatestReviewForEpisode: async () => null,
    ...overrides
  } as unknown as PlaytestingReadRepository;
}

async function call(
  method: string,
  url: string,
  options: Parameters<typeof handlePlaytestingControlApiRequest>[4] = {},
  actor?: { actor: string; role: "viewer" | "operator" }
): Promise<{
  readonly status: number;
  readonly headers: Record<string, string | number>;
  readonly body: Record<string, unknown>;
}> {
  const response = responseRecorder();
  await handlePlaytestingControlApiRequest(
    request(method, url),
    response as unknown as ServerResponse,
    new URL(url, "http://127.0.0.1").pathname,
    actor ?? { actor: "console-viewer", role: "viewer" },
    { readWorkspaceCatalog: catalog, repository: readRepository(), ...options }
  );
  return {
    status: response.statusCode,
    headers: response.headers,
    body: JSON.parse(response.body ?? "{}") as Record<string, unknown>
  };
}

function runRequest(
  method: string,
  url: string,
  body?: unknown
): IncomingMessage {
  const chunks = body === undefined ? [] : [JSON.stringify(body)];
  return Object.assign(Readable.from(chunks), {
    method,
    url,
    headers:
      body === undefined
        ? { host: "127.0.0.1" }
        : {
            host: "127.0.0.1",
            "content-type": "application/json"
          }
  }) as IncomingMessage;
}

async function callRunControl(
  method: string,
  url: string,
  actor: { actor: string; role: "viewer" | "operator" },
  options: PlaytestingRunControlApiOptions,
  body?: unknown
): Promise<{
  status: number;
  headers: Record<string, string | number>;
  body: Record<string, unknown>;
}> {
  const response = responseRecorder();
  await handlePlaytestingRunControlRequest(
    runRequest(method, url, body),
    response as unknown as ServerResponse,
    new URL(url, "http://127.0.0.1").pathname,
    actor,
    { readWorkspaceCatalog: catalog, ...options }
  );
  return {
    status: response.statusCode,
    headers: response.headers,
    body: JSON.parse(response.body || "{}") as Record<string, unknown>
  };
}

function runControlFixture(calls: unknown[] = []): PlaytestRunControl {
  return {
    getCapabilities: async (
      session,
      workspaceId
    ): Promise<PlaytestRunCapabilities> => {
      calls.push({ operation: "capabilities", session, workspaceId });
      return {
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
      };
    },
    startRun: async (session, payload) => {
      calls.push({ operation: "start", session, request: payload });
      return { batchId: "batch-run-1", status: "running" };
    },
    listActiveRuns: (session, workspaceId) => {
      calls.push({ operation: "list", session, workspaceId });
      return [
        {
          batchId: "batch-run-1",
          scenarioId: "tutorial",
          createdAt: "2026-10-10T00:00:00.000Z"
        }
      ];
    },
    cancelRun: (session, workspaceId, batchId) => {
      calls.push({ operation: "cancel", session, workspaceId, batchId });
      return { batchId, cancellationRequested: true };
    },
    waitForRun: async (session, workspaceId, batchId, waitMs) => {
      calls.push({ operation: "wait", session, workspaceId, batchId, waitMs });
      return {
        batchId,
        status: "completed",
        cancellationReason: null,
        result: { episodeId: "episode-1", outcome: "win" },
        error: null
      };
    }
  };
}

test("Control API run, status, list, and cancel delegate to the shared Runtime run owner", async () => {
  const calls: unknown[] = [];
  const audit: unknown[] = [];
  const runControl = runControlFixture(calls);
  const options: PlaytestingRunControlApiOptions = {
    runControl,
    audit: (event) => audit.push(event)
  };
  const operator = { actor: "operator-1", role: "operator" as const };
  const viewer = { actor: "viewer-1", role: "viewer" as const };
  const requestBody = {
    workspaceId: WORKSPACE,
    scenario: "tutorial",
    policy: "random",
    seed: "seed-1",
    maxSteps: 20
  };

  const capabilities = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    viewer,
    options
  );
  assert.equal(capabilities.status, 200);
  assert.equal(
    capabilities.body.schema,
    "autodev-control-playtesting-capabilities-v1"
  );
  assert.deepEqual(capabilities.body.runnablePolicies, ["random"]);

  const started = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    operator,
    options,
    requestBody
  );
  assert.equal(started.status, 202);
  assert.deepEqual(started.body, {
    schema: "autodev-control-playtesting-run-started-v1",
    workspaceId: WORKSPACE,
    batchId: "batch-run-1",
    status: "running"
  });
  const delegatedStart = calls[1] as {
    operation: string;
    session: { workspaceId: string; role: string; actor: string };
    request: unknown;
  };
  assert.equal(delegatedStart.operation, "start");
  assert.equal(delegatedStart.session.workspaceId, WORKSPACE);
  assert.equal(delegatedStart.session.role, "operator");
  assert.match(delegatedStart.session.actor, /^control-api:[a-f0-9]{64}$/u);
  assert.deepEqual(delegatedStart.request, {
    workspaceId: WORKSPACE,
    scenario: "tutorial",
    policy: "random",
    seed: "seed-1",
    maxSteps: 20
  });

  const active = await callRunControl(
    "GET",
    `/control/playtesting/runs?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    viewer,
    options
  );
  assert.equal(active.status, 200);
  assert.equal(active.body.schema, "autodev-control-playtesting-runs-v1");
  assert.equal((active.body.runs as unknown[]).length, 1);
  assert.equal(
    (calls[3] as { session: { role: string } }).session.role,
    "control-viewer"
  );

  const status = await callRunControl(
    "GET",
    `/control/playtesting/runs/batch-run-1?workspaceId=${encodeURIComponent(WORKSPACE)}&waitMs=25`,
    viewer,
    options
  );
  assert.equal(status.status, 200);
  assert.equal(
    (calls[2] as { session: { role: string } }).session.role,
    "control-viewer"
  );
  assert.deepEqual(status.body.run, {
    batchId: "batch-run-1",
    status: "completed",
    cancellationReason: null,
    result: { episodeId: "episode-1", outcome: "win" },
    error: null
  });

  const cancelled = await callRunControl(
    "POST",
    `/control/playtesting/runs/batch-run-1/cancel?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options,
    { expectedStatus: "running" }
  );
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.body.cancellationRequested, true);
  assert.deepEqual(
    audit.map((event) => (event as { action: string }).action),
    ["start_playtest_run", "cancel_playtest_run"]
  );
  assert.equal(calls.length, 5);
});

test("Control API preserves the trusted MCP role and run ownership session across the process boundary", async () => {
  const calls: unknown[] = [];
  const options: PlaytestingRunControlApiOptions = {
    runControl: runControlFixture(calls)
  };
  const operator = { actor: "playtest-runtime", role: "operator" as const };
  const session = {
    workspaceId: WORKSPACE,
    role: "playtester",
    actor: "agent-1",
    taskId: "task-1",
    runId: "run-1"
  };
  const sessionRequest = runRequest("POST", "/control/playtesting/runs", {
    workspaceId: WORKSPACE,
    scenario: "tutorial",
    policy: "random",
    seed: "seed-1"
  });
  sessionRequest.headers = {
    host: "127.0.0.1",
    "content-type": "application/json",
    "x-autodev-playtest-session": Buffer.from(JSON.stringify(session)).toString(
      "base64url"
    )
  };
  const response = responseRecorder();
  await handlePlaytestingRunControlRequest(
    sessionRequest,
    response as unknown as ServerResponse,
    "/control/playtesting/runs",
    operator,
    { readWorkspaceCatalog: catalog, ...options }
  );
  assert.equal(response.statusCode, 202);
  const delegated = calls[0] as {
    session: {
      workspaceId: string;
      role: string;
      actor: string;
      taskId?: string;
      runId?: string;
    };
  };
  assert.deepEqual(delegated.session, session);

  const viewerRequest = runRequest(
    "GET",
    `/control/playtesting/runs?workspaceId=${encodeURIComponent(WORKSPACE)}`
  );
  viewerRequest.headers = {
    host: "127.0.0.1",
    "x-autodev-playtest-session": Buffer.from(JSON.stringify(session)).toString(
      "base64url"
    )
  };
  const forbidden = responseRecorder();
  await handlePlaytestingRunControlRequest(
    viewerRequest,
    forbidden as unknown as ServerResponse,
    "/control/playtesting/runs",
    { actor: "read-only-viewer", role: "viewer" },
    { readWorkspaceCatalog: catalog, ...options }
  );
  assert.equal(forbidden.statusCode, 403);
  assert.equal(calls.length, 1);

  const malformedRequest = runRequest(
    "GET",
    `/control/playtesting/runs?workspaceId=${encodeURIComponent(WORKSPACE)}`
  );
  malformedRequest.headers = {
    host: "127.0.0.1",
    "x-autodev-playtest-session": "not-base64-json"
  };
  const malformed = responseRecorder();
  await handlePlaytestingRunControlRequest(
    malformedRequest,
    malformed as unknown as ServerResponse,
    "/control/playtesting/runs",
    operator,
    { readWorkspaceCatalog: catalog, ...options }
  );
  assert.equal(malformed.statusCode, 400);
});

test("Control API run actions fail closed for viewers, malformed requests, and absent run owners", async () => {
  const calls: unknown[] = [];
  const options: PlaytestingRunControlApiOptions = {
    runControl: runControlFixture(calls)
  };
  const viewer = { actor: "viewer-1", role: "viewer" as const };
  const body = {
    workspaceId: WORKSPACE,
    scenario: "tutorial",
    policy: "random",
    seed: "seed-1"
  };

  const forbidden = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    viewer,
    options,
    body
  );
  assert.equal(forbidden.status, 403);
  assert.equal(calls.length, 0);

  const extraField = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    { actor: "operator-1", role: "operator" },
    options,
    { ...body, command: ["echo", "unsafe"] }
  );
  assert.equal(extraField.status, 400);
  assert.equal(calls.length, 0);

  const duplicateWorkspace = await callRunControl(
    "GET",
    `/control/playtesting/runs?workspaceId=${encodeURIComponent(WORKSPACE)}&workspaceId=${encodeURIComponent(WORKSPACE)}`,
    viewer,
    options
  );
  assert.equal(duplicateWorkspace.status, 400);
  assert.equal(calls.length, 0);

  const noOwner = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    { actor: "operator-1", role: "operator" },
    {} as PlaytestingRunControlApiOptions,
    body
  );
  assert.equal(noOwner.status, 503);
  assert.equal(calls.length, 0);
});

test("Control API reports missing Data and sandbox services as unavailable without leaking host details", async () => {
  const operator = { actor: "operator-1", role: "operator" as const };
  const requestBody = {
    workspaceId: WORKSPACE,
    scenario: "tutorial",
    policy: "random",
    seed: "failure-seed"
  };
  for (const failure of ["data", "sandbox"] as const) {
    const base = runControlFixture();
    const runControl: PlaytestRunControl = {
      ...base,
      startRun: async () => {
        if (failure === "data") {
          throw new PlaytestSourceUnavailableError("/private/data-path");
        }
        throw new PlaytestSandboxUnavailableError("/private/docker-socket");
      }
    };
    const response = await callRunControl(
      "POST",
      "/control/playtesting/runs",
      operator,
      { runControl },
      requestBody
    );
    assert.equal(response.status, 503);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /private\/(?:data-path|docker-socket)/u
    );
    assert.equal(
      (response.body.error as { code: string }).code,
      failure === "data"
        ? "autodev_control_playtesting_source_unavailable"
        : "autodev_control_playtesting_sandbox_unavailable"
    );
  }
});

test("Playtesting episodes API forwards validated filters and cursor paging to Data", async () => {
  let received: unknown;
  const repository = readRepository({
    listEpisodes: async (filter, page) => {
      received = { filter, page };
      return {
        rows: [],
        total: 10_000,
        nextCursor: "next-cursor"
      };
    }
  });
  const response = await call(
    "GET",
    `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}&limit=100&cursor=after&buildSha=${"a".repeat(40)}&cohort=novice`,
    { repository }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body, {
    schema: "autodev-control-playtesting-page-v1",
    workspaceId: WORKSPACE,
    resource: "episodes",
    readOnly: true,
    page: { rows: [], total: 10_000, nextCursor: "next-cursor" }
  });
  assert.deepEqual(received, {
    filter: {
      workspaceId: WORKSPACE,
      buildSha: "a".repeat(40),
      cohort: "novice"
    },
    page: { limit: 100, cursor: "after" }
  });
});

test("Playtesting reads distinguish unknown workspaces, unavailable catalogs, and unavailable source", async () => {
  const unknown = await call(
    "GET",
    "/control/playtesting/episodes?workspaceId=other/game",
    { repository: readRepository() }
  );
  assert.equal(unknown.status, 404);
  assert.equal(
    unknown.body.error && (unknown.body.error as { code?: string }).code,
    "autodev_control_playtesting_workspace_not_found"
  );

  const unavailableCatalog = await call(
    "GET",
    `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    {
      readWorkspaceCatalog: () => ({ status: "unavailable", workspaces: [] }),
      repository: readRepository()
    }
  );
  assert.equal(unavailableCatalog.status, 503);
  assert.equal(
    (unavailableCatalog.body.error as { code: string }).code,
    "autodev_control_playtesting_workspace_catalog_unavailable"
  );

  const unavailableSource = await call(
    "GET",
    `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    {
      repository: readRepository({
        listEpisodes: async () => {
          throw new PlaytestSourceUnavailableError("fixture offline");
        }
      })
    }
  );
  assert.equal(unavailableSource.status, 503);
  assert.equal(
    (unavailableSource.body.error as { code: string }).code,
    "autodev_control_playtesting_source_unavailable"
  );
  assert.doesNotMatch(
    JSON.stringify(unavailableSource.body),
    /fixture offline/u
  );
});

test("Playtesting filters reject duplicate, unknown, invalid, and inverted values before Data", async () => {
  let reads = 0;
  const repository = readRepository({
    listEpisodes: async () => {
      reads += 1;
      return { rows: [], total: 0, nextCursor: null };
    }
  });
  const base = `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`;
  for (const query of [
    "&cohort=novice&cohort=expert",
    "&rawSql=1",
    "&status=not-a-state",
    "&startedAtFrom=2026-02-01T00:00:00Z&startedAtTo=2026-01-01T00:00:00Z",
    "&limit=0"
  ]) {
    const response = await call("GET", base + query, { repository });
    assert.equal(response.status, 400, query);
  }
  assert.equal(reads, 0);
});

test("Playtesting invalid keyset cursors return 400, never an empty page", async () => {
  const response = await call(
    "GET",
    `/control/playtesting/findings?workspaceId=${encodeURIComponent(WORKSPACE)}&cursor=malformed`,
    {
      repository: readRepository({
        listFindings: async () => {
          throw new PlaytestInvalidCursorError();
        }
      })
    }
  );
  assert.equal(response.status, 400);
  assert.equal(
    (response.body.error as { code: string }).code,
    "autodev_control_playtesting_invalid_cursor"
  );
});

test("selected episode returns its latest review and remains workspace-scoped", async () => {
  const episode = {
    episodeId: "episode-1",
    schema: "autodev-playtest-episode-v1"
  };
  const review = { reviewId: "review-1", status: "hypothesis" };
  let lookup: unknown;
  const repository = readRepository({
    getEpisode: async (workspaceId, episodeId) => {
      lookup = { workspaceId, episodeId };
      return episode as never;
    },
    getLatestReviewForEpisode: async () => review as never
  });
  const response = await call(
    "GET",
    `/control/playtesting/episodes/episode-1?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    { repository }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(lookup, { workspaceId: WORKSPACE, episodeId: "episode-1" });
  assert.equal(response.body.schema, "autodev-control-playtesting-detail-v1");
  assert.deepEqual(response.body.record, episode);
  assert.deepEqual(response.body.latestReview, review);
});

test("Playtesting API is GET-only and reports a missing episode as not found", async () => {
  const method = await call(
    "POST",
    `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "GET");

  const missing = await call(
    "GET",
    `/control/playtesting/episodes/missing?workspaceId=${encodeURIComponent(WORKSPACE)}`
  );
  assert.equal(missing.status, 404);
  assert.equal(
    (missing.body.error as { code: string }).code,
    "autodev_control_playtesting_episode_not_found"
  );
});

test("Control API authenticates and routes workspace-scoped Playtesting reads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-playtesting-api-"));
  const workspaceRoot = path.join(root, "repo", "config");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, "workspaces.json"),
    JSON.stringify({
      schema: "autodev-workspaces-v1",
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ]
    }),
    "utf8"
  );
  const envBefore = {
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    viewers: process.env.AUTODEV_CONTROL_VIEWERS,
    operators: process.env.AUTODEV_CONTROL_OPERATORS
  };
  const token = "t".repeat(64);
  process.env.AUTODEV_CONTROL_API_TOKEN = token;
  process.env.AUTODEV_CONTROL_VIEWERS = "playtesting-viewer";
  process.env.AUTODEV_CONTROL_OPERATORS = "playtesting-operator";
  const headers = {
    host: "127.0.0.1",
    authorization: `Bearer ${token}`,
    "x-autodev-actor": "playtesting-viewer"
  };
  const uri = `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`;
  const repository = readRepository({
    listEpisodes: async () => ({ rows: [], total: 0, nextCursor: null })
  });
  try {
    const response = responseRecorder();
    await handleControlApiRequest(
      Object.assign(Readable.from([]), {
        method: "GET",
        url: uri,
        headers
      }) as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      "/control/playtesting/episodes",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRepository: repository
      }
    );
    assert.equal(response.statusCode, 200);
    assert.equal(
      (JSON.parse(response.body ?? "{}") as { schema?: string }).schema,
      "autodev-control-playtesting-page-v1"
    );

    const delegatedRunControl = runControlFixture();
    const runRequestBody = {
      workspaceId: WORKSPACE,
      scenario: "tutorial",
      policy: "random",
      seed: "auth-boundary-seed"
    };
    const viewerRun = responseRecorder();
    const viewerRequest = runRequest(
      "POST",
      "/control/playtesting/runs",
      runRequestBody
    );
    viewerRequest.headers = {
      host: "127.0.0.1",
      authorization: `Bearer ${token}`,
      "x-autodev-actor": "playtesting-viewer",
      "content-type": "application/json"
    };
    await handleControlApiRequest(
      viewerRequest,
      viewerRun as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: delegatedRunControl
      }
    );
    assert.equal(viewerRun.statusCode, 403);

    const operatorRun = responseRecorder();
    const operatorRequest = runRequest(
      "POST",
      "/control/playtesting/runs",
      runRequestBody
    );
    operatorRequest.headers = {
      host: "127.0.0.1",
      authorization: `Bearer ${token}`,
      "x-autodev-actor": "playtesting-operator",
      "content-type": "application/json"
    };
    await handleControlApiRequest(
      operatorRequest,
      operatorRun as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: delegatedRunControl
      }
    );
    assert.equal(operatorRun.statusCode, 202);
    assert.equal(
      (JSON.parse(operatorRun.body ?? "{}") as { schema?: string }).schema,
      "autodev-control-playtesting-run-started-v1"
    );

    const unauthorized = responseRecorder();
    await handleControlApiRequest(
      Object.assign(Readable.from([]), {
        method: "GET",
        url: uri,
        headers: {
          host: "127.0.0.1",
          authorization: `Bearer ${token}`,
          "x-autodev-actor": "unknown"
        }
      }) as unknown as IncomingMessage,
      unauthorized,
      "/control/playtesting/episodes",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRepository: repository
      }
    );
    assert.equal(unauthorized.statusCode, 403);
  } finally {
    if (envBefore.token === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = envBefore.token;
    if (envBefore.viewers === undefined)
      delete process.env.AUTODEV_CONTROL_VIEWERS;
    else process.env.AUTODEV_CONTROL_VIEWERS = envBefore.viewers;
    if (envBefore.operators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = envBefore.operators;
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped Playtesting Control API credential is limited to typed run routes", async () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "autodev-playtesting-scoped-api-")
  );
  const workspaceRoot = path.join(root, "repo", "config");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, "workspaces.json"),
    JSON.stringify({
      schema: "autodev-workspaces-v1",
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ]
    }),
    "utf8"
  );
  const envKeys = [
    "AUTODEV_CONTROL_API_TOKEN",
    "AUTODEV_CONTROL_API_VIEWERS",
    "AUTODEV_CONTROL_API_OPERATORS",
    "AUTODEV_CONTROL_VIEWERS",
    "AUTODEV_CONTROL_OPERATORS",
    "AUTODEV_PLAYTEST_CONTROL_API_TOKEN",
    "AUTODEV_PLAYTEST_CONTROL_API_ACTOR",
    "AUTODEV_PLAYTEST_CONTROL_API_ROLE"
  ] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.AUTODEV_CONTROL_API_TOKEN;
    process.env.AUTODEV_CONTROL_VIEWERS = "";
    process.env.AUTODEV_CONTROL_OPERATORS = "";
    process.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN = "scoped-playtest-secret";
    process.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR = "playtest-runtime";
    process.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE = "playtester";
    const session = {
      workspaceId: WORKSPACE,
      role: "playtester",
      actor: "agent-1",
      taskId: "task-1",
      runId: "run-1"
    };
    const scopedRequest = runRequest("POST", "/control/playtesting/runs", {
      workspaceId: WORKSPACE,
      scenario: "tutorial",
      policy: "random",
      seed: "scoped-token-seed"
    });
    scopedRequest.headers = {
      host: "127.0.0.1",
      authorization: "Bearer scoped-playtest-secret",
      "content-type": "application/json",
      "x-autodev-playtest-session": Buffer.from(
        JSON.stringify(session)
      ).toString("base64url")
    };
    const delegatedCalls: unknown[] = [];
    const runResponse = responseRecorder();
    await handleControlApiRequest(
      scopedRequest,
      runResponse as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: runControlFixture(delegatedCalls)
      }
    );
    assert.equal(runResponse.statusCode, 202);
    assert.equal(delegatedCalls.length, 1);

    const missingSessionResponse = responseRecorder();
    const missingSessionRequest = runRequest(
      "POST",
      "/control/playtesting/runs",
      {
        workspaceId: WORKSPACE,
        scenario: "tutorial",
        policy: "random",
        seed: "missing-session"
      }
    );
    missingSessionRequest.headers = {
      host: "127.0.0.1",
      authorization: "Bearer scoped-playtest-secret",
      "content-type": "application/json"
    };
    await handleControlApiRequest(
      missingSessionRequest,
      missingSessionResponse as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: runControlFixture(delegatedCalls)
      }
    );
    assert.equal(missingSessionResponse.statusCode, 401);
    assert.equal(delegatedCalls.length, 1);

    const escalatedSessionRequest = runRequest(
      "POST",
      "/control/playtesting/runs",
      {
        workspaceId: WORKSPACE,
        scenario: "tutorial",
        policy: "random",
        seed: "escalated-role"
      }
    );
    escalatedSessionRequest.headers = {
      host: "127.0.0.1",
      authorization: "Bearer scoped-playtest-secret",
      "content-type": "application/json",
      "x-autodev-playtest-session": Buffer.from(
        JSON.stringify({ ...session, role: "root" })
      ).toString("base64url")
    };
    const escalated = responseRecorder();
    await handleControlApiRequest(
      escalatedSessionRequest,
      escalated as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: runControlFixture(delegatedCalls)
      }
    );
    assert.equal(escalated.statusCode, 403);
    assert.equal(delegatedCalls.length, 1);

    const forbiddenSurface = responseRecorder();
    await handleControlApiRequest(
      Object.assign(Readable.from([]), {
        method: "GET",
        url: "/control/providers",
        headers: {
          host: "127.0.0.1",
          authorization: "Bearer scoped-playtest-secret",
          "x-autodev-actor": "agent-1"
        }
      }) as unknown as IncomingMessage,
      forbiddenSurface as unknown as ServerResponse,
      "/control/providers"
    );
    assert.equal(forbiddenSurface.statusCode, 503);
    assert.equal(
      (
        JSON.parse(forbiddenSurface.body ?? "{}") as {
          error?: { code?: string };
        }
      ).error?.code,
      "autodev_control_api_disabled"
    );
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorized human-study API registers consent, imports idempotently, suppresses withdrawal, and exposes no identities", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-human-study-api-"));
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
  const buildA = "a".repeat(40);
  const buildB = "b".repeat(40);
  const studyId = "study-fixture-1";
  const studies = new Map<string, HumanPlaytestStudy>();
  const episodeRows = new Map<string, PlaytestEpisode>();
  const benchmark = {
    benchmarkId: "benchmark-human-1",
    workspaceId: WORKSPACE,
    referenceBuildSha: buildA
  } as PlaytestBenchmark;
  const repository: PlaytestingHumanStudyRepository = {
    getLatestHumanStudy: async (_workspaceId, id) => studies.get(id) ?? null,
    getLatestBenchmark: async () => benchmark,
    listExperiments: async () =>
      ({
        rows: [
          {
            experimentId: "experiment-human-1",
            benchmarkId: benchmark.benchmarkId,
            state: "approved",
            baseline: { id: buildA, version: "1" },
            treatment: { id: buildB, version: "1" }
          }
        ],
        total: 1,
        nextCursor: null
      }) as never,
    getEpisodesByIds: async (_workspaceId, ids) =>
      ids.flatMap((id) => {
        const episode = episodeRows.get(id);
        return episode ? [episode] : [];
      }),
    insertHumanStudy: async (study) => {
      studies.set(study.studyId, study);
    }
  };
  mkdirSync(path.join(root, "approvals"), { recursive: true });
  const approvalRepository = new WorkspacePlaytestApprovalRepository(
    realpathSync(path.join(root, "approvals"))
  );
  approvalRepository.approve(
    {
      schema: "autodev-workspace-playtest-approval-v1",
      revision: 1,
      approvalId: "human-approval-1",
      workspaceId: WORKSPACE,
      approvedBy: "study-operator",
      approvedAt: "2026-10-10T00:00:00.000Z",
      checkoutRoot: path.join(root, "game"),
      buildSha: buildA,
      gameBuild: "human-fixture-game",
      playtestConfigHash: "c".repeat(64),
      adapterImageDigest: "ghcr.io/fixture/adapter@sha256:" + "d".repeat(64),
      workingDirectory: ".",
      adapterCommand: ["./adapter"],
      allowedScenarios: ["tutorial"],
      allowedPolicies: ["random"],
      limits: {
        cpuCores: 1,
        memoryBytes: 64 * 1024 * 1024,
        processCount: 8,
        wallTimeMs: 60_000,
        artifactBytes: 1024 * 1024,
        workerCount: 1,
        episodeCount: 100,
        maxStepsPerEpisode: 10,
        critiqueCount: 0
      },
      retentionDays: 30,
      issueReporting: "disabled",
      humanStudyAllowed: true,
      revokedAt: null,
      revocationReason: null,
      revokedBy: null
    },
    null
  );
  const restricted = new RestrictedHumanResponseRepository({
    rootDirectory: path.join(root, "restricted")
  });
  const token = "human-api-token-0123456789";
  const priorEnv = {
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    viewers: process.env.AUTODEV_CONTROL_VIEWERS,
    operators: process.env.AUTODEV_CONTROL_OPERATORS
  };
  process.env.AUTODEV_CONTROL_API_TOKEN = token;
  process.env.AUTODEV_CONTROL_VIEWERS = "human-study-viewer";
  process.env.AUTODEV_CONTROL_OPERATORS = "human-study-operator";
  const baseOptions = {
    repositoryRoot,
    playtestingHumanStudyRepository: repository,
    restrictedHumanResponseRepository: restricted,
    workspacePlaytestApprovalRepository: approvalRepository
  };
  const callApi = async (
    method: string,
    url: string,
    role: "viewer" | "operator",
    body?: unknown
  ) => {
    const req = runRequest(method, url, body);
    req.headers = {
      ...req.headers,
      authorization: `Bearer ${token}`,
      "x-autodev-actor":
        role === "operator" ? "human-study-operator" : "human-study-viewer"
    };
    const response = responseRecorder();
    await handleControlApiRequest(
      req,
      response as unknown as ServerResponse,
      new URL(url, "http://127.0.0.1").pathname,
      baseOptions
    );
    return {
      status: response.statusCode,
      body: JSON.parse(response.body || "{}") as Record<string, unknown>
    };
  };
  const workspaceQuery = `workspaceId=${encodeURIComponent(WORKSPACE)}`;
  const episodeLink = (participant: string, buildSha: string) => {
    const episodeId = `episode-${participant}-${buildSha === buildA ? "a" : "b"}`;
    episodeRows.set(episodeId, {
      episodeId,
      identity: { workspaceId: WORKSPACE, buildSha }
    } as PlaytestEpisode);
    return episodeId;
  };

  try {
    const registration = await callApi(
      "POST",
      "/control/playtesting/human-studies/register",
      "operator",
      {
        study: {
          schema: "autodev-playtest-human-study-v1",
          studyId,
          version: 1,
          workspaceId: WORKSPACE,
          benchmarkId: benchmark.benchmarkId,
          allowedBuilds: [
            { id: buildA, version: "1" },
            { id: buildB, version: "1" }
          ],
          pxiItemConstructMappingHash: null,
          instrument: "miniPXI",
          instrumentVersion: "miniPXI-v1",
          instrumentHash: "e".repeat(64),
          consentVersion: "consent-v1",
          consentScope: "post-play",
          responseWindowMs: 24 * 60 * 60 * 1000,
          minimumExposureMs: 60_000,
          orderDesign: "AB/BA",
          independentUnit: "participant",
          missingItemPolicy: "null-construct",
          invitedCount: 10,
          eligibleCount: 10,
          respondedCount: 10,
          withdrawnCount: 0,
          createdAt: "2026-10-10T00:00:00.000Z"
        }
      }
    );
    assert.equal(registration.status, 201);
    assert.equal((registration.body as { approved?: boolean }).approved, true);

    const rows: Record<string, string>[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const participantId = `participant-${index}`;
      const startedAt = "2026-10-10T00:00:00.000Z";
      const endedAt = "2026-10-10T00:10:00.000Z";
      const submittedAt = "2026-10-10T00:15:00.000Z";
      const consent = await callApi(
        "POST",
        `/control/playtesting/human-studies/${studyId}/consents?${workspaceQuery}`,
        "operator",
        {
          participantId,
          consentVersion: "consent-v1",
          consentScope: "post-play"
        }
      );
      assert.equal(consent.status, 201);
      rows.push(
        ...[
          {
            buildId: buildA,
            order: "A-first",
            episodeId: episodeLink(participantId, buildA)
          },
          {
            buildId: buildB,
            order: "B-first",
            episodeId: episodeLink(participantId, buildB)
          }
        ].map(({ buildId, order, episodeId }, armIndex) => ({
          studyId,
          responseId: `${participantId}-response-${armIndex}`,
          revision: "1",
          supersedes: "",
          participantId,
          consentVersion: "consent-v1",
          consentScope: "post-play",
          instrument: "miniPXI",
          instrumentVersion: "miniPXI-v1",
          instrumentHash: "e".repeat(64),
          workspaceId: WORKSPACE,
          buildId,
          buildVersion: "1",
          buildHash: "",
          episodeId,
          exposureStartedAt: startedAt,
          exposureEndedAt: endedAt,
          order,
          submittedAt,
          completionStatus: "completed",
          enj: "1",
          enjMissingReason: ""
        }))
      );
    }
    const manifest = {
      studyIdColumn: "studyId",
      responseIdColumn: "responseId",
      revisionColumn: "revision",
      supersedesColumn: "supersedes",
      participantIdColumn: "participantId",
      consentVersionColumn: "consentVersion",
      consentScopeColumn: "consentScope",
      instrumentColumn: "instrument",
      instrumentVersionColumn: "instrumentVersion",
      instrumentHashColumn: "instrumentHash",
      workspaceIdColumn: "workspaceId",
      buildIdColumn: "buildId",
      buildVersionColumn: "buildVersion",
      buildHashColumn: "buildHash",
      episodeIdColumn: "episodeId",
      exposureStartedAtColumn: "exposureStartedAt",
      exposureEndedAtColumn: "exposureEndedAt",
      orderColumn: "order",
      submittedAtColumn: "submittedAt",
      completionStatusColumn: "completionStatus",
      items: [
        {
          itemId: "ENJ",
          valueColumn: "enj",
          missingReasonColumn: "enjMissingReason"
        }
      ]
    };
    const importUrl = `/control/playtesting/human-studies/${studyId}/import?${workspaceQuery}`;
    const exportText = JSON.stringify(rows);
    const firstImport = await callApi("POST", importUrl, "operator", {
      format: "json",
      manifest,
      exportText
    });
    assert.equal(firstImport.status, 200);
    assert.equal(firstImport.body.acceptedCount, 10);
    assert.doesNotMatch(
      JSON.stringify(firstImport.body),
      /participant-1|response-0/u
    );

    const repeatedImport = await callApi("POST", importUrl, "operator", {
      format: "json",
      manifest,
      exportText
    });
    assert.equal(repeatedImport.body.acceptedCount, 0);
    assert.equal(repeatedImport.body.unchangedCount, 10);

    const summaryUrl = `/control/playtesting/human-studies/${studyId}/validation?${workspaceQuery}&buildSha=${buildA}&aBuildSha=${buildA}&bBuildSha=${buildB}`;
    const summary = await callApi("GET", summaryUrl, "viewer");
    assert.equal(summary.status, 200);
    assert.equal(
      (summary.body.summary as { retainedParticipants: number })
        .retainedParticipants,
      5
    );
    assert.doesNotMatch(
      JSON.stringify(summary.body),
      /participant-1|response-0/u
    );

    const withdrawal = await callApi(
      "POST",
      `/control/playtesting/human-studies/${studyId}/withdrawals?${workspaceQuery}`,
      "operator",
      { participantId: "participant-5" }
    );
    assert.equal(withdrawal.status, 200);
    assert.equal(withdrawal.body.retainedParticipants, null);
    const afterWithdrawal = await callApi("GET", summaryUrl, "viewer");
    const suppressed = afterWithdrawal.body.summary as {
      retainedParticipants: number | null;
      suppressionState: string;
    };
    assert.equal(suppressed.retainedParticipants, null);
    assert.equal(suppressed.suppressionState, "suppressed");
    assert.deepEqual(
      restricted.getTombstonedHistory(studyId).map((item) => item.status),
      ["withdrawn"]
    );
  } finally {
    if (priorEnv.token === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = priorEnv.token;
    if (priorEnv.viewers === undefined)
      delete process.env.AUTODEV_CONTROL_VIEWERS;
    else process.env.AUTODEV_CONTROL_VIEWERS = priorEnv.viewers;
    if (priorEnv.operators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = priorEnv.operators;
    rmSync(root, { recursive: true, force: true });
  }
});

test("episode windows are workspace-bound, integrity-checked, and step-filtered", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-playtesting-window-"));
  try {
    const store = new PlaytestArtifactStore({
      workspaceId: WORKSPACE,
      rootDirectory: root
    });
    const written = store.writeWindow({
      entries: [
        { type: "step", step: 0, actionId: "advance" },
        { type: "event", event: { step: 1, eventId: "event-1" } },
        { type: "step", step: 8, actionId: "finish" }
      ]
    });
    const episode = {
      episodeId: "episode-window",
      trace: { kind: "replay-segment", id: written.reference.artifactId }
    };
    const repository = readRepository({
      getEpisode: async () => episode as never
    });
    const response = await call(
      "GET",
      `/control/playtesting/episodes/episode-window/windows/${written.reference.artifactId}?workspaceId=${encodeURIComponent(WORKSPACE)}&startStep=1&endStep=4`,
      { repository, artifactStoreForWorkspace: () => store }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.entries, [
      { type: "event", event: { step: 1, eventId: "event-1" } }
    ]);
    assert.equal(response.body.sourceLineCount, 3);
    assert.equal(response.body.omittedLineCount, 2);

    const unlinked = await call(
      "GET",
      `/control/playtesting/episodes/episode-window/windows/other-window?workspaceId=${encodeURIComponent(WORKSPACE)}&startStep=1&endStep=4`,
      { repository, artifactStoreForWorkspace: () => store }
    );
    assert.equal(unlinked.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("episode window API rejects invalid or oversized ranges before reading artifacts", async () => {
  let reads = 0;
  const response = await call(
    "GET",
    `/control/playtesting/episodes/episode-window/windows/window-1?workspaceId=${encodeURIComponent(WORKSPACE)}&startStep=0&endStep=4096`,
    {
      repository: readRepository({
        getEpisode: async () => {
          reads += 1;
          return null;
        }
      })
    }
  );
  assert.equal(response.status, 400);
  assert.equal(reads, 0);
});

test("frame API serves only linked, bounded, signature-checked raster images", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-playtesting-frame-"));
  try {
    const store = new PlaytestArtifactStore({
      workspaceId: WORKSPACE,
      rootDirectory: root
    });
    const imageBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
    ]);
    const written = store.writeArtifact({
      mediaType: "image/png",
      bytes: imageBytes
    });
    const episode = {
      episodeId: "episode-frame",
      frames: [
        { kind: "frame", id: written.reference.artifactId, frameIndex: 0 }
      ]
    };
    const repository = readRepository({
      getEpisode: async () => episode as never
    });
    const response = responseRecorder();
    await handlePlaytestingControlApiRequest(
      request(
        "GET",
        `/control/playtesting/episodes/episode-frame/media/${written.reference.artifactId}?workspaceId=${encodeURIComponent(WORKSPACE)}`
      ),
      response as unknown as ServerResponse,
      `/control/playtesting/episodes/episode-frame/media/${written.reference.artifactId}`,
      { actor: "console-viewer", role: "viewer" },
      {
        readWorkspaceCatalog: catalog,
        repository,
        artifactStoreForWorkspace: () => store
      }
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["content-length"], imageBytes.byteLength);

    const unlinked = responseRecorder();
    await handlePlaytestingControlApiRequest(
      request(
        "GET",
        `/control/playtesting/episodes/episode-frame/media/unlinked-frame?workspaceId=${encodeURIComponent(WORKSPACE)}`
      ),
      unlinked as unknown as ServerResponse,
      "/control/playtesting/episodes/episode-frame/media/unlinked-frame",
      { actor: "console-viewer", role: "viewer" },
      {
        readWorkspaceCatalog: catalog,
        repository,
        artifactStoreForWorkspace: () => store
      }
    );
    assert.equal(unlinked.statusCode, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
