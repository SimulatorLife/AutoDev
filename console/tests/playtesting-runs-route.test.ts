import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS
} from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";

import { GET as GET_REQUEST } from "../app/api/playtesting/runs/by-request/route.ts";
import { GET, POST } from "../app/api/playtesting/runs/route.ts";

const WORKSPACE_ID = "owner/game";
const API_PATH = "http://console.test/api/playtesting/runs";

function request(assignments: readonly unknown[]): NextRequest {
  const body = new URLSearchParams({
    launchRequest: JSON.stringify({
      schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
      mode: "adapter-accelerated",
      workspaceId: WORKSPACE_ID,
      requestId: "console-route-request-1",
      capabilityRevision: "a".repeat(64),
      operation: { kind: "batch", assignments }
    })
  });
  return new NextRequest(API_PATH, {
    method: "POST",
    headers: {
      accept: "application/json",
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
}

test("same-origin route forwards the canonical 1,000-assignment batch without truncation", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "r".repeat(64);
  let forwarded: unknown = null;
  globalThis.fetch = (async (_input, init) => {
    forwarded = JSON.parse(String(init?.body));
    return Response.json(
      {
        schema: "autodev-control-playtesting-run-started-v3",
        workspaceId: WORKSPACE_ID,
        batchId: "batch-route-1000",
        assignmentCount: PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
        assignmentIds: Array.from(
          { length: PLAYTESTS_MAX_BATCH_ASSIGNMENTS },
          (_, index) => `a-${String(index + 1).padStart(4, "0")}`
        ),
        sessions: Array.from(
          { length: PLAYTESTS_MAX_BATCH_ASSIGNMENTS },
          (_, index) => {
            const assignmentId = `a-${String(index + 1).padStart(4, "0")}`;
            return {
              assignmentId,
              episodeId: `batch-route-1000.${assignmentId}`
            };
          }
        ),
        createdAt: "2026-10-12T00:00:00.000Z",
        status: "running"
      },
      { status: 202 }
    );
  }) as typeof fetch;
  try {
    const assignments = Array.from(
      { length: PLAYTESTS_MAX_BATCH_ASSIGNMENTS },
      (_, index) => ({
        scenario: "tutorial",
        policy: "random",
        seed: "seed-" + String(index + 1),
        maxSteps: 20
      })
    );
    const response = await POST(request(assignments));
    assert.equal(response.status, 202);
    const launch = forwarded as {
      readonly operation: {
        readonly assignments: readonly unknown[];
      };
    };
    assert.equal(
      launch.operation.assignments.length,
      PLAYTESTS_MAX_BATCH_ASSIGNMENTS
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

test("same-origin route rejects assignment 1,001 before contacting Runtime", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({});
  }) as typeof fetch;
  try {
    const assignments = Array.from(
      { length: PLAYTESTS_MAX_BATCH_ASSIGNMENTS + 1 },
      (_, index) => ({
        scenario: "tutorial",
        policy: "random",
        seed: "seed-" + String(index + 1),
        maxSteps: 20
      })
    );
    const response = await POST(request(assignments));
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("active-runs GET reads the typed owner and rejects a non-canonical workspace", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "r".repeat(64);
  let requested = "";
  globalThis.fetch = (async (input) => {
    requested = String(input);
    return Response.json(
      {
        schema: "autodev-control-playtesting-runs-v2",
        workspaceId: WORKSPACE_ID,
        runs: [
          {
            batchId: "batch-live-1",
            assignmentCount: 3,
            createdAt: "2026-10-12T00:00:00.000Z",
            sessions: [
              { assignmentId: "a-0001", episodeId: "batch-live-1.a-0001" },
              { assignmentId: "a-0002", episodeId: "batch-live-1.a-0002" },
              { assignmentId: "a-0003", episodeId: "batch-live-1.a-0003" }
            ],
            status: {
              batchId: "batch-live-1",
              status: "running",
              cancellationReason: null,
              result: null,
              error: null
            }
          }
        ]
      },
      { status: 200 }
    );
  }) as typeof fetch;
  try {
    const response = await GET(
      new NextRequest(
        `${API_PATH}?workspaceId=${encodeURIComponent(WORKSPACE_ID)}`
      )
    );
    assert.equal(response.status, 200);
    assert.match(requested, /\/control\/playtesting\/runs\?/);
    // The live record must reach the Console in one read, so watching many
    // batches needs no per-batch status request.
    const body = (await response.json()) as {
      kind: string;
      data: { runs: readonly { status: { status: string } }[] };
    };
    assert.equal(body.kind, "ok");
    assert.equal(body.data.runs[0]?.status.status, "running");
    assert.equal(
      response.headers.get("cache-control"),
      "no-store",
      "live batch state must never be cached"
    );

    const rejected = await GET(
      new NextRequest(`${API_PATH}?workspaceId=not-canonical`)
    );
    assert.equal(rejected.status, 400);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

test("active-runs GET refuses a response whose live status is not its own batch", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "r".repeat(64);
  globalThis.fetch = (async () =>
    Response.json(
      {
        schema: "autodev-control-playtesting-runs-v2",
        workspaceId: WORKSPACE_ID,
        runs: [
          {
            batchId: "batch-a",
            assignmentCount: 1,
            createdAt: "2026-10-12T00:00:00.000Z",
            sessions: [{ assignmentId: "a-0001", episodeId: "batch-a.a-0001" }],
            status: {
              batchId: "batch-b",
              status: "running",
              cancellationReason: null,
              result: null,
              error: null
            }
          }
        ]
      },
      { status: 200 }
    )) as typeof fetch;
  try {
    const response = await GET(
      new NextRequest(
        `${API_PATH}?workspaceId=${encodeURIComponent(WORKSPACE_ID)}`
      )
    );
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

test("active-runs GET refuses duplicate assignment-to-session references", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "r".repeat(64);
  globalThis.fetch = (async () =>
    Response.json(
      {
        schema: "autodev-control-playtesting-runs-v2",
        workspaceId: WORKSPACE_ID,
        runs: [
          {
            batchId: "batch-a",
            assignmentCount: 2,
            createdAt: "2026-10-12T00:00:00.000Z",
            sessions: [
              { assignmentId: "a-0001", episodeId: "batch-a.a-0001" },
              { assignmentId: "a-0001", episodeId: "batch-a.a-0002" }
            ],
            status: {
              batchId: "batch-a",
              status: "running",
              cancellationReason: null,
              result: null,
              error: null
            }
          }
        ]
      },
      { status: 200 }
    )) as typeof fetch;
  try {
    const response = await GET(
      new NextRequest(
        `${API_PATH}?workspaceId=${encodeURIComponent(WORKSPACE_ID)}`
      )
    );
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

test("request recovery reads the actor/workspace-scoped immutable receipt without starting another run", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "r".repeat(64);
  let requested = "";
  globalThis.fetch = (async (input) => {
    requested = String(input);
    return Response.json(
      {
        schema: "autodev-control-playtesting-run-request-v2",
        workspaceId: WORKSPACE_ID,
        requestId: "console-recovery-1",
        state: "accepted",
        batchId: "batch-route-recovered",
        assignmentCount: 1,
        assignmentIds: ["a-0001"],
        sessions: [
          { assignmentId: "a-0001", episodeId: "batch-route-recovered.a-0001" }
        ],
        createdAt: "2026-10-16T12:00:00.000Z",
        status: "completed"
      },
      { status: 200 }
    );
  }) as typeof fetch;
  try {
    const response = await GET_REQUEST(
      new NextRequest(
        `${API_PATH}/by-request?workspaceId=${encodeURIComponent(WORKSPACE_ID)}&requestId=console-recovery-1`
      )
    );
    assert.equal(response.status, 200);
    assert.match(requested, /\/control\/playtesting\/runs\/by-request\?/u);
    assert.match(requested, /param_requestId|requestId=console-recovery-1/u);
    const body = (await response.json()) as {
      readonly kind: string;
      readonly data: {
        readonly state: string;
        readonly batchId: string;
        readonly assignmentIds: readonly string[];
        readonly sessions: readonly {
          readonly assignmentId: string;
          readonly episodeId: string;
        }[];
        readonly status: string;
      };
    };
    assert.equal(body.kind, "ok");
    assert.equal(body.data.state, "accepted");
    assert.equal(body.data.batchId, "batch-route-recovered");
    assert.deepEqual(body.data.assignmentIds, ["a-0001"]);
    assert.deepEqual(body.data.sessions, [
      { assignmentId: "a-0001", episodeId: "batch-route-recovered.a-0001" }
    ]);
    assert.equal(body.data.status, "completed");
    assert.equal(response.headers.get("cache-control"), "no-store");

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({});
    }) as typeof fetch;
    const invalid = await GET_REQUEST(
      new NextRequest(
        `${API_PATH}/by-request?workspaceId=${encodeURIComponent(WORKSPACE_ID)}&requestId=bad%20id`
      )
    );
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

function visualRequest(launchPayload: unknown): NextRequest {
  const body = new URLSearchParams({
    launchRequest: JSON.stringify(launchPayload)
  });
  return new NextRequest(API_PATH, {
    method: "POST",
    headers: {
      accept: "application/json",
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
}

const VALID_VISUAL_LIMITS = {
  episodeCount: 1,
  maxStepsPerEpisode: 50,
  wallTimeMs: 120_000,
  smartRequestsPerEpisode: 30,
  smartTokensPerEpisode: 20_000,
  screenshotCountPerEpisode: 50,
  artifactBytesPerEpisode: 33_554_432
};

test("autonomous-visual launch accepts strictly valid payload and forwards to Runtime", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "r".repeat(64);
  let forwarded: unknown = null;
  globalThis.fetch = (async (_input, init) => {
    forwarded = JSON.parse(String(init?.body));
    return Response.json(
      {
        schema: "autodev-control-playtesting-run-started-v3",
        workspaceId: WORKSPACE_ID,
        batchId: "batch-visual-1",
        assignmentCount: 1,
        assignmentIds: ["vis-0001"],
        sessions: [
          { assignmentId: "vis-0001", episodeId: "ep-visual-1-vis-0001" }
        ],
        createdAt: "2026-10-12T00:00:00.000Z",
        status: "running"
      },
      { status: 202 }
    );
  }) as typeof fetch;
  try {
    const validPayload = {
      schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
      mode: "autonomous-visual",
      workspaceId: WORKSPACE_ID,
      requestId: "visual-req-1",
      capabilityRevision: "b".repeat(64),
      targetId: "racing-game-local",
      policyId: "smart-direct",
      areasOfFocus: "Test steering and finish line",
      limits: VALID_VISUAL_LIMITS
    };
    const response = await POST(visualRequest(validPayload));
    assert.equal(response.status, 202);
    assert.deepEqual(forwarded, validPayload);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

test("autonomous-visual launch strictly rejects invalid payloads before contacting Runtime", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({});
  }) as typeof fetch;
  try {
    const base = {
      schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
      mode: "autonomous-visual",
      workspaceId: WORKSPACE_ID,
      requestId: "visual-req-invalid",
      capabilityRevision: "c".repeat(64),
      targetId: "racing-game-local",
      policyId: "smart-direct",
      areasOfFocus: null,
      limits: VALID_VISUAL_LIMITS
    };

    // 1. Extra key on root
    const extraKey = await POST(
      visualRequest({ ...base, unexpectedKey: true })
    );
    assert.equal(extraKey.status, 400);

    // 2. Invalid targetId
    const badTarget = await POST(
      visualRequest({ ...base, targetId: "invalid/target" })
    );
    assert.equal(badTarget.status, 400);

    // 3. Invalid policyId
    const badPolicy = await POST(
      visualRequest({ ...base, policyId: "heuristic-random" })
    );
    assert.equal(badPolicy.status, 400);

    // 4. areasOfFocus too long (>2000 chars)
    const longFocus = await POST(
      visualRequest({ ...base, areasOfFocus: "x".repeat(2001) })
    );
    assert.equal(longFocus.status, 400);

    // 5. limits with missing key
    const missingLimit = { ...VALID_VISUAL_LIMITS };
    delete (missingLimit as any).artifactBytesPerEpisode;
    const resMissing = await POST(
      visualRequest({ ...base, limits: missingLimit })
    );
    assert.equal(resMissing.status, 400);

    // 6. limits out of bounds (maxStepsPerEpisode > 10,000)
    const outOfBounds = await POST(
      visualRequest({
        ...base,
        limits: { ...VALID_VISUAL_LIMITS, maxStepsPerEpisode: 10_001 }
      })
    );
    assert.equal(outOfBounds.status, 400);

    // 7. limits with floating point
    const floatLimit = await POST(
      visualRequest({
        ...base,
        limits: { ...VALID_VISUAL_LIMITS, episodeCount: 1.5 }
      })
    );
    assert.equal(floatLimit.status, 400);

    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
