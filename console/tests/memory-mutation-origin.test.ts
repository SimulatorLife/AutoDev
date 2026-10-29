import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import * as memoryRoute from "../app/api/memory/route.ts";

/**
 * `/api/memory` holds the service credential and writes to the Runtime's
 * memory -- an irreversible purge among them -- so the origin is the only
 * thing that separates an operator's own click from a page on another site
 * making the request on the operator's behalf.
 *
 * Every other write route in the Console checks it through the shared
 * `isSameOriginMutation`. This route did not, while its own tests were
 * already written with same-origin headers -- so the request shape every test
 * used was the shape the route should have insisted on, and the check was
 * simply absent.
 *
 * A cross-site form post is a *simple* request: no preflight, and a content
 * type the page chooses. It is also the shape a JSON body can take when the
 * page sends it as `text/plain`, which the route would parse as JSON. Both are
 * refused here, and neither reaches the Runtime.
 */

const EVIDENCE = [{ kind: "file", uri: "config/runtime.json" }];

/** A request as the Console's own page makes it. */
function sameOriginRequest(fields: Record<string, string>): NextRequest {
  return new NextRequest("http://console.test/api/memory", {
    method: "POST",
    headers: {
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(fields).toString()
  });
}

/** The same form, arriving from another site. */
function crossOriginForm(fields: Record<string, string>): NextRequest {
  return new NextRequest("http://console.test/api/memory", {
    method: "POST",
    headers: {
      origin: "https://elsewhere.test",
      host: "console.test",
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(fields).toString()
  });
}

/**
 * A cross-site JSON body.
 *
 * The content type is `text/plain` on purpose: that is what makes it a simple
 * request, so no preflight stands between the page and the route.
 */
function crossOriginJson(body: unknown): NextRequest {
  return new NextRequest("http://console.test/api/memory", {
    method: "POST",
    headers: {
      origin: "https://elsewhere.test",
      host: "console.test",
      "sec-fetch-site": "cross-site",
      "content-type": "text/plain"
    },
    body: JSON.stringify(body)
  });
}

const PURGE = {
  action: "purge",
  experienceId: "exp-1",
  workspaceId: "SimulatorLife/AutoDev",
  reason: "privacy_request",
  confirm: "purge"
};

interface Outcome {
  readonly sent: readonly string[];
  readonly status: number;
  readonly location: string;
}

async function submit(make: () => NextRequest): Promise<Outcome> {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBase = process.env.AUTODEV_CONTROL_API_BASE_URL;
  process.env.AUTODEV_CONTROL_API_TOKEN = "p".repeat(64);
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://control.test";
  const sent: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    sent.push(String(init?.body ?? ""));
    return Response.json({ purged: true }, { status: 200 });
  }) as typeof fetch;
  try {
    const response = await memoryRoute.POST(make());
    return {
      sent,
      status: response.status,
      location: response.headers.get("location") ?? ""
    };
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [
      ["AUTODEV_CONTROL_API_TOKEN", previousToken],
      ["AUTODEV_CONTROL_API_BASE_URL", previousBase]
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a purge from another site is refused and reaches nothing", async () => {
  const outcome = await submit(() => crossOriginForm(PURGE));

  assert.deepEqual(
    outcome.sent,
    [],
    "a request the origin refused must not reach the Runtime"
  );
  assert.equal(outcome.status, 303);
  assert.match(
    outcome.location,
    /^\/memory\?control=failed$/u,
    "the operator is sent back to Memory carrying the shared notice"
  );
});

test("a JSON body from another site is refused and reaches nothing", async () => {
  const outcome = await submit(() =>
    crossOriginJson({ action: "invalidate", recordId: "mem-1", ...EVIDENCE })
  );

  assert.deepEqual(
    outcome.sent,
    [],
    "a request the origin refused must not reach the Runtime"
  );
  assert.equal(outcome.status, 403);
});

test("a request with no origin at all is refused", async () => {
  // A request that names no origin is not one the operator's browser made,
  // and the route has no other way to tell whose it was.
  const outcome = await submit(
    () =>
      new NextRequest("http://console.test/api/memory", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(PURGE).toString()
      })
  );

  assert.deepEqual(outcome.sent, []);
  assert.equal(outcome.status, 303);
});

test("the operator's own purge still lands", async () => {
  // The refusal above is only worth anything if the real thing still works.
  const outcome = await submit(() => sameOriginRequest(PURGE));

  assert.equal(outcome.sent.length, 1, "the Runtime is asked to purge");
  assert.equal(outcome.status, 303);
  assert.match(outcome.location, /^\/memory\?/u);
  assert.doesNotMatch(outcome.location, /control=failed/u);
});
