import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  type RecordedResponse,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The two arms that turn an unclassifiable request or an unclassifiable failure
 * into a safe answer.
 *
 * Both were the last thing in their function with nothing behind them.
 *
 * The capture routes' body refusal runs before the trust lookup, before the
 * transcript is opened, and before a service is resolved — which makes it the
 * boundary a hook hits when it is misconfigured. It had tests only for the
 * *viewer* case, and a viewer is refused by role before the body is ever read,
 * so the arm itself had never run: every existing malformed-body test proved the
 * role check comes first, and nothing proved what happens after it.
 *
 * The mutation catch is the mirror. A store that fails in a way the service did
 * not anticipate must not be reported as a bad request: 400 tells the caller its
 * request was wrong, which sends them to fix something that is fine, and retries
 * will fail the same way. 503 with `operation_failed` is the answer that keeps a
 * broken deployment from looking like a broken client.
 */

const CAPTURE = "/control/memory/capture";
const CLAUDE_CAPTURE = "/control/memory/claude-code/capture";
const RECORDS = "/control/memory/records";

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
  const envelope = body?.error;
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>).code
    : undefined;
}

async function call(
  request: IncomingMessage,
  pathname: string,
  service: MemoryService | null
): Promise<CallResult> {
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  const handled = await handleMemoryControlApiRequest(
    request,
    response,
    pathname,
    { actor: "test-operator", role: "operator" },
    (entry) => audits.push(entry as AuditEntry),
    { createMemoryService: () => service }
  );
  assert.equal(handled, true, `${pathname} was not handled`);
  return {
    status: response.statusCode,
    body: responseBody(response),
    audits
  };
}

/** A request whose body is raw text, with a content type the caller chooses. */
function rawRequest(
  url: string,
  body: string,
  contentType: string | null = "application/json"
): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    method: "POST",
    url,
    headers: contentType === null ? {} : { "content-type": contentType }
  }) as IncomingMessage;
}

/**
 * A store that refuses to be used. Every method throws, so a test that reaches
 * one fails loudly instead of quietly passing on a null answer.
 */
function forbiddenService(): MemoryService {
  return new Proxy({} as MemoryService, {
    get: () => async () => {
      throw new Error("the store must not be reached for an unreadable body");
    }
  });
}

/* ------------------------------------------------------------------ *
 * The capture routes' body refusal.
 * ------------------------------------------------------------------ */

const CAPTURE_ROUTES = [
  { label: "codex capture", path: CAPTURE },
  { label: "claude capture", path: CLAUDE_CAPTURE }
] as const;

/**
 * The three ways a body can be unreadable, plus the one that parses and is still
 * not an object. They share an arm in the route and differ in status and code,
 * which is the part worth pinning: a hook that posts the wrong content type
 * should be told so, rather than being told its JSON is malformed.
 */
const UNREADABLE_BODIES: readonly {
  readonly label: string;
  readonly raw: string;
  readonly contentType: string | null;
  readonly status: number;
  readonly code: string;
}[] = [
  {
    label: "not JSON at all",
    raw: "{ this is not json",
    contentType: "application/json",
    status: 400,
    code: "autodev_control_api_bad_body"
  },
  {
    label: "a JSON array rather than an object",
    raw: "[1, 2, 3]",
    contentType: "application/json",
    status: 400,
    code: "autodev_control_api_bad_body"
  },
  {
    label: "a bare JSON scalar",
    raw: '"just a string"',
    contentType: "application/json",
    status: 400,
    code: "autodev_control_api_bad_body"
  },
  {
    label: "the wrong content type",
    raw: '{"sessionId":"s"}',
    contentType: "text/plain",
    status: 415,
    code: "autodev_control_api_content_type"
  },
  {
    label: "no content type at all",
    raw: '{"sessionId":"s"}',
    contentType: null,
    status: 415,
    code: "autodev_control_api_content_type"
  }
];

test("an unreadable body is refused before the capture route does anything", async () => {
  for (const route of CAPTURE_ROUTES) {
    for (const body of UNREADABLE_BODIES) {
      const result = await call(
        rawRequest(route.path, body.raw, body.contentType),
        route.path,
        forbiddenService()
      );

      assert.equal(
        result.status,
        body.status,
        `${route.label} / ${body.label}: expected ${body.status}, got ${result.status}`
      );
      assert.equal(
        errorCode(result.body),
        body.code,
        `${route.label} / ${body.label}: wrong code`
      );
      // The store must never be reached. A malformed body is refused at the
      // boundary, not after an authority decision or a file read.
      assert.equal(
        result.audits.at(-1)?.reason,
        "invalid_body",
        `${route.label} / ${body.label}: ${JSON.stringify(result.audits)}`
      );
      assert.equal(
        result.audits.at(-1)?.outcome,
        "error",
        `${route.label} / ${body.label}: a refusal audited as ok`
      );
    }
  }
});

test("an unreadable body never reports a capture", async () => {
  // The guarantee that matters to the audit trail. `outcome: "ok"` is emitted
  // only after an envelope is stored, so a body refusal reported as `ok` would
  // mean the write happened and the error is on top of it.
  for (const route of CAPTURE_ROUTES) {
    for (const body of UNREADABLE_BODIES) {
      const result = await call(
        rawRequest(route.path, body.raw, body.contentType),
        route.path,
        forbiddenService()
      );

      assert.notEqual(
        result.audits.at(-1)?.outcome,
        "ok",
        `${route.label} / ${body.label}: reported a capture`
      );
      assert.equal(
        result.audits.filter((entry) => entry.outcome === "ok").length,
        0,
        `${route.label} / ${body.label}: audited a success`
      );
    }
  }
});

