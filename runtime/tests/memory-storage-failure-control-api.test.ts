import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryAuthorizationError,
  MemoryValidationError,
  type MemoryService
} from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  responseBody,
  type RecordedResponse,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * What the memory routes answer when storage is not there, or fails.
 *
 * These are the states an operator meets when the deployment is broken rather
 * than the request being wrong, and they sit at the one place on the route
 * where nothing else is reached: the read is never handed to a service, so the
 * response is the only channel and the audit trail is the only record. Both
 * were previously silent — a read that fell over left the operator looking at a
 * page that would not load and a trail that said the reads had succeeded.
 *
 * The distinction that matters throughout: "you may not see this" (403),
 * "that is not there" (404), "storage is not configured" (503 unavailable) and
 * "the operation fell over" (503 failed) are four different facts, and
 * collapsing any two of them leaves the operator guessing which one happened.
 */

const RECORDS = "/control/memory/records";
const COHORTS = "/control/memory/cohorts";
const SCOPE = "workspaceId=ws-1";

interface AuditEntry {
  readonly action: string;
  readonly resource: string;
  readonly outcome: "ok" | "denied" | "error";
  readonly changes: Record<string, unknown> | null;
  readonly reason?: string;
}

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly audits: AuditEntry[];
}

function errorCode(body: Record<string, unknown> | null): unknown {
  const envelope = body?.["error"];
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>)["code"]
    : undefined;
}

async function call(
  method: "GET" | "POST",
  path: string,
  service: MemoryService | null,
  body?: Record<string, unknown>
): Promise<CallResult> {
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  await handleMemoryControlApiRequest(
    makeRequest(method, `${path}?${SCOPE}`, body),
    response,
    path,
    { actor: "test-operator", role: "operator" },
    (entry) => audits.push(entry as AuditEntry),
    { createMemoryService: () => service }
  );
  return {
    status: response.statusCode,
    body: responseBody(response),
    audits
  };
}

/**
 * A service whose reads raise whatever it was given.
 *
 * `listMemories` is the method the records read actually calls — stubbing
 * `listRecords` instead would make the service throw `TypeError: ... is not a
 * function`, which the route correctly reports as a failed operation, so the
 * case would pass without the error under test ever being raised.
 */
function failingService(error: unknown): MemoryService {
  const raise = async () => {
    throw error;
  };
  return {
    listMemories: raise,
    listExperiences: raise,
    aggregateOutcomeCohorts: raise
  } as unknown as MemoryService;
}

test("a read against unconfigured storage says unavailable, not empty", async () => {
  // The failure this guards: a missing store answering with an empty page. An
  // empty list is a valid answer about the world; "unavailable" is an answer
  // about this deployment. Conflating them lets a broken install look like a
  // workspace that has learned nothing.
  const { status, body } = await call("GET", RECORDS, null);

  assert.equal(status, 503);
  assert.equal(errorCode(body), "autodev_memory_unavailable");
  assert.notEqual(errorCode(body), "autodev_memory_operation_failed");
});

test("a write against unconfigured storage says the same thing", async () => {
  // One state, one code: whether the caller was reading or writing, the cause
  // is the same missing configuration, and a caller retrying the write should
  // not have to know which half of the route it landed on.
  const { status, body } = await call("POST", RECORDS, null, {
    claim: "a claim",
    evidence: [{ kind: "trajectory", uri: "codex://session/1" }]
  });

  assert.equal(status, 503);
  assert.equal(errorCode(body), "autodev_memory_unavailable");
});

test("an unavailable read is audited, not silent", async () => {
  // Reads are audited when they succeed, so leaving the failure unrecorded
  // makes the trail actively misleading: it reads as a clean run of reads over
  // a store that was never there. This is the only trace the attempt leaves.
  const { audits } = await call("GET", RECORDS, null);

  assert.equal(audits.length, 1);
  assert.equal(audits.at(-1)?.reason, "memory_unavailable");
  assert.equal(audits.at(-1)?.outcome, "error");
  assert.equal(audits.at(-1)?.changes, null);
  assert.equal(
    audits.at(-1)?.resource,
    `/control/memory/records`,
    "the refusal must name the resource it was for"
  );
});

test("a refused read is refused before storage is consulted", async () => {
  // Authorization outranks availability. A reader who may not ask for a global
  // window must be told so, and must not instead be told that storage is
  // misconfigured — that sends an operator to fix a deployment when the answer
  // was in their own permissions, and a viewer must not be able to probe the
  // deployment's health at all.
  const audits: AuditEntry[] = [];
  const response = responseRecorder();
  await handleMemoryControlApiRequest(
    makeRequest("GET", `${RECORDS}?${SCOPE}&includeGlobal=true`),
    response,
    RECORDS,
    { actor: "test-operator", role: "viewer" },
    (entry) => audits.push(entry as AuditEntry),
    { createMemoryService: () => null }
  );

  assert.equal(response.statusCode, 403);
  assert.equal(
    errorCode(responseBody(response)),
    "autodev_memory_scope_forbidden",
    "a global read was answered as a filter problem, not an authority one"
  );
  assert.notEqual(
    errorCode(responseBody(response)),
    "autodev_memory_unavailable",
    "an authority refusal must not disclose that storage is unavailable"
  );
  assert.equal(
    audits.some((entry) => entry.reason === "memory_unavailable"),
    false,
    "an authority refusal must not be recorded as an availability failure"
  );
});

