import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type { ControlApiLiveAgentCounts } from "@simulatorlife/autodev-core";

import {
  handleControlApiRequest,
  setControlApiLiveAgentCountsSource
} from "../src/control-api/index.ts";
import {
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "t".repeat(64);

function authenticatedRequest(): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "GET",
    url: "/control/runtime",
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-autodev-actor": "runtime-count-test"
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

test("runtime distinguishes unobserved live activity from an observed zero", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = "runtime-count-test";
  setControlApiLiveAgentCountsSource(null);
  try {
    const unobserved = await readRuntime();
    assert.equal(unobserved?.liveAgents, null);

    setControlApiLiveAgentCountsSource(() => ({
      count: 0,
      byRole: {},
      byProvider: {},
      byModel: {},
      missingProvider: 0,
      missingModel: 0
    }));
    const observedIdle = await readRuntime();
    assert.deepEqual(observedIdle?.liveAgents, {
      count: 0,
      byRole: {},
      byProvider: {},
      byModel: {},
      missingProvider: 0,
      missingModel: 0
    });
  } finally {
    setControlApiLiveAgentCountsSource(null);
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  }
});

test("runtime publishes provider, model, and role live counts from its source", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = "runtime-count-test";
  const provider = "provider-fixture";
  const model = `${provider}/model-fixture`;
  const expected: ControlApiLiveAgentCounts = {
    count: 4,
    byRole: { roleFixture: 4 },
    byProvider: { [provider]: 3 },
    byModel: { [model]: 2 },
    missingProvider: 1,
    missingModel: 2
  };
  setControlApiLiveAgentCountsSource(() => expected);
  try {
    const runtime = await readRuntime();
    assert.deepEqual(runtime?.liveAgents, expected);
  } finally {
    setControlApiLiveAgentCountsSource(null);
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  }
});
