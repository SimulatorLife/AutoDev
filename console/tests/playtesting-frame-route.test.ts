import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import { GET } from "../app/api/playtesting/episodes/[episodeId]/media/[artifactId]/route.ts";

const TOKEN = "server-only-control-token";

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("frame proxy keeps service credentials server-side and returns bounded raster bytes", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBase = process.env.AUTODEV_CONTROL_API_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.AUTODEV_CONTROL_API_TOKEN = TOKEN;
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04
  ]);
  let requestAuthorization = "";
  globalThis.fetch = (async (_input, init) => {
    requestAuthorization =
      new Headers(init?.headers).get("authorization") ?? "";
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png" }
    });
  }) as typeof fetch;
  try {
    const response = await GET(
      new NextRequest(
        "http://console.test/api/playtesting/episodes/episode-1/media/frame-1?workspaceId=owner%2Fgame"
      ),
      {
        params: Promise.resolve({
          episodeId: "episode-1",
          artifactId: "frame-1"
        })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(requestAuthorization, `Bearer ${TOKEN}`);
    assert.equal(response.headers.get("authorization"), null);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("AUTODEV_CONTROL_API_TOKEN", previousToken);
    restoreEnvironment("AUTODEV_CONTROL_API_BASE_URL", previousBase);
  }
});

test("frame proxy refuses missing workspace scope before any backend read", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.AUTODEV_CONTROL_API_TOKEN = TOKEN;
  let reads = 0;
  globalThis.fetch = (async () => {
    reads += 1;
    return Response.json({});
  }) as typeof fetch;
  try {
    const response = await GET(
      new NextRequest(
        "http://console.test/api/playtesting/episodes/episode-1/media/frame-1"
      ),
      {
        params: Promise.resolve({
          episodeId: "episode-1",
          artifactId: "frame-1"
        })
      }
    );
    assert.equal(response.status, 400);
    assert.equal(reads, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("AUTODEV_CONTROL_API_TOKEN", previousToken);
  }
});
