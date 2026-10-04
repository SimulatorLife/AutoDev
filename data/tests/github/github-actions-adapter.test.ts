import assert from "node:assert/strict";
import test from "node:test";

import type { GithubWorkflowRun } from "@simulatorlife/autodev-core";

import {
  computeRunStats,
  GithubActionsAdapter,
  GithubActionsApiError
} from "../../src/github/github-actions-adapter.ts";

function runForStats(
  id: number,
  status: string,
  conclusion: string | null
): GithubWorkflowRun {
  return {
    id,
    name: null,
    workflowId: 10,
    workflowPath: ".github/workflows/ci.yml",
    headBranch: null,
    headSha: "",
    event: "push",
    status,
    conclusion,
    htmlUrl: "",
    createdAt: "",
    updatedAt: "",
    runAttempt: 1
  };
}

test("GithubActionsAdapter uses fixed https://api.github.com origin and sends standard GitHub headers", async () => {
  let capturedUrl = "";
  let capturedHeaders: HeadersInit | undefined;
  let capturedRedirect: RequestRedirect | undefined;

  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = init?.headers;
    capturedRedirect = init?.redirect;
    return Response.json(
      { total_count: 0, workflows: [] },
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  const adapter = new GithubActionsAdapter({ fetchFn: mockFetch });
  const result = await adapter.listWorkflows(
    "SimulatorLife",
    "AutoDev",
    "ghp_test_secret_token_123"
  );

  assert.deepEqual(result, []);
  assert.ok(
    capturedUrl.startsWith(
      "https://api.github.com/repos/SimulatorLife/AutoDev/actions/workflows"
    )
  );

  const headers = capturedHeaders as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer ghp_test_secret_token_123");
  assert.equal(headers.Accept, "application/vnd.github+json");
  assert.equal(headers["X-GitHub-Api-Version"], "2026-03-10");
  assert.equal(headers["User-Agent"], "AutoDev-Control-API");
  assert.equal(capturedRedirect, "error");
});

test("GithubActionsAdapter rejects dot path segments before any fetch", async () => {
  let fetchCalls = 0;
  const adapter = new GithubActionsAdapter({
    fetchFn: async () => {
      fetchCalls++;
      return Response.json({ workflows: [] });
    }
  });

  for (const [owner, repo] of [
    [".", "AutoDev"],
    ["..", "AutoDev"],
    ["SimulatorLife", "."],
    ["SimulatorLife", ".."],
    ["SimulatorLife", "%2e%2e"]
  ] as const) {
    await assert.rejects(
      () => adapter.listWorkflows(owner, repo, "safe-token"),
      { code: "invalid_repository" }
    );
  }
  assert.equal(fetchCalls, 0);
});

test("GithubActionsAdapter parses workflows and extracts valid definitions", async () => {
  const mockWorkflows = [
    {
      id: 101,
      node_id: "MDg6V29ya2Zsb3cxMDE=",
      name: "Scheduler",
      path: ".github/workflows/_scheduler.yml",
      state: "active",
      html_url:
        "https://github.com/SimulatorLife/AutoDev/actions/workflows/_scheduler.yml",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z"
    },
    {
      id: 102,
      node_id: "MDg6V29ya2Zsb3cxMDI=",
      name: "Target Validation",
      path: ".github/workflows/target-validation.yml",
      state: "disabled_manually",
      html_url:
        "https://github.com/SimulatorLife/AutoDev/actions/workflows/target-validation.yml",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z"
    }
  ];

  const mockFetch: typeof fetch = async () => {
    return Response.json(
      { total_count: 2, workflows: mockWorkflows },
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  const adapter = new GithubActionsAdapter({ fetchFn: mockFetch });
  const workflows = await adapter.listWorkflows(
    "SimulatorLife",
    "AutoDev",
    "test-token"
  );

  assert.equal(workflows.length, 2);
  assert.equal(workflows[0]?.id, 101);
  assert.equal(workflows[0]?.name, "Scheduler");
  assert.equal(workflows[0]?.path, ".github/workflows/_scheduler.yml");
  assert.equal(workflows[0]?.state, "active");
  assert.equal(
    workflows[0]?.htmlUrl,
    "https://github.com/SimulatorLife/AutoDev/actions/workflows/_scheduler.yml"
  );
  assert.equal(workflows[1]?.state, "disabled_manually");
});

test("GithubActionsAdapter bounds run query limits and extracts run facts", async () => {
  let requestedUrl = "";

  const mockRuns = [
    {
      id: 5001,
      name: "Scheduler",
      workflow_id: 101,
      path: ".github/workflows/_scheduler.yml",
      head_branch: "main",
      head_sha: "c47aeaa297b555fbd0b3cf961028bc8ae06485ed",
      event: "schedule",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/SimulatorLife/AutoDev/actions/runs/5001",
      created_at: "2026-10-04T05:00:00Z",
      updated_at: "2026-10-04T05:05:00Z",
      run_attempt: 1
    },
    {
      id: 5002,
      name: "Target Validation",
      workflow_id: 102,
      path: ".github/workflows/target-validation.yml",
      head_branch: "feat/tests",
      head_sha: "32917704044df54124558718110ec1695f83b0a3",
      event: "push",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/SimulatorLife/AutoDev/actions/runs/5002",
      created_at: "2026-10-04T05:10:00Z",
      updated_at: "2026-10-04T05:15:00Z",
      run_attempt: 1
    },
    {
      id: 5003,
      name: "Janitor",
      workflow_id: 103,
      path: ".github/workflows/target-pr-janitor.yml",
      head_branch: "main",
      head_sha: "6031b1d2a886961d369f1e9d1e82f05026a4edcc",
      event: "schedule",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/SimulatorLife/AutoDev/actions/runs/5003",
      created_at: "2026-10-04T05:20:00Z",
      updated_at: "2026-10-04T05:22:00Z",
      run_attempt: 1
    }
  ];

  const mockFetch: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json(
      { total_count: 3, workflow_runs: mockRuns },
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  const adapter = new GithubActionsAdapter({ fetchFn: mockFetch });
  // Requesting 999 runs should be clamped to MAX_BOUNDED_RUNS (100).
  const runs = await adapter.listRecentRuns(
    "SimulatorLife",
    "AutoDev",
    "test-token",
    { limit: 999 }
  );

  assert.ok(requestedUrl.includes("per_page=100"));
  assert.equal(runs.length, 3);
  assert.equal(runs[0]?.id, 5001);
  assert.equal(runs[0]?.workflowId, 101);
  assert.equal(runs[0]?.headSha, "c47aeaa297b555fbd0b3cf961028bc8ae06485ed");
  assert.equal(runs[0]?.status, "completed");
  assert.equal(runs[0]?.conclusion, "success");
  assert.equal(runs[2]?.status, "in_progress");
  assert.equal(runs[2]?.conclusion, null);
});

test("GithubActionsAdapter rejects non-numeric run limits before fetch", async () => {
  let fetchCalls = 0;
  const adapter = new GithubActionsAdapter({
    fetchFn: async () => {
      fetchCalls++;
      return Response.json({ workflow_runs: [] });
    }
  });

  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
    const options = { limit } as unknown as { limit?: number };
    await assert.rejects(
      () =>
        adapter.listRecentRuns(
          "SimulatorLife",
          "AutoDev",
          "safe-token",
          options
        ),
      { code: "invalid_limit" }
    );
  }
  assert.equal(fetchCalls, 0);
});

test("GithubActionsAdapter reports workflow collections beyond its page bound as partial", async () => {
  let requestedUrl = "";
  const workflows = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `Workflow ${index + 1}`,
    path: `.github/workflows/workflow-${index + 1}.yml`,
    state: "active"
  }));
  const adapter = new GithubActionsAdapter({
    fetchFn: async (input) => {
      requestedUrl = String(input);
      return Response.json({ total_count: 101, workflows });
    }
  });

  await assert.rejects(
    () => adapter.listWorkflows("SimulatorLife", "AutoDev", "safe-token"),
    { code: "partial_result" }
  );
  assert.ok(requestedUrl.includes("per_page=100"));
});

