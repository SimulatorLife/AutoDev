import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import { POST } from "../app/api/usage/session/route.ts";

const SESSION_ID = "01a0ba14-d54c-78f2-9367-3f80e9a8f75f";
const SESSION_EVIDENCE = {
  schema: "autodev-openlit-session-usage-v1",
  status: "observed",
  partial: false,
  spans: [
    {
      spanId: "0123456789abcdef",
      traceId: "0123456789abcdef0123456789abcdef",
      parentSpanId: null,
      operationName: "chat",
      timestamp: "2026-11-10T12:00:00.000Z",
      durationNs: 1_000_000,
      statusCode: "OK",
      provider: "claude",
      requestedModel: "autodev/worker",
      role: "worker",
      workspace: "SimulatorLife/AutoDev",
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 4,
      costUsd: 0.001,
      requestKind: "compaction",
      compactionProvider: "claude",
      hopRoute: null,
      hopFrom: null,
      hopTo: null,
      hopReason: null
    }
  ]
};

function request(
  body: unknown,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest("http://console.test/api/usage/session", {
    method: "POST",
    headers: {
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

test("session lookup is same-origin and keeps the session ID in a POST body", async () => {
  const previousToken = process.env.AUTODEV_OPENLIT_USAGE_TOKEN;
  const previousUrl = process.env.AUTODEV_OPENLIT_USAGE_URL;
  const originalFetch = globalThis.fetch;
  process.env.AUTODEV_OPENLIT_USAGE_TOKEN = "usage-token";
  process.env.AUTODEV_OPENLIT_USAGE_URL = "http://openlit.test";
  let openlitRequest: { url: string; body: Record<string, unknown> } | null =
    null;
  globalThis.fetch = (async (input, init) => {
    openlitRequest = {
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    };
    return Response.json(SESSION_EVIDENCE);
  }) as typeof fetch;
  try {
    const response = await POST(
      request({ sessionId: SESSION_ID, selection: { range: "7D" } })
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.schema, "autodev-console-session-usage-v1");
    assert.equal(result.kind, "ok");
    assert.equal(Object.hasOwn(result, "sessionId"), false);
    assert.deepEqual(result.data.spans[0], SESSION_EVIDENCE.spans[0]);
    assert.deepEqual(openlitRequest, {
      url: "http://openlit.test/api/autodev/usage/session",
      body: { sessionId: SESSION_ID, range: "7D" }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_OPENLIT_USAGE_TOKEN;
    else process.env.AUTODEV_OPENLIT_USAGE_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.AUTODEV_OPENLIT_USAGE_URL;
    else process.env.AUTODEV_OPENLIT_USAGE_URL = previousUrl;
  }
});

test("session lookup refuses cross-origin and invalid requests before OpenLIT", async () => {
  const previousToken = process.env.AUTODEV_OPENLIT_USAGE_TOKEN;
  const previousUrl = process.env.AUTODEV_OPENLIT_USAGE_URL;
  const originalFetch = globalThis.fetch;
  process.env.AUTODEV_OPENLIT_USAGE_TOKEN = "usage-token";
  process.env.AUTODEV_OPENLIT_USAGE_URL = "http://openlit.test";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json(SESSION_EVIDENCE);
  }) as typeof fetch;
  try {
    const crossOrigin = await POST(
      request(
        { sessionId: SESSION_ID, selection: { range: "7D" } },
        {
          origin: "https://attacker.test"
        }
      )
    );
    assert.equal(crossOrigin.status, 403);
    const invalidSession = await POST(
      request({ sessionId: "process-fallback", selection: { range: "7D" } })
    );
    assert.equal(invalidSession.status, 400);
    assert.equal((await invalidSession.json()).kind, "invalid-session-id");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_OPENLIT_USAGE_TOKEN;
    else process.env.AUTODEV_OPENLIT_USAGE_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.AUTODEV_OPENLIT_USAGE_URL;
    else process.env.AUTODEV_OPENLIT_USAGE_URL = previousUrl;
  }
});
