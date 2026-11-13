import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST } from "../app/api/providers/reset/route.ts";
import {
  PROVIDER_RESET_PRESERVES,
  PROVIDER_RESET_SCOPE
} from "../src/features/providers/ProviderResetDialog.ts";
import { ProvidersHeaderActions } from "../src/features/providers/ProvidersView.ts";
import { resetProviderSettings } from "../src/lib/server/control-api.ts";

const RESET_RESPONSE = {
  schema: "autodev-control-providers-reset-v1",
  actor: "autodev-local",
  cleared: {
    roleAssignments: 2,
    disabledProviders: 1,
    disabledModels: 1,
    providerLimits: 1,
    agentModels: 0
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

test("Providers header offers a modal-confirmed reset and no Add provider or inline checkbox", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProvidersHeaderActions, {
      returnTo: "/providers?tab=models"
    })
  );
  assert.match(markup, />Reset to defaults<\/button>/u);
  assert.match(markup, /aria-controls="provider-reset-dialog"/u);
  // The dialog is closed on render: nothing is shown or posted until opened.
  assert.match(markup, /<dialog[^>]*id="provider-reset-dialog"/u);
  assert.doesNotMatch(markup, /<dialog[^>]*\sopen/u);
  assert.match(markup, /aria-labelledby=/u);
  assert.match(markup, /aria-describedby=/u);
  assert.match(markup, /action="\/api\/providers\/reset"/u);
  assert.match(markup, /name="returnTo" value="\/providers\?tab=models"/u);
  assert.match(markup, /name="confirm" value="true"/u);
  assert.match(markup, />Cancel<\/button>/u);
  assert.match(markup, /type="submit"[^>]*>Reset provider settings<\/button>/u);
  assert.ok(markup.includes(PROVIDER_RESET_SCOPE));
  assert.ok(markup.includes(PROVIDER_RESET_PRESERVES));
  assert.doesNotMatch(markup, /type="checkbox"/u);
  assert.doesNotMatch(markup, /Add provider|Add a Runtime adapter/u);
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