test("GithubActionsAdapter rejects oversized streamed responses without relying on Content-Length", async () => {
  const largeChunk = new Uint8Array(1_048_577);
  let contentLengthHeader: string | null = "present";
  const mockFetch: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"workflows":[]'));
        controller.enqueue(largeChunk);
        controller.close();
      }
    });
    const response = new Response(body, { status: 200 });
    contentLengthHeader = response.headers.get("content-length");
    return response;
  };

  const adapter = new GithubActionsAdapter({ fetchFn: mockFetch });
  await assert.rejects(
    () => adapter.listWorkflows("SimulatorLife", "AutoDev", "safe-token"),
    (error: unknown) => {
      assert.ok(error instanceof GithubActionsApiError);
      assert.equal(error.code, "response_too_large");
      assert.equal(error.message.includes("safe-token"), false);
      return true;
    }
  );
  assert.equal(contentLengthHeader, null);
});

test("GithubActionsAdapter preserves auth and rate status codes when error bodies are oversized", async () => {
  for (const [status, code] of [
    [401, "unauthorized"],
    [429, "rate_limited"]
  ] as const) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
        controller.close();
      }
    });
    const adapter = new GithubActionsAdapter({
      fetchFn: async () =>
        new Response(body, {
          status,
          headers: { "Content-Length": "1048577" }
        })
    });

    await assert.rejects(
      () => adapter.listWorkflows("SimulatorLife", "AutoDev", "safe-token"),
      (error: unknown) => {
        assert.ok(error instanceof GithubActionsApiError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        return true;
      }
    );
  }
});

