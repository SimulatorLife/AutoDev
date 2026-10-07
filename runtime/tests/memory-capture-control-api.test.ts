import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder,
  type RecordedResponse
} from "./support/control-api-harness.ts";

/**
 * The native capture route's refusals.
 *
 * `POST /control/memory/capture` turns a session on disk into a stored
 * experience envelope. It is the one memory route where the guard *is* the
 * design: the request names its own session and its own transcript, so authority
 * has to come from somewhere the caller does not control — the router's record
 * of sessions it actually observed. It had no route-level test at all.
 *
 * The accepted path needs a session the router really saw, registered from a
 * workspace the store knows about and not reachable from a unit test. Every
 * refusal does not need any of that, and the refusals are the whole boundary.
 *
 * Note what is *not* observable here: this handler builds its service with
 * `createOrchestratorMemoryService()` directly, never the injectable dependency,
 * so no stub can observe it being called. The equivalent guarantee — that a
 * refusal wrote nothing — comes from the audit trail instead, where `outcome:
 * "ok"` is emitted only after the envelope has been stored.
 */

const CAPTURE = "/control/memory/capture";

interface AuditEntry {
  readonly action: string;
  readonly resource: string;
  readonly outcome: "ok" | "denied" | "error";
  readonly changes: Record<string, unknown> | null;
  readonly reason?: string;
}

interface CallResult {
  readonly handled: boolean;
  readonly status: number;
  readonly headers: Record<string, string | number>;
  readonly body: Record<string, unknown> | null;
  readonly audits: AuditEntry[];
}

async function captureWith(
  request: IncomingMessage,
  role: "viewer" | "operator"
): Promise<CallResult> {
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  const handled = await handleMemoryControlApiRequest(
    request,
    response,
    CAPTURE,
    { actor: "test-operator", role },
    (entry) => audits.push(entry as AuditEntry)
  );
  return {
    handled,
    status: response.statusCode,
    headers: response.headers,
    body: responseBody(response),
    audits
  };
}

/** A capture request whose body is JSON, at the capture path. */
function captureRequest(body: unknown, role: "viewer" | "operator") {
  return captureWith(makeRequest("POST", CAPTURE, body as never), role);
}

/**
 * `sendMemoryError` nests under `error`, with the machine-readable code beside
 * the human message. Those two are exactly what the Console reads, so they are
 * what the assertions below name.
 */
function errorField(
  body: Record<string, unknown> | null,
  field: "code" | "message"
): unknown {
  const envelope = body?.["error"];
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>)[field]
    : undefined;
}

/** A capture request whose body is not JSON at all. */
function malformedRequest(role: "viewer" | "operator") {
  return captureWith(
    Object.assign(Readable.from(["{ this is not json"]), {
      method: "POST",
      url: CAPTURE,
      headers: { "content-type": "application/json" }
    }) as IncomingMessage,
    role
  );
}

const WELL_FORMED = {
  sessionId: "session-abc123",
  transcriptPath: "/root/.codex/sessions/2026/10/01/rollout.jsonl",
  cwd: "/workspace/repo"
} as const;

test("a viewer is refused before the body is read at all", async () => {
  // The role check runs ahead of parsing, which is observable: a body that
  // could not possibly parse still earns the authorization refusal rather than
  // a validation one. If the order ever inverts, a viewer starts learning about
  // the shape of a request it is not allowed to make.
  const { status, body, audits } = await malformedRequest("viewer");

  assert.equal(status, 403);
  assert.equal(errorField(body, "code"), "autodev_memory_capture_forbidden");
  assert.deepEqual(audits, [
    {
      action: "capture_experience",
      resource: "/control/memory/experiences",
      outcome: "denied",
      changes: null,
      reason: "viewer_cannot_capture"
    }
  ]);
});

test("the viewer refusal does not confirm the session exists", async () => {
  // The request named a session; a refusal that echoed it back would turn the
  // boundary into an existence oracle for sessions the caller cannot capture.
  const { body } = await captureRequest(WELL_FORMED, "viewer");

  assert.equal(errorField(body, "code"), "autodev_memory_capture_forbidden");
  assert.doesNotMatch(
    String(errorField(body, "message")),
    /session-abc123/u,
    "the refusal must not confirm the session exists"
  );
});

test("a session the router has not observed cannot be captured", async () => {
  // The request names the session, so naming it proves nothing. Without an
  // entry from the router — which saw that session in a workspace it was told
  // about — there is no authority to attribute the envelope to, and an operator
  // with a plausible body is refused all the same.
  const { status, body, audits } = await captureRequest(WELL_FORMED, "operator");

  assert.equal(status, 403);
  assert.equal(errorField(body, "code"), "autodev_memory_capture_scope_forbidden");
  assert.equal(audits.at(-1)?.reason, "session_scope_not_observed");
  assert.equal(audits.at(-1)?.outcome, "denied");
});

