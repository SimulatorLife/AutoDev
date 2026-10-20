import assert from "node:assert/strict";
import test from "node:test";

import type { ControlApiWorkspaceVisualPlaytestTargetsResponse } from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";

import { POST as REVOKE_POST } from "../app/api/workspaces/[owner]/[repository]/playtesting-visual-targets/[targetId]/revoke/route.ts";
import { POST } from "../app/api/workspaces/[owner]/[repository]/playtesting-visual-targets/route.ts";

const WORKSPACE_ID = "SimulatorLife/FixtureGame";

function formRequest(): NextRequest {
  const form = new URLSearchParams({
    returnTo: "/workspaces/SimulatorLife/FixtureGame",
    workspaceId: WORKSPACE_ID,
    expectedRevision: "",
    targetId: "racinggame-local",
    name: "RacingGame local browser",
    entryUrl: "http://localhost:5173/",
    additionalOrigins: "https://assets.example.test",
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    episodeCount: "1",
    maxStepsPerEpisode: "80",
    wallTimeMs: "120000",
    smartRequestsPerEpisode: "30",
    smartTokensPerEpisode: "25000",
    screenshotCountPerEpisode: "160",
    artifactBytesPerEpisode: String(64 * 1024 * 1024)
  });
  form.append("inputCapabilities", "keyboard");
  form.append("inputCapabilities", "pointer");
  return new NextRequest(
    "http://console.test/api/workspaces/SimulatorLife/FixtureGame/playtesting-visual-targets",
    {
      method: "POST",
      headers: {
        origin: "http://console.test",
        host: "console.test",
        "sec-fetch-site": "same-origin",
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: form
    }
  );
}

function targetResponse(): ControlApiWorkspaceVisualPlaytestTargetsResponse {
  return {
    schema: "autodev-control-workspace-visual-playtest-targets-v1",
    workspaceId: WORKSPACE_ID,
    workspaceEnabled: true,
    targets: [
      {
        schema: "autodev-workspace-visual-playtest-target-v1",
        workspaceId: WORKSPACE_ID,
        targetId: "racinggame-local",
        revision: 1,
        approvalId: "visual-approval-1",
        name: "RacingGame local browser",
        entryUrl: "http://localhost:5173/",
        allowedOrigins: [
          "http://localhost:5173",
          "https://assets.example.test"
        ],
        inputCapabilities: ["keyboard", "pointer"],
        controlTimingClass: "turn-based",
        entryRequirements: "none",
        sandboxProfile: "transient-browser-profile",
        capturePolicy: "screenshots-only-redact-or-refuse",
        limits: {
          episodeCount: 1,
          maxStepsPerEpisode: 80,
          wallTimeMs: 120_000,
          smartRequestsPerEpisode: 30,
          smartTokensPerEpisode: 25_000,
          screenshotCountPerEpisode: 160,
          artifactBytesPerEpisode: 64 * 1024 * 1024
        },
        approvedAt: "2026-10-16T12:00:00.000Z",
        approvedBy: "autodev-local",
        revokedAt: null,
        revokedBy: null,
        revocationReason: null
      }
    ]
  };
}

test("same-origin target form pins exact origins and grants no shell or repository authority", async () => {
  const prior = {
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    baseUrl: process.env.AUTODEV_CONTROL_API_BASE_URL
  };
  const originalFetch = globalThis.fetch;
  process.env.AUTODEV_CONTROL_API_TOKEN = "visual-target-route-test-token";
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4191";
  let outboundUrl = "";
  let outboundBody: Record<string, unknown> | null = null;
  let outboundActor: string | null = null;
  globalThis.fetch = async (input, init) => {
    outboundUrl = String(input);
    outboundActor = new Headers(init?.headers).get("X-AutoDev-Actor");
    outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json(targetResponse());
  };
  try {
    const response = await POST(formRequest(), {
      params: Promise.resolve({
        owner: "SimulatorLife",
        repository: "FixtureGame"
      })
    });
    assert.equal(response.status, 200);
    const envelope = (await response.json()) as {
      kind: string;
      data: ControlApiWorkspaceVisualPlaytestTargetsResponse;
    };
    assert.equal(envelope.kind, "ok");
    assert.equal(envelope.data.targets[0]?.entryUrl, "http://localhost:5173/");
    assert.equal(
      outboundUrl,
      "http://127.0.0.1:4191/control/workspaces/SimulatorLife%2FFixtureGame/playtesting-visual-targets"
    );
    assert.equal(outboundActor, "autodev-local");
    const forwardedBody = outboundBody as Record<string, unknown> | null;
    assert.ok(forwardedBody);
    assert.deepEqual(forwardedBody.allowedOrigins, [
      "http://localhost:5173",
      "https://assets.example.test"
    ]);
    assert.deepEqual(forwardedBody.inputCapabilities, ["keyboard", "pointer"]);
    assert.equal(forwardedBody.sandboxProfile, undefined);
    assert.equal(forwardedBody.shellCommand, undefined);
    assert.doesNotMatch(
      JSON.stringify(envelope),
      /visual-target-route-test-token/u
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (prior.token === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = prior.token;
    if (prior.baseUrl === undefined)
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    else process.env.AUTODEV_CONTROL_API_BASE_URL = prior.baseUrl;
  }
});

function revocationForm(extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    returnTo: "/workspaces/SimulatorLife/FixtureGame",
    workspaceId: WORKSPACE_ID,
    expectedRevision: "1",
    approvalId: "visual-approval-1",
    reason: "Approved origin no longer serves the game.",
    ...extra
  });
}

function revocationRequest(form: URLSearchParams): NextRequest {
  return new NextRequest(
    "http://console.test/api/workspaces/SimulatorLife/FixtureGame/playtesting-visual-targets/racinggame-local/revoke",
    {
      method: "POST",
      headers: {
        origin: "http://console.test",
        host: "console.test",
        "sec-fetch-site": "same-origin",
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: form
    }
  );
}

test("visual target revocation accepts the body the Console manager sends", async () => {
  const prior = {
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    baseUrl: process.env.AUTODEV_CONTROL_API_BASE_URL
  };
  const originalFetch = globalThis.fetch;
  process.env.AUTODEV_CONTROL_API_TOKEN = "visual-target-revoke-test-token";
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4191";
  let outboundUrl = "";
  let outboundBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    outboundUrl = String(input);
    outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json(targetResponse());
  };
  try {
    // The target id travels in the route path. The Console manager must not
    // repeat it in the body, because the route refuses unknown body fields and
    // a repeated identity would be a second source of truth for one target.
    const response = await REVOKE_POST(revocationRequest(revocationForm()), {
      params: Promise.resolve({
        owner: "SimulatorLife",
        repository: "FixtureGame",
        targetId: "racinggame-local"
      })
    });
    assert.equal(response.status, 200);
    const envelope = (await response.json()) as {
      kind: string;
      data: ControlApiWorkspaceVisualPlaytestTargetsResponse;
    };
    assert.equal(envelope.kind, "ok");
    assert.equal(
      outboundUrl,
      "http://127.0.0.1:4191/control/workspaces/SimulatorLife%2FFixtureGame/playtesting-visual-targets/racinggame-local/revoke"
    );
    const forwardedBody = outboundBody as Record<string, unknown> | null;
    assert.ok(forwardedBody);
    assert.equal(forwardedBody.expectedRevision, 1);
    assert.equal(forwardedBody.approvalId, "visual-approval-1");
    assert.equal(
      forwardedBody.reason,
      "Approved origin no longer serves the game."
    );
    assert.equal(forwardedBody.targetId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (prior.token === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = prior.token;
    if (prior.baseUrl === undefined)
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    else process.env.AUTODEV_CONTROL_API_BASE_URL = prior.baseUrl;
  }
});

test("visual target revocation refuses a body that repeats the routed target id", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json(targetResponse());
  };
  try {
    const response = await REVOKE_POST(
      revocationRequest(revocationForm({ targetId: "racinggame-local" })),
      {
        params: Promise.resolve({
          owner: "SimulatorLife",
          repository: "FixtureGame",
          targetId: "racinggame-local"
        })
      }
    );
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("visual target form refuses cross-origin mutation before calling Runtime", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return Response.json(targetResponse());
  };
  try {
    const request = formRequest();
    const crossOriginRequest = new NextRequest(request.url, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        host: "console.test",
        "sec-fetch-site": "cross-site",
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ workspaceId: WORKSPACE_ID })
    });
    const response = await POST(crossOriginRequest, {
      params: Promise.resolve({
        owner: "SimulatorLife",
        repository: "FixtureGame"
      })
    });
    assert.equal(response.status, 403);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
