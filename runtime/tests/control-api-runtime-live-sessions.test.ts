import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { CONTROL_API_CONTRACT } from "@simulatorlife/autodev-core";

import { createAgentActivityTracker } from "../src/agents/agent-activity.ts";
import {
  handleControlApiRequest,
  setControlApiLiveSessionsSource
} from "../src/control-api/request-handler.ts";
import {
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "s".repeat(64);

function authenticatedRequest(): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "GET",
    url: "/control/runtime",
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-autodev-actor": "runtime-session-test"
    }
  }) as unknown as IncomingMessage;
}

async function readRuntime(): Promise<Record<string, unknown> | null> {
  const response = responseRecorder();
  await handleControlApiRequest(
    authenticatedRequest(),
    response,
    "/control/runtime"
  );
  assert.equal(response.statusCode, 200);
  return responseBody(response);
}

test("runtime distinguishes unavailable session evidence from an observed empty list", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = "runtime-session-test";
  setControlApiLiveSessionsSource(null);
  try {
    const unavailable = await readRuntime();
    assert.equal(unavailable?.schema, "autodev-control-runtime-v3");
    assert.equal(unavailable?.liveSessions, null);

    setControlApiLiveSessionsSource(() => ({
      identitiesObserved: [],
      identifiedSessionCount: 0,
      partial: false,
      unattributedLiveActivityCount: 0
    }));
    const observedEmpty = await readRuntime();
    assert.deepEqual(observedEmpty?.liveSessions, {
      identitiesObserved: [],
      identifiedSessionCount: 0,
      partial: false,
      unattributedLiveActivityCount: 0
    });
    // `liveSessions` arrived in contract v31.
    assert.ok(CONTROL_API_CONTRACT.version >= 31);
  } finally {
    setControlApiLiveSessionsSource(null);
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  }
});

test("runtime publishes explicit distinct tracker session identities and unattributed activity", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = "runtime-session-test";
  const tracker = createAgentActivityTracker({ now: () => 10 });
  tracker.beginRequest("request-subject-a", {
    requestId: "request-a",
    sessionId: "session-a",
    timestamp: 10
  });
  tracker.beginRequest("bridge-subject-b", {
    kind: "bridge_subagent",
    requestId: "request-b",
    sessionId: "session-a",
    timestamp: 20
  });
  tracker.beginRequest("anonymous-subject", {
    requestId: "request-c",
    tag: "session-from-tag-is-not-used",
    timestamp: 30
  });
  setControlApiLiveSessionsSource((now) => tracker.listLiveSessions(now));
  try {
    const runtime = await readRuntime();
    assert.deepEqual(runtime?.liveSessions, {
      identitiesObserved: [
        { sessionId: "session-a", state: "active", lastActivityAt: 20 }
      ],
      identifiedSessionCount: 1,
      partial: false,
      unattributedLiveActivityCount: 1
    });
  } finally {
    setControlApiLiveSessionsSource(null);
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  }
});