test("a read that falls over is told the operation failed", async () => {
  // Distinct from "storage is not configured": here the store exists and the
  // work failed. It is also the code the Console has no distinct message for,
  // so it is worth pinning here.
  const { status, body, audits } = await call(
    "GET",
    RECORDS,
    failingService(new Error("connection terminated unexpectedly"))
  );

  assert.equal(status, 503);
  assert.equal(errorCode(body), "autodev_memory_operation_failed");
  assert.equal(audits.at(-1)?.reason, "operation_failed");
});

test("a failed read does not leak the underlying failure", async () => {
  // The store's own error text reaches an operator-facing surface through this
  // message. A connection string or a table name in that sentence is a
  // disclosure; the operator needs to know it failed, not how the database is
  // configured.
  const { body } = await call(
    "GET",
    RECORDS,
    failingService(
      new Error("connect ECONNREFUSED postgres://user:hunter2@db:5432/memory")
    )
  );

  const message = String(
    (body?.["error"] as Record<string, unknown> | undefined)?.["message"]
  );
  assert.doesNotMatch(message, /hunter2/u);
  assert.doesNotMatch(message, /ECONNREFUSED/u);
  assert.doesNotMatch(message, /postgres:\/\//u);
});

test("a read refused by validation is not reported as a failed operation", async () => {
  // These two ask for opposite responses. A rejected request is the caller's
  // to fix and will fail identically on retry; a failed operation is the
  // store's and retrying is the answer. Answering 503 to a bad request trains
  // an operator to retry something that can never succeed.
  const { status, body, audits } = await call(
    "GET",
    RECORDS,
    failingService(new MemoryValidationError("cohort filter is invalid"))
  );

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
  assert.equal(audits.at(-1)?.reason, "invalid_request");
});

test("an authorization failure on a read is a refusal, not a storage failure", async () => {
  // The service re-checks authority per record, so it can raise this from a
  // read even though the filter layer already decided the caller was
  // permitted. It must be answered the same way the write path answers it —
  // telling an operator their permissions problem is a broken install sends
  // them to the wrong place entirely.
  const { status, body, audits } = await call(
    "GET",
    RECORDS,
    failingService(
      new MemoryAuthorizationError("Operator task-history access is required.")
    )
  );

  assert.equal(status, 403);
  assert.equal(errorCode(body), "autodev_memory_forbidden");
  assert.notEqual(
    errorCode(body),
    "autodev_memory_operation_failed",
    "a refusal must not be reported as a failed operation"
  );
  assert.notEqual(
    errorCode(body),
    "autodev_memory_unavailable",
    "a refusal must not be reported as missing storage"
  );
  assert.equal(audits.at(-1)?.reason, "scope_or_authority_forbidden");
  assert.equal(audits.at(-1)?.outcome, "denied");
});

test("no failed read is audited as a success", async () => {
  // The invariant the whole trail depends on. A read that failed and reported
  // `ok` would let an operator conclude from the record that the page they
  // cannot load was read successfully.
  const results = [
    await call("GET", RECORDS, null),
    await call("POST", RECORDS, null, { claim: "c", evidence: [] }),
    await call("GET", RECORDS, failingService(new Error("boom"))),
    await call(
      "GET",
      RECORDS,
      failingService(new MemoryValidationError("bad filter"))
    )
  ];

  for (const result of results) {
    assert.ok(result.audits.length > 0, "a failed read must be audited");
    assert.notEqual(
      result.audits.at(-1)?.outcome,
      "ok",
      `a failed read reported success: ${JSON.stringify(result.audits.at(-1))}`
    );
  }
});

test("the storage status route still answers without a service", async () => {
  // The route that exists precisely so an operator can diagnose the
  // unavailable state must keep working in it. It is served before the service
  // is resolved, which is why it is the one path that must not be given the
  // new audit-and-refuse treatment.
  const audits: AuditEntry[] = [];
  const response = responseRecorder();
  const handled = await handleMemoryControlApiRequest(
    makeRequest("GET", "/control/memory/status"),
    response,
    "/control/memory/status",
    { actor: "test-operator", role: "operator" },
    (entry) => audits.push(entry as AuditEntry),
    { createMemoryService: () => null }
  );

  assert.equal(handled, true);
  assert.equal(
    response.statusCode,
    200,
    "the diagnostic route is the one that must not report unavailable"
  );
  assert.equal(
    audits.some((entry) => entry.reason === "memory_unavailable"),
    false,
    "the status route must not report itself unavailable"
  );
});