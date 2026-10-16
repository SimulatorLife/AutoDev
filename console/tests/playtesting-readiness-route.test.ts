import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import { GET, POST } from "../app/api/playtesting/readiness/route.ts";

const WORKSPACE_ID = "owner/game";
const API_PATH = "http://console.test/api/playtesting/readiness";
const TOKEN = "server-only-readiness-token";

function request(method: "GET" | "POST", origin = "http://console.test") {
  return new NextRequest(
    `${API_PATH}?workspaceId=${encodeURIComponent(WORKSPACE_ID)}`,
    {
      method,
      headers: {
        accept: "application/json",
        origin,
        host: "console.test",
        "sec-fetch-site":
          origin === "http://console.test" ? "same-origin" : "cross-site"
      }
    }
  );
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withControlApi<T>(run: () => Promise<T>): Promise<T> {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBase = process.env.AUTODEV_CONTROL_API_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.AUTODEV_CONTROL_API_TOKEN = TOKEN;
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
    restore("AUTODEV_CONTROL_API_TOKEN", previousToken);
    restore("AUTODEV_CONTROL_API_BASE_URL", previousBase);
  }
}

test("readiness proxy keeps the service token server-side and forwards current state", async () => {
  await withControlApi(async () => {
    let requested = "";
    let authorization = "";
    globalThis.fetch = (async (input, init) => {
      requested = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        schema: "autodev-control-playtesting-readiness-v1",
        workspaceId: WORKSPACE_ID,
        status: "initializing"
      });
    }) as typeof fetch;

    const response = await GET(request("GET"));
    assert.equal(response.status, 200);
    assert.match(requested, /\/control\/playtesting\/readiness\?/u);
    assert.match(requested, /workspaceId=owner%2Fgame/u);
    assert.equal(authorization, `Bearer ${TOKEN}`);
    const body = (await response.json()) as {
      data: { status: string };
    };
    assert.equal(body.data.status, "initializing");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("authorization"), null);
  });
});

test("readiness retry is same-origin and reaches Runtime as an operator mutation", async () => {
  await withControlApi(async () => {
    let method = "";
    let requested = "";
    globalThis.fetch = (async (input, init) => {
      requested = String(input);
      method = init?.method ?? "GET";
      return Response.json({
        schema: "autodev-control-playtesting-readiness-v1",
        workspaceId: WORKSPACE_ID,
        status: "initializing"
      });
    }) as typeof fetch;

    const rejected = await POST(request("POST", "http://attacker.test"));
    assert.equal(rejected.status, 403);
    assert.equal(method, "");

    const response = await POST(request("POST"));
    assert.equal(response.status, 200);
    assert.equal(method, "POST");
    assert.match(requested, /\/control\/playtesting\/initialize\?/u);
  });
});
