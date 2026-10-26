import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import * as route from "../app/api/workspaces/[owner]/[repository]/route.ts";

/**
 * The Console-side route that writes one workspace's canonical configuration.
 *
 * The route is a boundary, not a decider: it takes the operator's edit from
 * the same-origin form, forwards it to Runtime as a typed PATCH with the
 * server-side credential, and answers with a redirect back to the surface the
 * write came from. Each case below is one the control on the row or on the
 * workspace's own page can actually produce, and each is pinned by what the
 * route *sent* and where it answered -- the Runtime decides whether the write
 * is accepted, and the route only says what the Runtime said.
 */

const WORKSPACE_ID = "SimulatorLife/FixtureGame";
const [WORKSPACE_OWNER, WORKSPACE_REPOSITORY] = WORKSPACE_ID.split("/");
const WORKSPACES_RETURN = "/workspaces";
const WORKSPACE_RETURN = `/workspaces/${WORKSPACE_OWNER}/${WORKSPACE_REPOSITORY}`;
const CONFIGURATION_PATH = `/api/workspaces/${WORKSPACE_OWNER}/${WORKSPACE_REPOSITORY}`;
const REVISION = "a".repeat(64);

function params(
  owner: string = WORKSPACE_OWNER ?? "",
  repository: string = WORKSPACE_REPOSITORY ?? ""
): { params: Promise<{ owner: string; repository: string }> } {
  return {
    params: Promise.resolve({ owner, repository })
  };
}

function request(
  fields: Record<string, string>,
  origin: string | null = "http://console.test"
): NextRequest {
  const headers: Record<string, string> = {
    accept: "*/*",
    host: "console.test",
    "sec-fetch-site": "same-origin",
    "content-type": "application/x-www-form-urlencoded"
  };
  if (origin !== null) headers.origin = origin;
  return new NextRequest(`http://console.test${CONFIGURATION_PATH}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString()
  });
}

const FIELDS = {
  expectedRevision: REVISION,
  returnTo: WORKSPACE_RETURN,
  enabled: "false",
  baseBranch: "release",
  agentRolesMode: "scoped",
  agentRoles: "worker, reviewer"
} as const;

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

async function withMockedFetch<T>(
  respond: () => Response | Promise<Response>,
  run: () => Promise<T>
): Promise<{ readonly sent: Sent[]; readonly result: T }> {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "p".repeat(64);
  const sent: Sent[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    sent.push({
      url: String((input as Request).url ?? input),
      method: init?.method ?? "GET",
      body: String(init?.body ?? "")
    });
    return respond();
  }) as typeof fetch;
  try {
    const result = await run();
    return { sent, result };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
}

function okResponse(): Response {
  return Response.json(
    {
      schema: "autodev-control-workspace-patch-v1",
      id: WORKSPACE_ID,
      revision: "b".repeat(64),
      changed: true,
      workspace: {
        id: WORKSPACE_ID,
        baseBranch: "release",
        enabled: false,
        agentRoles: ["worker", "reviewer"]
      }
    },
    { status: 200 }
  );
}

function refusal(code: string, status: number): Response {
  return Response.json({ error: { code, message: "refused" } }, { status });
}

test("a configuration write reaches the Runtime's workspace route with the revision it was decided on", async () => {
  const { sent, result } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS }), params())
  );

  assert.equal(sent.length, 1, "the submission should be one request");
  assert.equal(result.status, 303);
  assert.match(
    sent[0]?.url ?? "",
    /\/control\/workspaces\/SimulatorLife\/FixtureGame$/u
  );
  assert.equal(sent[0]?.method, "PATCH");
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.expectedRevision, REVISION);
  assert.equal(body.enabled, false);
  assert.equal(body.baseBranch, "release");
  assert.deepEqual(body.agentRoles, ["worker", "reviewer"]);
});

test("a write answers to the surface it came from", async () => {
  const { result } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS }), params())
  );
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), WORKSPACE_RETURN);

  // The list names the workspace the outcome is about, because the list
  // presents every workspace's configuration at once.
  const { result: listResult } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS, returnTo: WORKSPACES_RETURN }), params())
  );
  assert.equal(listResult.status, 303);
  assert.equal(
    listResult.headers.get("location"),
    `${WORKSPACES_RETURN}?workspace=${encodeURIComponent(WORKSPACE_ID)}`
  );
});

test("a revision conflict is reported as a conflict and keeps the revision the edit was written for", async () => {
  const { result } = await withMockedFetch(
    () => refusal("autodev_control_workspace_revision_conflict", 409),
    () => route.POST(request({ ...FIELDS }), params())
  );
  assert.equal(result.status, 303);
  const location = result.headers.get("location") ?? "";
  assert.match(location, /save=conflict/u);
  assert.match(location, /based=/u);
  // The control stays based on the revision the edit was written against, so
  // the operator's edit is not silently paired with a catalog it never saw.
  assert.ok(location.includes(`based=${REVISION}`));
});

test("a refused update is reported as a validation failure", async () => {
  const { result } = await withMockedFetch(
    () => refusal("autodev_control_workspace_invalid_update", 400),
    () => route.POST(request({ ...FIELDS }), params())
  );
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=validation/u);
});

test("a write whose result could not be confirmed is reported as a failure", async () => {
  const { result } = await withMockedFetch(
    () => new Response("upstream is down", { status: 502 }),
    () => route.POST(request({ ...FIELDS }), params())
  );
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=failed/u);
});

test("a destination the browser chose is not a destination", async () => {
  const { result } = await withMockedFetch(okResponse, () =>
    route.POST(
      request({ ...FIELDS, returnTo: "https://elsewhere.test/steal" }),
      params()
    )
  );
  assert.equal(result.status, 303);
  const location = result.headers.get("location") ?? "";
  assert.ok(location.startsWith(WORKSPACES_RETURN));
  assert.equal(location.includes("elsewhere.test"), false);
});

test("a submission that did not come from this Console is refused before the Runtime is asked", async () => {
  const { sent, result } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS }, "https://elsewhere.test"), params())
  );
  assert.equal(
    sent.length,
    0,
    "the Runtime is not asked about a foreign write"
  );
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=failed/u);
});

test("a submission that carries no revision is refused before the Runtime is asked", async () => {
  const { sent, result } = await withMockedFetch(okResponse, () =>
    route.POST(
      request({
        ...FIELDS,
        expectedRevision: ""
      }),
      params()
    )
  );
  assert.equal(
    sent.length,
    0,
    "the Runtime is not asked about an unbound write"
  );
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=failed/u);
});

test("a scope that is not configured is written as no scope at all", async () => {
  const { sent, result } = await withMockedFetch(okResponse, () =>
    route.POST(
      request({ ...FIELDS, agentRolesMode: "unscoped", agentRoles: "" }),
      params()
    )
  );
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.agentRoles, null);
  assert.equal(result.status, 303);
});

test("a scope that names no role is written as an empty scope, not as an open one", async () => {
  const { sent } = await withMockedFetch(okResponse, () =>
    route.POST(
      request({ ...FIELDS, agentRolesMode: "scoped", agentRoles: "" }),
      params()
    )
  );
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body.agentRoles, []);
});
