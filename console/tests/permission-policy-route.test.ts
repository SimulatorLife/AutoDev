import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import * as route from "../app/api/permissions/route.ts";

/**
 * The Console-side route that writes the canonical permission policy.
 *
 * The route is a boundary, not a decider: it takes the operator's edit from
 * the same-origin form, forwards it to Runtime as a typed PATCH with the
 * server-side credential, and answers with a redirect back to the surface the
 * write came from. Each case below is one the control on the permissions page
 * can actually produce, and each is pinned by what the route *sent* and where
 * it answered -- the Runtime decides whether the write is accepted, and the
 * route only says what the Runtime said.
 */

const PERMISSIONS_RETURN = "/permissions";
const REVISION = "a".repeat(64);

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
  return new NextRequest(`http://console.test/api/permissions`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString()
  });
}

const FIELDS = {
  expectedRevision: REVISION,
  returnTo: PERMISSIONS_RETURN,
  approvalPolicy: "on-demand",
  sandboxMode: "unrestricted",
  approvalsReviewer: "operator",
  networkAccess: "true",
  webSearch: "false"
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
      schema: "autodev-control-permissions-patch-v1",
      revision: "b".repeat(64),
      changed: true,
      policy: {
        approvalPolicy: "on-demand",
        sandboxMode: "unrestricted",
        approvalsReviewer: "operator",
        networkAccess: true,
        webSearch: false
      },
      applied: null,
      reconciliation: {
        status: {
          convergence: "pending",
          desiredGeneration: null,
          observedGeneration: null,
          restartRequired: false,
          lastApplyAt: null,
          lastObservationAt: null,
          lastError: null
        },
        history: []
      }
    },
    { status: 200 }
  );
}

function refusal(code: string, status: number): Response {
  return Response.json({ error: { code, message: "refused" } }, { status });
}

test("a policy write reaches the Runtime's permissions route with the revision it was decided on", async () => {
  const { sent, result } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS }))
  );

  assert.equal(sent.length, 1, "the submission should be one request");
  assert.equal(result.status, 303);
  assert.match(sent[0]?.url ?? "", /\/control\/permissions$/u);
  assert.equal(sent[0]?.method, "PATCH");
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.expectedRevision, REVISION);
  assert.equal(body.approvalPolicy, "on-demand");
  // The product's vocabulary is what the route forwards, and the Runtime
  // translates it back into the canonical source's own vocabulary.
  assert.equal(body.sandboxMode, "unrestricted");
  assert.equal(body.approvalsReviewer, "operator");
  assert.equal(body.networkAccess, true);
  assert.equal(body.webSearch, false);
});

test("a write answers to the permissions surface and nowhere else", async () => {
  const { result } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS }))
  );
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), PERMISSIONS_RETURN);

  // A destination the browser chose is a destination off this Console, so it
  // is replaced with the one path the policy is shown on.
  const { result: elsewhere } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS, returnTo: "https://elsewhere.test" }))
  );
  assert.equal(elsewhere.status, 303);
  assert.equal(elsewhere.headers.get("location"), PERMISSIONS_RETURN);
});

test("a revision conflict is reported as a conflict", async () => {
  const { result } = await withMockedFetch(
    () => refusal("autodev_control_permission_policy_revision_conflict", 409),
    () => route.POST(request({ ...FIELDS }))
  );
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=conflict/u);
});

test("a refused update is reported as a validation failure", async () => {
  const { result } = await withMockedFetch(
    () => refusal("autodev_control_permission_policy_invalid_update", 400),
    () => route.POST(request({ ...FIELDS }))
  );
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=validation/u);
});

test("a policy that was written but not applied is reported as an apply failure", async () => {
  const { result } = await withMockedFetch(
    () => refusal("autodev_control_permission_policy_apply_failed", 503),
    () => route.POST(request({ ...FIELDS }))
  );
  assert.equal(result.status, 303);
  // The canonical policy landed; the composed configuration could not be
  // refreshed from it. That is not the same as a write that did not land, and
  // the page says which one it was.
  assert.match(result.headers.get("location") ?? "", /save=apply-failed/u);
});

test("a write whose result could not be confirmed is reported as a failure", async () => {
  const { result } = await withMockedFetch(
    () => refusal("autodev_control_api_forbidden", 403),
    () => route.POST(request({ ...FIELDS }))
  );
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=failed/u);
});

test("a write that did not come from this Console is refused without reaching the Runtime", async () => {
  const { sent, result } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS }, "https://elsewhere.test"))
  );
  assert.equal(sent.length, 0, "the Runtime must not be called");
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=failed/u);
});

test("a write with no revision is refused before it reaches the Runtime", async () => {
  const { sent, result } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS, expectedRevision: "" }))
  );
  assert.equal(sent.length, 0, "the Runtime must not be called");
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=failed/u);
});

test("a setting outside the vocabulary is refused before it reaches the Runtime", async () => {
  const { sent, result } = await withMockedFetch(okResponse, () =>
    route.POST(request({ ...FIELDS, sandboxMode: "somewhere-else" }))
  );
  assert.equal(sent.length, 0, "the Runtime must not be called");
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /save=validation/u);
});