test("GithubActionsAdapter keeps its timeout active while consuming a response body", async () => {
  let cancelled = false;
  let delayedChunk: ReturnType<typeof setTimeout> | undefined;
  const mockFetch: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"workflows":'));
        delayedChunk = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("[]}"));
          controller.close();
        }, 200);
      },
      cancel() {
        cancelled = true;
        if (delayedChunk) clearTimeout(delayedChunk);
      }
    });
    return new Response(body, { status: 200 });
  };

  const adapter = new GithubActionsAdapter({
    fetchFn: mockFetch,
    timeoutMs: 20
  });
  await assert.rejects(
    () => adapter.listWorkflows("SimulatorLife", "AutoDev", "safe-token"),
    { code: "timeout" }
  );
  assert.equal(cancelled, true);
});

test("GithubActionsAdapter rejects malformed successful payload collection fields", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    const payload = url.includes("/actions/workflows")
      ? { total_count: 0 }
      : { total_count: 0, workflow_runs: {} };
    return Response.json(payload, { status: 200 });
  };
  const adapter = new GithubActionsAdapter({ fetchFn: mockFetch });

  await assert.rejects(
    () => adapter.listWorkflows("SimulatorLife", "AutoDev", "safe-token"),
    { code: "invalid_payload" }
  );
  await assert.rejects(
    () => adapter.listRecentRuns("SimulatorLife", "AutoDev", "safe-token"),
    { code: "invalid_payload" }
  );
});

test("GithubActionsAdapter rejects malformed workflow and run records instead of dropping them", async () => {
  const validWorkflow = {
    id: 10,
    name: "CI",
    path: ".github/workflows/ci.yml",
    state: "active"
  };
  const validRun = {
    id: 20,
    workflow_id: 10,
    event: "push",
    status: "completed"
  };
  const makeAdapter = (
    workflows: unknown,
    workflowRuns: unknown
  ): GithubActionsAdapter =>
    new GithubActionsAdapter({
      fetchFn: async (input) =>
        Response.json(
          String(input).includes("/actions/workflows")
            ? { workflows }
            : { workflow_runs: workflowRuns }
        )
    });

  for (const workflows of [
    [validWorkflow, { ...validWorkflow, state: 4 }],
    [null]
  ]) {
    await assert.rejects(
      () =>
        makeAdapter(workflows, []).listWorkflows(
          "SimulatorLife",
          "AutoDev",
          "safe-token"
        ),
      { code: "invalid_payload" }
    );
  }

  for (const workflowRuns of [[validRun, { ...validRun, status: 9 }], [null]]) {
    await assert.rejects(
      () =>
        makeAdapter([], workflowRuns).listRecentRuns(
          "SimulatorLife",
          "AutoDev",
          "safe-token"
        ),
      { code: "invalid_payload" }
    );
  }
});

