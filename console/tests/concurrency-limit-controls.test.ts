import assert from "node:assert/strict";
import test from "node:test";

import type { ControlApiConcurrencyStatus } from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST } from "../app/api/agents/concurrency/route.ts";
import { ConcurrencyLimitControl } from "../src/features/agents/ConcurrencyLimitControl.ts";
import { patchConcurrencyLimit } from "../src/lib/server/control-api.ts";

const mockUnlimitedConcurrency: ControlApiConcurrencyStatus = {
  scope: "router-admitted-child-requests",
  configSource: "config_file",
  configFileExists: true,
  maxConcurrentThreadsPerSession: null,
  effectivePerSessionLimit: null,
  activeSubagentThreads: 0,
  activeSessions: 1,
  denials: 0,
  revision: 1
};

const mockBoundedConcurrency: ControlApiConcurrencyStatus = {
  scope: "router-admitted-child-requests",
  configSource: "config_file",
  configFileExists: true,
  maxConcurrentThreadsPerSession: 8,
  effectivePerSessionLimit: 8,
  activeSubagentThreads: 2,
  activeSessions: 1,
  denials: 0,
  revision: 2
};

const mockStoredOverrideConcurrency: ControlApiConcurrencyStatus = {
  scope: "router-admitted-child-requests",
  configSource: "stored_override",
  configFileExists: true,
  maxConcurrentThreadsPerSession: 8,
  effectivePerSessionLimit: 4,
  activeSubagentThreads: 1,
  activeSessions: 1,
  denials: 1,
  revision: 3
};

test("ConcurrencyLimitControl renders not-observed when concurrency is undefined", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConcurrencyLimitControl, {
      concurrency: undefined,
      returnTo: "/agents"
    })
  );
  assert.match(markup, /data-status="not-observed"/);
  assert.match(markup, />Not observed</);
});

test("ConcurrencyLimitControl renders stepper and checked Unlimited button when limit is null", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConcurrencyLimitControl, {
      concurrency: mockUnlimitedConcurrency,
      returnTo: "/agents"
    })
  );
  assert.match(markup, /action="\/api\/agents\/concurrency"/);
  assert.match(markup, /name="returnTo" value="\/agents"/);
  assert.match(markup, /name="revision" value="1"/);
  assert.match(markup, /data-concurrency-stepper="true"/);
  assert.match(markup, />∞<\/span>/);
  assert.match(markup, /data-concurrency-unlimited="true"/);
  assert.match(markup, /data-checked="true"/);
  assert.match(markup, /From config file/);
  assert.match(markup, /• rev 1/);
});

test("ConcurrencyLimitControl renders numeric value and unchecked Unlimited button when limit is set", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConcurrencyLimitControl, {
      concurrency: mockBoundedConcurrency,
      returnTo: "/agents/orchestrator"
    })
  );
  assert.match(markup, /action="\/api\/agents\/concurrency"/);
  assert.match(markup, /name="returnTo" value="\/agents\/orchestrator"/);
  assert.match(markup, /name="revision" value="2"/);
  assert.match(markup, />8<\/span>/);
  assert.match(markup, /data-checked="false"/);
  assert.match(markup, /• rev 2/);
  // Should step down to 7 and step up to 9
  assert.match(markup, /name="setLimit"/);
  assert.match(markup, /value="7"/);
  assert.match(markup, /value="9"/);
});

test("ConcurrencyLimitControl renders stored override warning and reset button", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConcurrencyLimitControl, {
      concurrency: mockStoredOverrideConcurrency,
      returnTo: "/agents"
    })
  );
  assert.match(markup, /Stored override active/);
  assert.match(markup, /\(config file: 8\)/);
  assert.match(markup, /data-concurrency-reset="true"/);
  assert.match(markup, /name="resetToConfigFile"/);
  assert.match(markup, /value="true"/);
  assert.match(markup, /Reset to config/);
});

test("patchConcurrencyLimit fetcher PATCHes /control/runtime/concurrency", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const result = await patchConcurrencyLimit(
    { maxConcurrentThreadsPerSession: 12, revision: 2 },
    { baseUrl: "http://runtime.test", serviceToken: "server-secret" },
    {
      fetchImpl: async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return Response.json({
          schema: "autodev-control-concurrency-v1",
          concurrency: {
            scope: "router-admitted-child-requests",
            configSource: "stored_override",
            configFileExists: true,
            maxConcurrentThreadsPerSession: 8,
            effectivePerSessionLimit: 12,
            activeSubagentThreads: 0,
            activeSessions: 0,
            denials: 0,
            revision: 3
          }
        });
      }
    }
  );

  assert.equal(result.kind, "ok");
  assert.equal(captured?.url, "http://runtime.test/control/runtime/concurrency");
  assert.equal(captured?.init.method, "PATCH");
  const headers = new Headers(captured?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer server-secret");
  assert.deepEqual(JSON.parse(String(captured?.init.body)), {
    maxConcurrentThreadsPerSession: 12,
    revision: 2
  });
});

test("POST /api/agents/concurrency rejects non-same-origin requests", async () => {
  const request = new NextRequest("http://console.test/api/agents/concurrency", {
    method: "POST",
    headers: {
      origin: "http://attacker.test",
      host: "console.test",
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: "returnTo=/agents&setLimit=10"
  });

  const response = await POST(request);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/agents?control=failed");
});

test("POST /api/agents/concurrency sets numeric limit and redirects to returnTo", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;

  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      schema: "autodev-control-concurrency-v1",
      concurrency: {
        scope: "router-admitted-child-requests",
        configSource: "stored_override",
        configFileExists: true,
        maxConcurrentThreadsPerSession: 8,
        effectivePerSessionLimit: 10,
        activeSubagentThreads: 0,
        activeSessions: 0,
        denials: 0,
        revision: 2
      }
    });
  };

  try {
    const request = new NextRequest("http://console.test/api/agents/concurrency", {
      method: "POST",
      headers: {
        origin: "http://console.test",
        host: "console.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "returnTo=/agents&setLimit=10&revision=1"
    });

    const response = await POST(request);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/agents");
    assert.deepEqual(requestBody, {
      maxConcurrentThreadsPerSession: 10,
      revision: 1
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

test("POST /api/agents/concurrency handles conflict (409) with refusal=conflicted", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        code: "autodev_control_api_conflict",
        message: "Revision conflict"
      }),
      { status: 409, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const request = new NextRequest("http://console.test/api/agents/concurrency", {
      method: "POST",
      headers: {
        origin: "http://console.test",
        host: "console.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "returnTo=/agents&setLimit=10&revision=1"
    });

    const response = await POST(request);
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "/agents?control=failed&refusal=conflicted"
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});

test("POST /api/agents/concurrency resets to config file and redirects", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;

  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      schema: "autodev-control-concurrency-v1",
      concurrency: {
        scope: "router-admitted-child-requests",
        configSource: "config_file",
        configFileExists: true,
        maxConcurrentThreadsPerSession: 8,
        effectivePerSessionLimit: 8,
        activeSubagentThreads: 0,
        activeSessions: 0,
        denials: 0,
        revision: 4
      }
    });
  };

  try {
    const request = new NextRequest("http://console.test/api/agents/concurrency", {
      method: "POST",
      headers: {
        origin: "http://console.test",
        host: "console.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "returnTo=/agents/orchestrator&resetToConfigFile=true&revision=3"
    });

    const response = await POST(request);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/agents/orchestrator");
    assert.deepEqual(requestBody, {
      resetToConfigFile: true,
      revision: 3
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
});
