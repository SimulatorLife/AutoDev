import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import { GET, POST } from "../app/api/playtesting/analyses/route.ts";

const WORKSPACE_ID = "owner/game";
const API_PATH = "http://console.test/api/playtesting/analyses";

function request(
  workspaceId: string,
  episodeIds: unknown,
  init: { origin?: string; requireFindings?: string } = {}
): NextRequest {
  const body = new URLSearchParams({
    workspaceId,
    episodeIds: JSON.stringify(episodeIds)
  });
  if (init.requireFindings !== undefined) {
    body.set("requireFindings", init.requireFindings);
  }
  return new NextRequest(API_PATH, {
    method: "POST",
    headers: {
      accept: "application/json",
      origin: init.origin ?? "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
}

function withToken<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "a".repeat(64);
  return run().finally(() => {
    if (previous === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previous;
  });
}

test("the route dispatches the selected packets and returns every receipt", async () => {
  await withToken(async () => {
    const previousFetch = globalThis.fetch;
    let forwarded: unknown = null;
    globalThis.fetch = (async (_input, init) => {
      forwarded = JSON.parse(String(init?.body));
      return Response.json({
        schema: "autodev-control-playtesting-analysis-v1",
        operation: "dispatch",
        workspaceId: WORKSPACE_ID,
        requested: 3,
        packets: [
          { episodeId: "episode-a", batchId: "batch-1", packetId: "packet-a" }
        ],
        receipts: [
          {
            episodeId: "episode-b",
            batchId: "batch-1",
            reason: "excluded-ineligible-session",
            detail: "The session crashed."
          },
          {
            episodeId: "episode-c",
            batchId: null,
            reason: "unknown-session",
            detail: "The session does not exist in the authorized workspace."
          }
        ],
        budget: [
          {
            batchId: "batch-1",
            reviewCap: 4,
            actualCritiques: 0,
            reserved: 1,
            requested: 2,
            remaining: 3
          }
        ],
        analysis: {
          analysisId: "analysis-1",
          workspaceId: WORKSPACE_ID,
          status: "running",
          createdAt: "2026-10-14T12:00:00.000Z",
          finishedAt: null,
          requestedEpisodeIds: ["episode-a", "episode-b", "episode-c"],
          packets: [
            { episodeId: "episode-a", batchId: "batch-1", packetId: "packet-a" }
          ],
          receipts: [
            {
              episodeId: "episode-b",
              batchId: "batch-1",
              reason: "excluded-ineligible-session",
              detail: "The session crashed."
            },
            {
              episodeId: "episode-c",
              batchId: null,
              reason: "unknown-session",
              detail: "The session does not exist in this workspace."
            }
          ],
          budget: [],
          reviews: [],
          error: null
        }
      });
    }) as typeof fetch;
    try {
      const response = await POST(
        request(WORKSPACE_ID, ["episode-a", "episode-b", "episode-c"])
      );
      assert.equal(response.status, 202);
      // The workspace travels in the query, so the two authorities cannot
      // disagree; the body carries only the selection and which kind of
      // review the operator asked for.
      assert.deepEqual(forwarded, {
        episodeIds: ["episode-a", "episode-b", "episode-c"],
        operation: "dispatch",
        requireFindings: false
      });
      const body = (await response.json()) as {
        kind: string;
        data: {
          packets: readonly unknown[];
          receipts: readonly unknown[];
        };
      };
      assert.equal(body.kind, "ok");
      assert.equal(body.data.packets.length, 1);
      assert.equal(body.data.receipts.length, 2);
      assert.equal(response.headers.get("cache-control"), "no-store");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("a findings request reaches the Runtime as a findings request", async () => {
  await withToken(async () => {
    const previousFetch = globalThis.fetch;
    let forwarded: unknown = null;
    globalThis.fetch = (async (_input, init) => {
      forwarded = JSON.parse(String(init?.body));
      return Response.json({
        schema: "autodev-control-playtesting-analysis-v1",
        operation: "dispatch",
        workspaceId: WORKSPACE_ID,
        requested: 1,
        packets: [
          { episodeId: "episode-a", batchId: "batch-1", packetId: "packet-a" }
        ],
        receipts: [],
        budget: [],
        analysis: {
          analysisId: "analysis-1",
          workspaceId: WORKSPACE_ID,
          analysisKind: "confirmatory",
          requireFindings: true,
          status: "running",
          createdAt: "2026-10-14T12:00:00.000Z",
          finishedAt: null,
          requestedEpisodeIds: ["episode-a"],
          packets: [
            {
              episodeId: "episode-a",
              batchId: "batch-1",
              packetId: "packet-a"
            }
          ],
          receipts: [],
          budget: [],
          reviews: [],
          synthesisId: null,
          error: null
        }
      });
    }) as typeof fetch;
    try {
      const response = await POST(
        request(WORKSPACE_ID, ["episode-a"], { requireFindings: "true" })
      );
      assert.equal(response.status, 202);
      assert.deepEqual(forwarded, {
        episodeIds: ["episode-a"],
        operation: "dispatch",
        requireFindings: true
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("a malformed findings flag is refused rather than read as a hypothesis review", async () => {
  await withToken(async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({});
    }) as typeof fetch;
    try {
      for (const flag of ["yes", "1", "TRUE", ""]) {
        const response = await POST(
          request(WORKSPACE_ID, ["episode-a"], { requireFindings: flag })
        );
        assert.equal(response.status, 400, flag);
      }
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("a response that drops a selected session is refused", async () => {
  await withToken(async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        schema: "autodev-control-playtesting-analysis-v1",
        operation: "dispatch",
        workspaceId: WORKSPACE_ID,
        requested: 3,
        // Two of three accounted for. Accepting this would let the Console
        // report "analysed 1 of 3" from a selection it silently shrank.
        packets: [{ episodeId: "episode-a", batchId: "batch-1" }],
        receipts: [
          {
            episodeId: "episode-b",
            batchId: "batch-1",
            reason: "excluded-ineligible-session",
            detail: "The session crashed."
          }
        ],
        budget: [],
        analysis: null
      })) as typeof fetch;
    try {
      const response = await POST(
        request(WORKSPACE_ID, ["episode-a", "episode-b", "episode-c"])
      );
      assert.equal(response.status, 502);
      // The code, not the status: several failures map to 502, so asserting
      // the status alone would let this pass for the wrong reason.
      const body = (await response.json()) as { code: string };
      assert.equal(body.code, "autodev_control_playtesting_invalid_response");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("status reads are workspace-scoped and keep the Runtime run identity", async () => {
  await withToken(async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        schema: "autodev-control-playtesting-analyses-v1",
        workspaceId: WORKSPACE_ID,
        syntheses: [],
        runs: [
          {
            analysisId: "analysis-1",
            workspaceId: WORKSPACE_ID,
            status: "running",
            createdAt: "2026-10-14T12:00:00.000Z",
            finishedAt: null,
            requestedEpisodeIds: ["episode-a"],
            packets: [
              {
                episodeId: "episode-a",
                batchId: "batch-1",
                packetId: "packet-a"
              }
            ],
            receipts: [],
            budget: [],
            reviews: [],
            error: null
          }
        ]
      })) as typeof fetch;
    try {
      const statusRequest = new NextRequest(
        `${API_PATH}?workspaceId=${encodeURIComponent(WORKSPACE_ID)}`
      );
      const response = await GET(statusRequest);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        data: { runs: readonly unknown[] };
      };
      assert.equal(body.data.runs.length, 1);
      assert.equal(response.headers.get("cache-control"), "no-store");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("malformed and cross-origin selections are refused before any request", async () => {
  await withToken(async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({});
    }) as typeof fetch;
    try {
      for (const selection of [
        [],
        ["episode-a", "not valid"],
        "not-an-array",
        [123]
      ]) {
        const response = await POST(request(WORKSPACE_ID, selection));
        assert.equal(response.status, 400, JSON.stringify(selection));
      }
      const notCanonical = await POST(request("not-canonical", ["episode-a"]));
      assert.equal(notCanonical.status, 400);
      const crossOrigin = await POST(
        request(WORKSPACE_ID, ["episode-a"], { origin: "http://evil.test" })
      );
      assert.equal(crossOrigin.status, 403);
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