test("GithubActionsAdapter treats genuinely empty workflow and run arrays as authoritative zero", async () => {
  const adapter = new GithubActionsAdapter({
    fetchFn: async () => Response.json({ workflows: [], workflow_runs: [] })
  });

  assert.deepEqual(
    await adapter.listWorkflows("SimulatorLife", "AutoDev", "safe-token"),
    []
  );
  assert.deepEqual(
    await adapter.listRecentRuns("SimulatorLife", "AutoDev", "safe-token"),
    []
  );
});

test("computeRunStats calculates precise statistics and never invents synthetic health", () => {
  // Empty runs list: total 0, success rate null (no concluded runs).
  const emptyStats = computeRunStats([]);
  assert.deepEqual(emptyStats, {
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    inProgressRuns: 0,
    cancelledRuns: 0,
    successRate: null
  });

  const sampleRuns = [
    {
      id: 1,
      name: "run 1",
      workflowId: 10,
      workflowPath: ".github/workflows/a.yml",
      headBranch: "main",
      headSha: "abc",
      event: "push",
      status: "completed",
      conclusion: "success",
      htmlUrl: "https://github.com/test/1",
      createdAt: "2026-10-04T00:00:00Z",
      updatedAt: "2026-10-04T00:01:00Z",
      runAttempt: 1
    },
    {
      id: 2,
      name: "run 2",
      workflowId: 10,
      workflowPath: ".github/workflows/a.yml",
      headBranch: "main",
      headSha: "def",
      event: "push",
      status: "completed",
      conclusion: "failure",
      htmlUrl: "https://github.com/test/2",
      createdAt: "2026-10-04T00:02:00Z",
      updatedAt: "2026-10-04T00:03:00Z",
      runAttempt: 1
    },
    {
      id: 3,
      name: "run 3",
      workflowId: 11,
      workflowPath: ".github/workflows/b.yml",
      headBranch: "main",
      headSha: "ghi",
      event: "schedule",
      status: "in_progress",
      conclusion: null,
      htmlUrl: "https://github.com/test/3",
      createdAt: "2026-10-04T00:04:00Z",
      updatedAt: "2026-10-04T00:05:00Z",
      runAttempt: 1
    },
    {
      id: 4,
      name: "run 4",
      workflowId: 11,
      workflowPath: ".github/workflows/b.yml",
      headBranch: "main",
      headSha: "jkl",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "cancelled",
      htmlUrl: "https://github.com/test/4",
      createdAt: "2026-10-04T00:06:00Z",
      updatedAt: "2026-10-04T00:07:00Z",
      runAttempt: 1
    },
    {
      id: 5,
      name: "run 5",
      workflowId: 12,
      workflowPath: ".github/workflows/c.yml",
      headBranch: "main",
      headSha: "mno",
      event: "schedule",
      status: "completed",
      conclusion: "timed_out",
      htmlUrl: "https://github.com/test/5",
      createdAt: "2026-10-04T00:08:00Z",
      updatedAt: "2026-10-04T00:09:00Z",
      runAttempt: 1
    }
  ];

  const stats = computeRunStats(sampleRuns);
  assert.equal(stats.totalRuns, 5);
  assert.equal(stats.successfulRuns, 1);
  assert.equal(stats.failedRuns, 2); // 1 failure + 1 timed_out
  assert.equal(stats.inProgressRuns, 1);
  assert.equal(stats.cancelledRuns, 1);
  // Concluded runs: 1 success + 2 failed + 1 cancelled = 4 concluded runs.
  // Success rate: 1 / 4 = 0.25 (25%)
  assert.equal(stats.successRate, 0.25);
});