test("an operator-supplied field is refused rather than ignored", async () => {
  // `exactKeys`, not a permissive object. This is the one route where a field
  // the caller added is a field the handler would silently drop, which is
  // exactly how a workspace or an actor smuggled through the body goes
  // unnoticed. `workspaceId` is the dangerous one: the scope is supposed to come
  // from the router, never from the caller.
  const { status, body, audits } = await captureRequest(
    { ...WELL_FORMED, workspaceId: "someone-elses-workspace" },
    "operator"
  );

  assert.equal(status, 400);
  assert.equal(errorField(body, "code"), "autodev_memory_capture_invalid");
  assert.equal(audits.at(-1)?.reason, "invalid_capture");
});

test("a transcript path that is not absolute is refused", async () => {
  const { status, body } = await captureRequest(
    { ...WELL_FORMED, transcriptPath: "sessions/rollout.jsonl" },
    "operator"
  );

  assert.equal(status, 400);
  assert.equal(errorField(body, "code"), "autodev_memory_capture_invalid");
});

test("a session id the router could not have issued is refused", async () => {
  // The router's ids are opaque tokens; a path fragment arriving here is either
  // a caller guessing or a traversal attempt, and neither gets a scope check.
  const { status, body } = await captureRequest(
    { ...WELL_FORMED, sessionId: "../../etc/passwd" },
    "operator"
  );

  assert.equal(status, 400);
  assert.equal(errorField(body, "code"), "autodev_memory_capture_invalid");
});

test("the body is validated before the session is looked up", async () => {
  // Ordering, stated as a test. Every case here is both malformed *and* about a
  // session the router never saw; the answer must be the 400, not the 403. If
  // the trust lookup ran first, a caller could probe session existence by
  // watching which status came back.
  for (const body of [
    { ...WELL_FORMED, transcriptPath: "relative/rollout.jsonl" },
    { ...WELL_FORMED, sessionId: "../../etc/passwd" },
    { ...WELL_FORMED, unexpected: true }
  ]) {
    const { status, body: payload } = await captureRequest(body, "operator");
    assert.equal(
      status,
      400,
      `malformed body was not caught first: ${JSON.stringify(body)}`
    );
    assert.equal(
      errorField(payload, "code"),
      "autodev_memory_capture_invalid",
      `malformed body reached the trust lookup: ${JSON.stringify(body)}`
    );
  }
});

test("each refusal cause carries its own reason", async () => {
  // Distinct reasons, not one catch-all. These land in the audit trail an
  // operator reads after the fact, so "the router has not observed this
  // session" and "the body was malformed" have to stay distinguishable there.
  const malformedBody = await malformedRequest("viewer");
  const unknownSession = await captureRequest(WELL_FORMED, "operator");
  const extraField = await captureRequest(
    { ...WELL_FORMED, extra: "field" },
    "operator"
  );

  const reasons = [malformedBody, unknownSession, extraField].map(
    (result) => result.audits.at(-1)?.reason
  );
  assert.deepEqual(reasons, [
    "viewer_cannot_capture",
    "session_scope_not_observed",
    "invalid_capture"
  ]);
  assert.equal(new Set(reasons).size, reasons.length);
});

test("no refusal is audited as a success", async () => {
  // The guarantee a service stub cannot give here: `outcome: "ok"` is emitted
  // only after `captureExperienceIdempotently` has stored the envelope. If any
  // refusal reported `ok`, the write happened and the error is on top of it.
  const results = [
    await malformedRequest("viewer"),
    await captureRequest(WELL_FORMED, "operator"),
    await captureRequest({ ...WELL_FORMED, extra: "field" }, "operator"),
    await captureRequest({ ...WELL_FORMED, cwd: "relative/path" }, "operator"),
    await captureRequest({ ...WELL_FORMED, sessionId: "no/slashes" }, "operator")
  ];

  for (const result of results) {
    assert.ok(result.audits.length > 0, "a refusal must be audited");
    assert.notEqual(
      result.audits.at(-1)?.outcome,
      "ok",
      `a refusal reported success: ${JSON.stringify(result.audits.at(-1))}`
    );
  }
});

test("capture accepts POST and nothing else", async () => {
  // Capture is a write with side effects on disk and in storage; a GET that
  // silently captured would be the worst possible outcome, and a GET that
  // silently did nothing would look like a flaky hook.
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const result = await captureWith(makeRequest(method, CAPTURE), "operator");
    assert.equal(result.status, 405, `${method} was not refused`);
    assert.equal(
      errorField(result.body, "code"),
      "autodev_memory_method_not_allowed"
    );
    assert.equal(String(result.headers["allow"]).toUpperCase(), "POST");
  }
});