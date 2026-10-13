import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEnablementState } from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST } from "../app/api/agents/[role]/route.ts";
import { AgentEnablementControl } from "../src/features/agents/AgentEnablementControl.ts";
import { patchAgentEnablement } from "../src/lib/server/control-api.ts";

const REVISION_1 = "a".repeat(64);
const REVISION_2 = "b".repeat(64);

const enabled: AgentEnablementState = {
  kind: "observed",
  enabled: true,
  mutable: true,
  revision: REVISION_1
};

test("shared Agent control posts current revision and reports pending state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentEnablementControl, {
      role: "orchestrator",
      enablement: enabled,
      convergence: "pending",
      returnTo: "/agents"
    })
  );
  assert.match(
    markup,
    new RegExp(`name="expectedRevision" value="${REVISION_1}"`)
  );
  assert.match(markup, /name="enabled" value="false"/);
  assert.match(markup, /data-enablement-pending="true"/);
  assert.match(markup, /data-status="pending"/);
  assert.match(markup, /action="\/api\/agents\/orchestrator"/);
  assert.match(markup, />Enabled<\/button>/);
  assert.match(markup, /data-status="enabled"/);
});

test("unavailable Agent state is nonmutable and displays Runtime reason", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentEnablementControl, {
      role: "worker",
      enablement: {
        kind: "unavailable",
        enabled: null,
        mutable: false,
        reason: "No runtime alias is configured."
      },
      convergence: "not-observed",
      returnTo: "/agents/worker"
    })
  );
  assert.match(markup, /disabled=""/);
  assert.match(markup, /No runtime alias is configured\./);
  assert.match(markup, />Not observed<\/button>/);
  assert.match(markup, /data-status="not-observed"/);
});

test("agent enablement fetcher PATCHes role with exact revision request", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const result = await patchAgentEnablement(
    "ORCHESTRATOR",
    { enabled: false, expectedRevision: REVISION_1 },
    { baseUrl: "http://runtime.test", serviceToken: "server-secret" },
    {
      fetchImpl: async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return Response.json({
          schema: "autodev-control-agent-enablement-v1",
          role: "orchestrator",
          enabled: false,
          previous: true,
          revision: REVISION_2,
          actor: "local",
          reconciliation: {
            status: {
              convergence: "pending",
              desiredGeneration: null,
              observedGeneration: null,
              lastApplyAt: null,
              lastObservationAt: null,
              lastError: null,
              explanation: "Pending."
            },
            history: []
          }
        });
      }
    }
  );
  assert.equal(result.kind, "ok");
  assert.equal(
    captured?.url,
    "http://runtime.test/control/agents/orchestrator"
  );
  assert.equal(captured?.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(captured?.init.body)), {
    enabled: false,
    expectedRevision: REVISION_1
  });
  assert.equal(
    new Headers(captured?.init.headers).get("authorization"),
    "Bearer server-secret"
  );
});

test("same-origin Agent form redirects in place and does not reflect success", async () => {
  const priorToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const priorBaseUrl = process.env.AUTODEV_CONTROL_API_BASE_URL;
  const priorFetch = globalThis.fetch;
  process.env.AUTODEV_CONTROL_API_TOKEN = "server-secret";
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://runtime.test";
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      schema: "autodev-control-agent-enablement-v1",
      role: "orchestrator",
      enabled: false,
      previous: true,
      revision: REVISION_2,
      actor: "local",
      reconciliation: {
        status: {
          convergence: "pending",
          desiredGeneration: null,
          observedGeneration: null,
          lastApplyAt: null,
          lastObservationAt: null,
          lastError: null,
          explanation: "Pending."
        },
        history: []
      }
    });
  };
  try {
    const response = await POST(
      new NextRequest("http://console.test/api/agents/orchestrator", {
        method: "POST",
        headers: {
          origin: "http://console.test",
          host: "console.test",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          role: "orchestrator",
          enabled: "false",
          expectedRevision: REVISION_1,
          returnTo: "/agents"
        })
      }),
      { params: Promise.resolve({ role: "orchestrator" }) }
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/agents");
    assert.deepEqual(requestBody, {
      enabled: false,
      expectedRevision: REVISION_1
    });
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = priorToken;
    if (priorBaseUrl === undefined)
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    else process.env.AUTODEV_CONTROL_API_BASE_URL = priorBaseUrl;
  }
});