test("computeRunStats divides successes by every sampled completed run", () => {
  const stats = computeRunStats([
    runForStats(1, "completed", "success"),
    runForStats(2, "completed", "startup_failure"),
    runForStats(3, "completed", "neutral"),
    runForStats(4, "completed", "cancelled"),
    runForStats(5, "completed", null),
    runForStats(6, "in_progress", "success")
  ]);

  assert.equal(stats.totalRuns, 6);
  assert.equal(stats.successfulRuns, 1);
  assert.equal(stats.failedRuns, 1);
  assert.equal(stats.cancelledRuns, 1);
  assert.equal(stats.inProgressRuns, 1);
  assert.equal(stats.successRate, 0.2);
  assert.equal(
    computeRunStats([runForStats(7, "in_progress", null)]).successRate,
    null
  );
});

test("fetchRuntimeSnapshot retrieves workflows, correlated runs, and scoped statistics", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/actions/workflows")) {
      return Response.json(
        {
          total_count: 1,
          workflows: [
            {
              id: 999,
              name: "Agent CI",
              path: ".github/workflows/ci.yml",
              state: "active",
              html_url: "https://github.com/SimulatorLife/AutoDev/actions/ci",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z"
            }
          ]
        },
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("/actions/runs")) {
      return Response.json(
        {
          total_count: 1,
          workflow_runs: [
            {
              id: 7001,
              name: "Agent CI",
              workflow_id: 999,
              // path omitted by API, should be correlated from workflows
              head_branch: "main",
              head_sha: "abcd123",
              event: "push",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/runs/7001",
              created_at: "2026-10-04T00:00:00Z",
              updated_at: "2026-10-04T00:05:00Z",
              run_attempt: 1
            }
          ]
        },
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const adapter = new GithubActionsAdapter({ fetchFn: mockFetch });
  const snapshot = await adapter.fetchRuntimeSnapshot(
    "SimulatorLife",
    "AutoDev",
    "token"
  );

  assert.equal(snapshot.workflows.length, 1);
  assert.equal(snapshot.workflows[0]?.state, "active");
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0]?.workflowPath, ".github/workflows/ci.yml");
  assert.equal(snapshot.stats.totalRuns, 1);
  assert.equal(snapshot.stats.successfulRuns, 1);
  assert.equal(snapshot.stats.successRate, 1);
});

test("GithubActionsAdapter handles errors without leaking secrets or tokens", async () => {
  const SECRET_TOKEN = "ghp_SUPER_SECRET_TOKEN_DO_NOT_LEAK";

  // Case 1: 401 Unauthorized
  const mock401: typeof fetch = async () =>
    Response.json(
      {
        message: `Bad credentials token=${SECRET_TOKEN}`
      },
      { status: 401, headers: { "Content-Type": "application/json" } }
    );

  const adapter401 = new GithubActionsAdapter({ fetchFn: mock401 });
  await assert.rejects(
    async () =>
      adapter401.listWorkflows("SimulatorLife", "AutoDev", SECRET_TOKEN),
    (err: unknown) => {
      assert.ok(err instanceof GithubActionsApiError);
      assert.equal(err.status, 401);
      assert.equal(err.message.includes(SECRET_TOKEN), false);
      assert.ok(err.message.includes("[REDACTED]"));
      return true;
    }
  );

  // Case 2: Network failure throwing an Error containing the token
  const mockNetError: typeof fetch = async () => {
    throw new Error(`Connection reset with ${SECRET_TOKEN}`);
  };
  const adapterNet = new GithubActionsAdapter({ fetchFn: mockNetError });
  await assert.rejects(
    async () =>
      adapterNet.listRecentRuns("SimulatorLife", "AutoDev", SECRET_TOKEN),
    (err: unknown) => {
      assert.ok(err instanceof GithubActionsApiError);
      assert.equal(err.status, 502);
      assert.equal(err.message.includes(SECRET_TOKEN), false);
      assert.ok(err.message.includes("[REDACTED]"));
      return true;
    }
  );

  // Case 3: Empty token is rejected immediately
  const adapterEmpty = new GithubActionsAdapter();
  await assert.rejects(
    async () => adapterEmpty.listWorkflows("SimulatorLife", "AutoDev", ""),
    { code: "token_missing" }
  );

  // Case 4: Invalid repo coordinates are rejected immediately
  await assert.rejects(
    async () => adapterEmpty.listWorkflows("invalid/owner", "AutoDev", "token"),
    { code: "invalid_repository" }
  );
});
