import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import { POST } from "../app/api/playtesting/comparisons/[comparisonId]/decision/route.ts";

const WORKSPACE_ID = "owner/game";
const API_PATH =
  "http://console.test/api/playtesting/comparisons/comparison-1/decision";

function request(
  values: Readonly<Record<string, string>>,
  origin = "http://console.test"
): NextRequest {
  return new NextRequest(API_PATH, {
    method: "POST",
    headers: {
      accept: "application/json",
      origin,
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(values)
  });
}

const context = {
  params: Promise.resolve({ comparisonId: "comparison-1" })
};

test("same-origin decision route forwards typed owner intent without deployment fields", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "r".repeat(64);
  let url = "";
  let forwarded: unknown = null;
  globalThis.fetch = (async (input, init) => {
    url = String(input);
    forwarded = JSON.parse(String(init?.body));
    return Response.json({
      schema: "autodev-control-playtesting-comparison-decision-v1",
      workspaceId: WORKSPACE_ID,
      comparison: {
        comparisonId: "comparison-1",
        version: 2,
        ownerDecisionBy: "console-operator",
        ownerDisposition: "hold",
        ownerDecisionReason: "Wait for a fresh cohort."
      }
    });
  }) as typeof fetch;
  try {
    const response = await POST(
      request({
        workspaceId: WORKSPACE_ID,
        expectedVersion: "1",
        disposition: "hold",
        reason: "Wait for a fresh cohort."
      }),
      context
    );
    assert.equal(response.status, 200);
    assert.equal(
      url,
      "http://127.0.0.1:4101/control/playtesting/comparisons/comparison-1/decision"
    );
    assert.deepEqual(forwarded, {
      workspaceId: WORKSPACE_ID,
      comparisonId: "comparison-1",
      expectedVersion: 1,
      disposition: "hold",
      reason: "Wait for a fresh cohort."
    });
    const payload = (await response.json()) as {
      readonly kind: string;
      readonly data: {
        readonly comparison: { readonly ownerDisposition: string };
      };
    };
    assert.equal(payload.kind, "ok");
    assert.equal(payload.data.comparison.ownerDisposition, "hold");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

test("decision route rejects cross-origin, duplicate, oversized, and malformed revision requests before Runtime", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({});
  }) as typeof fetch;
  try {
    const valid = {
      workspaceId: WORKSPACE_ID,
      expectedVersion: "1",
      disposition: "hold",
      reason: "Wait."
    };
    assert.equal(
      (await POST(request(valid, "http://evil.test"), context)).status,
      403
    );
    const duplicate = new URLSearchParams(valid);
    duplicate.append("expectedVersion", "2");
    assert.equal(
      (
        await POST(
          new NextRequest(API_PATH, {
            method: "POST",
            headers: {
              origin: "http://console.test",
              host: "console.test",
              "sec-fetch-site": "same-origin",
              "content-type": "application/x-www-form-urlencoded"
            },
            body: duplicate
          }),
          context
        )
      ).status,
      400
    );
    assert.equal(
      (await POST(request({ ...valid, expectedVersion: "0" }), context)).status,
      400
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
