import assert from "node:assert/strict";
import test from "node:test";

import { PLAYTESTS_MAX_BATCH_ASSIGNMENTS } from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";

import { GET, POST } from "../app/api/playtesting/runs/route.ts";

const WORKSPACE_ID = "owner/game";
const API_PATH = "http://console.test/api/playtesting/runs";

function request(assignments: readonly unknown[]): NextRequest {
  const body = new URLSearchParams({
    workspaceId: WORKSPACE_ID,
    assignments: JSON.stringify(assignments)
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
        schema: "autodev-control-playtesting-run-started-v1",
        workspaceId: WORKSPACE_ID,
        batchId: "batch-route-1000",
        assignmentCount: PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
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
    assert.equal(
      (forwarded as { assignments: readonly unknown[] }).assignments.length,
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
        schema: "autodev-control-playtesting-runs-v1",
        workspaceId: WORKSPACE_ID,
        runs: [
          {
            batchId: "batch-live-1",
            assignmentCount: 3,
            createdAt: "2026-10-12T00:00:00.000Z",
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
        schema: "autodev-control-playtesting-runs-v1",
        workspaceId: WORKSPACE_ID,
        runs: [
          {
            batchId: "batch-a",
            assignmentCount: 1,
            createdAt: "2026-10-12T00:00:00.000Z",
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