test("both capture routes refuse an unreadable body the same way", async () => {
  // They are one route with two adapters. A hook author comparing the two should
  // not have to learn that one of them answers a truncated body differently.
  for (const body of UNREADABLE_BODIES) {
    const codex = await call(
      rawRequest(CAPTURE, body.raw, body.contentType),
      CAPTURE,
      forbiddenService()
    );
    const claude = await call(
      rawRequest(CLAUDE_CAPTURE, body.raw, body.contentType),
      CLAUDE_CAPTURE,
      forbiddenService()
    );

    assert.equal(
      claude.status,
      codex.status,
      `${body.label}: the routes answered different statuses`
    );
    assert.deepEqual(
      claude.body,
      codex.body,
      `${body.label}: the routes answered different bodies`
    );
  }
});

test("an empty body is refused as a malformed body, not as an empty one", async () => {
  // A hook that fires before it has written anything posts zero bytes. That is a
  // body that could not be read, and it must not be reported as a capture
  // request with no fields — which would be a 400 with a different code and,
  // more importantly, would look like a well-formed request that was refused for
  // a reason about its contents.
  for (const route of CAPTURE_ROUTES) {
    const result = await call(
      rawRequest(route.path, "", "application/json"),
      route.path,
      forbiddenService()
    );

    assert.equal(result.status, 400, route.label);
    assert.equal(errorCode(result.body), "autodev_control_api_bad_body");
    assert.equal(result.audits.at(-1)?.reason, "invalid_body");
  }
});

/* ------------------------------------------------------------------ *
 * The mutation catch.
 * ------------------------------------------------------------------ */

const PROPOSAL = {
  kind: "semantic",
  scope: { kind: "workspace", workspaceId: "ws-1" },
  claim: "A durable claim.",
  experienceIds: ["e1"],
  evidence: [{ kind: "trace", uri: "trace://r1" }]
} as const;

/** A store whose proposal fails the way `throwable` says. */
function failingService(throwable: () => Error): MemoryService {
  return {
    async propose() {
      throw throwable();
    }
  } as unknown as MemoryService;
}

test("a store that fails unexpectedly is a 503, not a bad request", async () => {
  // The distinction an operator acts on. 400 says "your request was wrong", which
  // sends them to fix something that is fine, and a retry fails identically.
  // 503 says the deployment is unhealthy, which is what is true.
  const { status, body, audits } = await call(
    makeRequest("POST", `${RECORDS}?workspaceId=ws-1`, PROPOSAL),
    RECORDS,
    failingService(() => new Error("connection terminated unexpectedly"))
  );

  assert.equal(status, 503);
  assert.equal(errorCode(body), "autodev_memory_operation_failed");
  assert.equal(audits.at(-1)?.reason, "operation_failed");
  assert.equal(audits.at(-1)?.outcome, "error");
  assert.notEqual(audits.at(-1)?.reason, "invalid_request");
});

test("the unexpected-failure message is not echoed to the caller", async () => {
  // The reason a driver error must not travel. It carries the connection string
  // or the failing values, and the caller is the hook — an untrusted party that
  // should learn that the store is unavailable and nothing about the store.
  const secret = "connect ECONNREFUSED 10.0.0.7:5432 password=hunter2";
  const { status, body } = await call(
    makeRequest("POST", `${RECORDS}?workspaceId=ws-1`, PROPOSAL),
    RECORDS,
    failingService(() => new Error(secret))
  );

  assert.equal(status, 503);
  const serialised = JSON.stringify(body);
  assert.doesNotMatch(
    serialised,
    /hunter2/u,
    "a credential leaked to the caller"
  );
  assert.doesNotMatch(
    serialised,
    /10\.0\.0\.7/u,
    "a host leaked to the caller"
  );
  assert.doesNotMatch(serialised, /ECONNREFUSED/u, "a driver message leaked");
});

test("a read whose store fails unexpectedly is a 503 too", async () => {
  // The same judgement, reached by a different catch. There are two
  // `operation_failed` arms — one under the mutation path and one at the entry
  // that wraps every route — and a read that throws an unrecognised error must
  // get the same answer as a write. A read reported as a bad request would tell
  // the Console to retry something the caller did not get wrong.
  const { status, body, audits } = await call(
    makeRequest("GET", `${RECORDS}?workspaceId=ws-1`),
    RECORDS,
    failingService(() => new Error("the store went away"))
  );

  assert.equal(status, 503);
  assert.equal(errorCode(body), "autodev_memory_operation_failed");
  assert.equal(audits.at(-1)?.reason, "operation_failed");
  assert.notEqual(audits.at(-1)?.outcome, "ok");
});

test("a TypeError is still a validation failure, not an unexpected one", async () => {
  // The catch has two arms that both blame the caller — `MemoryValidationError`
  // and `TypeError` — and one that blames the deployment. A `TypeError` reaching
  // the route from a service is treated as a bad request, which is the same
  // judgement the filter stage makes when it throws one. Asserting it keeps the
  // two `TypeError` sources honest about which side of that line they sit on.
  const { status, body, audits } = await call(
    makeRequest("POST", `${RECORDS}?workspaceId=ws-1`, PROPOSAL),
    RECORDS,
    failingService(() => new TypeError("bad argument"))
  );

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
  assert.equal(audits.at(-1)?.reason, "invalid_request");
  assert.notEqual(audits.at(-1)?.reason, "operation_failed");
});
