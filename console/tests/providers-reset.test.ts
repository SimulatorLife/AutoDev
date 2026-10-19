import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST } from "../app/api/providers/reset/route.ts";
import { ProvidersHeaderActions } from "../src/features/providers/ProvidersView.ts";
import { resetProviderSettings } from "../src/lib/server/control-api.ts";

const RESET_RESPONSE = {
  schema: "autodev-control-providers-reset-v1",
  actor: "autodev-local",
  cleared: {
    roleAssignments: 2,
    disabledProviders: 1,
    disabledModels: 1,
    providerLimits: 1
  },
  reconciliation: {
    status: {
      convergence: "converged",
      desiredGeneration: "provider-settings=defaults",
      observedGeneration: "provider-settings=defaults",
      lastApplyAt: "2026-10-18T12:00:00.000Z",
      lastObservationAt: "2026-10-18T12:00:00.000Z",
      lastError: null,
      explanation: "Provider overrides match routing defaults."
    },
    history: []
  }
} as const;

function sameOriginForm(body: URLSearchParams): NextRequest {
  return new NextRequest("http://console.test/api/providers/reset", {
    method: "POST",
    headers: {
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
}

test("Providers header reset is confirmation-bound and Add provider explains its unavailable state", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProvidersHeaderActions, {
      returnTo: "/providers?tab=models"
    })
  );
  assert.match(markup, /action="\/api\/providers\/reset"/u);
  assert.match(markup, /name="returnTo" value="\/providers\?tab=models"/u);
  assert.match(markup, /name="confirm" value="true"/u);
  assert.match(markup, /required=""/u);
  assert.match(markup, />Reset to defaults<\/button>/u);
  assert.match(markup, /disabled=""/u);
  assert.match(markup, />Add provider<\/button>/u);
  assert.match(
    markup,
    /Add a Runtime adapter before configuring another provider\./u
  );
});

test("provider reset client uses the typed server-only Control API path and confirmation", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const result = await resetProviderSettings(
    { baseUrl: "http://runtime.test", serviceToken: "server-secret" },
    {
      fetchImpl: async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return Response.json(RESET_RESPONSE);
      }
    }
  );
  assert.equal(result.kind, "ok");
  assert.equal(captured?.url, "http://runtime.test/control/providers/reset");
  assert.equal(captured?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(captured?.init.body)), { confirm: true });
  assert.equal(
    new Headers(captured?.init.headers).get("authorization"),
    "Bearer server-secret"
  );
});

test("same-origin provider reset confirms on Runtime before redirecting to the selected tab", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBaseUrl = process.env.AUTODEV_CONTROL_API_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.AUTODEV_CONTROL_API_TOKEN = "server-secret";
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://runtime.test";
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json(RESET_RESPONSE);
  };
  try {
    const response = await POST(
      sameOriginForm(
        new URLSearchParams({
          confirm: "true",
          returnTo: "/providers?tab=models"
        })
      )
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/providers?tab=models");
    assert.deepEqual(requestBody, { confirm: true });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousBaseUrl === undefined)
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    else process.env.AUTODEV_CONTROL_API_BASE_URL = previousBaseUrl;
  }
});

test("provider reset refuses an unchecked confirmation without calling Runtime", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBaseUrl = process.env.AUTODEV_CONTROL_API_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.AUTODEV_CONTROL_API_TOKEN = "server-secret";
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://runtime.test";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json(RESET_RESPONSE);
  };
  try {
    const response = await POST(
      sameOriginForm(new URLSearchParams({ returnTo: "/providers" }))
    );
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "/providers?control=failed&refusal=confirmation_missing"
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousBaseUrl === undefined)
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    else process.env.AUTODEV_CONTROL_API_BASE_URL = previousBaseUrl;
  }
});
