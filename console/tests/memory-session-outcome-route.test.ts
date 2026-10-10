import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import * as memoryRoute from "../app/api/memory/route.ts";

/**
 * The session-outcome submission the Console could not previously make.
 *
 * The Runtime bound exactly one report per session and served exactly one read
 * for it, and neither had a Console affordance: no route case, no transport, no
 * form. `recordSessionOutcomeReport` had a single production caller — the HTTP
 * route nothing in the Console called — so a session outcome could only exist if
 * something outside this product wrote it, while the cohort view aggregated them
 * as though operators could.
 *
 * Two things are worth pinning. The body must be exactly what the Runtime reads
 * under `exactKeys`, or the action is unreachable the way three lifecycle
 * actions once were. And the evidence check must happen here rather than being
 * forwarded, because "the Runtime refused it" and "the Console never asked" are
 * different facts about the session's history.
 */

function request(fields: Record<string, string>): NextRequest {
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

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

async function submit(
  fields: Record<string, string>,
  respond: () => Response = () =>
    Response.json({ schema: "autodev-memory-capture-v1" }, { status: 200 })
): Promise<{
  readonly sent: Sent[];
  readonly status: number;
  readonly location: string;
}> {
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
    const response = await memoryRoute.POST(request(fields));
    return {
      sent,
      status: response.status,
      location: response.headers.get("location") ?? ""
    };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
  }
}

const BASE = {
  action: "report-session-outcome",
  experienceId: "exp-1",
  workspaceId: "SimulatorLife/AutoDev",
  outcomeKind: "success",
  reportKind: "task",
  evidenceKind: "trajectory",
  evidenceUri: "codex://session/exp-1"
} as const;

test("a session outcome reaches the session-outcome endpoint", async () => {
  const { sent, status } = await submit({ ...BASE });

  assert.equal(status, 303);
  assert.equal(sent.length, 1, "the submission should be one request");
  assert.match(
    sent[0]?.url ?? "",
    /\/control\/memory\/experiences\/exp-1\/session-outcome\?/u,
    "it must go to the session outcome endpoint, not the injection outcome one"
  );
  assert.equal(sent[0]?.method, "POST");
});

test("the sent body is exactly what the Runtime reads", async () => {
  // `exactKeys` on `{outcomeKind, reportKind, evidence}`. Anything else is
  // refused outright, which is how verify, invalidate and revise once became
  // unreachable from the Console.
  const { sent } = await submit({ ...BASE });
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;

  assert.deepEqual(Object.keys(body).sort(), [
    "evidence",
    "outcomeKind",
    "reportKind"
  ]);
  assert.equal(body["outcomeKind"], "success");
  assert.equal(body["reportKind"], "task");
  assert.deepEqual(body["evidence"], [
    { kind: "trajectory", uri: "codex://session/exp-1" }
  ]);
});

test("the session identity rides in the path, never the body", async () => {
  // The Runtime derives workspace, repository and task from the captured
  // experience. A body naming them would either be refused as an unknown key or,
  // worse, become a way to report an outcome against a session not run here.
  const { sent } = await submit({
    ...BASE,
    workspaceId: "SimulatorLife/AutoDev",
    taskId: "attacker-run",
    correlationToken: "inj-1"
  });

  // Asserted before the body is parsed: an empty request list would make every
  // "not in the body" assertion below pass vacuously.
  assert.equal(sent.length, 1, "nothing was sent, so the body proves nothing");
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;

  for (const forbidden of [
    "workspaceId",
    "taskId",
    "correlationToken",
    "experienceId"
  ]) {
    assert.equal(
      body[forbidden],
      undefined,
      `the body must not carry ${forbidden}`
    );
  }
});

test("a claimed session outcome with no evidence is refused before the request", async () => {
  // The Runtime refuses a non-`unknown` outcome with no evidence. Saying so here
  // is true in a way the Runtime's answer would not be: the request never
  // reached it, so the session outcome is unrecorded rather than rejected.
  //
  // A form refusal is a redirect carrying the refusal code, not a 400 — the
  // browser is navigated back to the page it came from and the notice reads the
  // code off the query string.
  const { sent, status, location } = await submit({ ...BASE, evidenceUri: "" });

  assert.equal(sent.length, 0, "a refused outcome must not reach the Runtime");
  assert.equal(status, 303);
  assert.match(
    location,
    /refusal=evidence_required/u,
    "the refusal must name the missing field"
  );
});

test("an `unknown` session outcome needs no evidence", async () => {
  // Not knowing is a legitimate, recordable result. Forcing evidence onto it
  // would make the honest answer the one that cannot be filed, and reporting
  // would drift back towards claims.
  const { sent, status } = await submit({
    ...BASE,
    outcomeKind: "unknown",
    evidenceUri: ""
  });

  assert.equal(status, 303);
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body["outcomeKind"], "unknown");
});

test("a conflicting second outcome is reported as a conflict", async () => {
  // The Runtime treats a second, different outcome for the same session as a
  // conflict rather than a replacement, so this is the refusal the form's own
  // guard exists to prevent. It maps to the existing `conflicted` sentence —
  // "this changed since the list you acted on was read, reload and decide
  // again" — rather than to a new one invented for this route, which would
  // have to claim something the Console cannot know about the stored report.
  const { sent, status, location } = await submit({ ...BASE }, () =>
    Response.json(
      { error: { message: "conflict", code: "autodev_memory_conflict" } },
      { status: 409 }
    )
  );

  assert.equal(sent.length, 1, "the Runtime should have been asked");
  assert.equal(status, 303);
  assert.match(location, /refusal=conflicted/u);
});
