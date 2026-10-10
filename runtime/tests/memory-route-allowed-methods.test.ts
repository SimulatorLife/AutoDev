import assert from "node:assert/strict";
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
 * The `Allow` header every memory route returns with a 405.
 *
 * `allowedMethod` is a decision table over sixteen routes, and its
 * non-GET/non-POST branch had no test. That branch is the one a client actually
 * reads: a 405 means "try something else", and the only thing telling it what is
 * the header.
 *
 * The rule is RFC 9110 §15.5.6 — a 405 "MUST generate an `Allow` header field
 * containing a list of the target resource's currently supported methods" — and
 * the test states it as the invariant rather than as sixteen expected strings.
 * What each route accepts is discovered by asking it; what it advertises is read
 * off the 405; the two must agree. That is the form that catches a route gaining
 * or losing a method, and it is why this does not need updating when a route is
 * added.
 *
 * It caught a real one. `POST /control/memory/records` proposes a memory and
 * returns 200, but the table only counted the experience action routes, so every
 * 405 from the records collection answered `Allow: GET` — telling a client that
 * POST was unavailable on a route that had just accepted one. The table now
 * derives the answer from `canPost` rather than repeating a list of the action
 * routes that happened to be thought of, which is also why it no longer needs
 * updating when a route is added.
 */

const ROOT = "/control/memory";

interface AuditEntry {
  readonly action: string;
  readonly outcome: string;
  readonly reason?: string;
}

/** Every route that answers under `/control/memory`. */
const ROUTES: readonly string[] = [
  "records",
  "records/r1",
  "records/r1/verify",
  "records/r1/revise",
  "records/r1/invalidate",
  "records/r1/supersede",
  "records/r1/promote-skill",
  "records/r1/history",
  "records/r1/why",
  "experiences",
  "experiences/e1",
  "experiences/e1/purge",
  "experiences/e1/outcomes",
  "experiences/e1/session-outcome",
  "experiences/e1/session-outcomes",
  "experiences/e1/use-assessments",
  "cohorts",
  "session-cohorts",
  "use-cohorts",
  "status"
];

/** The proposal body that makes `POST /control/memory/records` succeed. */
const PROPOSAL = {
  kind: "semantic",
  scope: { kind: "workspace", workspaceId: "ws-1" },
  claim: "A durable claim.",
  experienceIds: ["e1"],
  evidence: [{ kind: "trace", uri: "trace://r1" }]
} as const;

/**
 * A store that answers anything. Which status a method produces has to come from
 * the route's own decision, not from a double that only implements some methods
 * — a stub missing a method would answer 503, which is not 405, and would make
 * every route look like it accepted the method.
 */
function permissiveService(): MemoryService {
  return new Proxy({} as MemoryService, {
    get: () => async () => ({
      items: [],
      total: 0,
      limit: 25,
      offset: 0,
      steps: [],
      id: "mem-1",
      kind: "semantic",
      claim: "A durable claim."
    })
  });
}

async function ask(
  route: string,
  method: string,
  body?: unknown
): Promise<{ status: number; allow: string | undefined; body: unknown }> {
  const response: RecordedResponse = responseRecorder();
  const path = `${ROOT}/${route}`;
  // Every route is asked with `includeTaskHistory=true` so that the
  // task-history gates are opened and cannot be mistaken for a method refusal.
  // That parameter is itself refused unless the deployment grants it, so the
  // grant is set for the ask and restored after — otherwise every experience
  // route would answer 403 and look like it accepted every method.
  const previous = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
  try {
    await handleMemoryControlApiRequest(
      makeRequest(
        method,
        `${path}?workspaceId=ws-1&includeTaskHistory=true`,
        body as never
      ),
      response,
      path,
      { actor: "test-operator", role: "operator" },
      () => {},
      { createMemoryService: () => permissiveService() }
    );
  } finally {
    if (previous === undefined)
      delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
    else process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = previous;
  }
  return {
    status: response.statusCode,
    allow:
      response.headers.allow === undefined
        ? undefined
        : String(response.headers.allow),
    body: responseBody(response)
  };
}

/**
 * The methods a route accepts, discovered rather than declared.
 *
 * Anything that is not a 405 was routed to something — a 400 means the body was
 * wrong, a 403 means a gate refused, a 200 means it worked. Only a 405 means the
 * method itself is not supported, which is what `Allow` has to describe.
 */
async function acceptedMethods(route: string): Promise<{
  readonly methods: string[];
  readonly statuses: Map<string, number>;
}> {
  const statuses = new Map<string, number>();
  const methods: string[] = [];
  for (const method of ["GET", "POST"]) {
    const result = await ask(route, method, PROPOSAL);
    statuses.set(method, result.status);
    if (result.status !== 405) methods.push(method);
  }
  return { methods, statuses };
}

test("every route's Allow header lists exactly the methods it accepts", async () => {
  // The RFC 9110 §15.5.6 invariant, stated over the whole surface. Asserted as
  // an agreement between two observations rather than sixteen expected strings,
  // so a route added later is covered without editing this file.
  for (const route of ROUTES) {
    const { methods, statuses } = await acceptedMethods(route);
    const refused = await ask(route, "PUT");

    assert.equal(
      refused.status,
      405,
      `${route}: PUT was not refused (${JSON.stringify(Object.fromEntries(statuses))})`
    );

    const advertised = (refused.allow ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(
      advertised,
      [...methods].sort(),
      `${route}: advertises [${advertised.join(", ")}] but accepts [${methods.join(", ") || "nothing"}]`
    );
  }
});

test("POST /control/memory/records is advertised, because it is accepted", async () => {
  // The one this file was written for. Named separately so the reason it exists
  // is readable without reconstructing it from the sweep above.
  const accepted = await ask("records", "POST", PROPOSAL);
  assert.equal(
    accepted.status,
    200,
    `the records collection did not accept a proposal: ${JSON.stringify(accepted.body)}`
  );

  const refused = await ask("records", "PUT");
  assert.equal(refused.status, 405);
  assert.equal(
    refused.allow,
    "GET, POST",
    "the collection advertised GET for a route that accepts POST"
  );
});

test("a POST-only route does not advertise GET", async () => {
  // The other direction, and the one a naive fix for the above gets wrong.
  // Widening the answer to "GET, POST" everywhere would have told a client that
  // GET was available on a route that answers 405 for it.
  for (const route of [
    "records/r1/verify",
    "records/r1/revise",
    "records/r1/invalidate",
    "records/r1/supersede",
    "records/r1/promote-skill",
    "experiences/e1/purge"
  ]) {
    const get = await ask(route, "GET");
    const refused = await ask(route, "PUT");

    assert.equal(get.status, 405, `${route}: GET was not refused`);
    assert.equal(refused.status, 405, `${route}: PUT was not refused`);
    assert.equal(
      refused.allow,
      "POST",
      `${route}: a POST-only route advertised ${String(refused.allow)}`
    );
  }
});

test("a GET-only route does not advertise POST", async () => {
  for (const route of [
    "records/r1",
    "records/r1/history",
    "records/r1/why",
    "experiences",
    "experiences/e1",
    "cohorts",
    "session-cohorts",
    "use-cohorts",
    "status"
  ]) {
    const post = await ask(route, "POST", PROPOSAL);
    const refused = await ask(route, "PUT");

    assert.equal(post.status, 405, `${route}: POST was not refused`);
    assert.equal(refused.status, 405, `${route}: PUT was not refused`);
    assert.equal(
      refused.allow,
      "GET",
      `${route}: a GET-only route advertised ${String(refused.allow)}`
    );
  }
});

test("every method other than GET and POST gets the same answer", async () => {
  // `allowedMethod` has one branch for "not a read and not the one write", and it
  // must not depend on which unsupported verb arrived. PUT, DELETE and PATCH
  // asking different things would mean the header described the request rather
  // than the resource.
  for (const route of ROUTES) {
    const answers = new Map<string, string | undefined>();
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD"]) {
      const result = await ask(route, method);
      answers.set(method, `${result.status} ${String(result.allow)}`);
    }
    const distinct = new Set(answers.values());
    assert.equal(
      distinct.size,
      1,
      `${route}: unsupported verbs answered differently: ${JSON.stringify(
        Object.fromEntries(answers)
      )}`
    );
  }
});

test("a 405 is audited, and a read that was merely wrong was not", async () => {
  // The audit distinction. A rejected PUT is a caller mistake worth recording; a
  // GET that 405s is not an authorization event and must not be reported as one.
  const rejected: AuditEntry[] = [];
  const read: AuditEntry[] = [];
  const path = `${ROOT}/records/r1/verify`;

  for (const [method, sink] of [
    ["PUT", rejected],
    ["GET", read]
  ] as const) {
    const response: RecordedResponse = responseRecorder();
    await handleMemoryControlApiRequest(
      makeRequest(method, `${path}?workspaceId=ws-1`),
      response,
      path,
      { actor: "test-operator", role: "operator" },
      (entry) => sink.push(entry as AuditEntry),
      { createMemoryService: () => permissiveService() }
    );
    assert.equal(response.statusCode, 405, `${method}`);
  }

  assert.equal(rejected.length, 1, "a rejected write was not audited");
  assert.equal(rejected[0]?.reason, "unsupported_memory_method");
  assert.equal(rejected[0]?.outcome, "denied");
  assert.equal(
    read.length,
    0,
    `a 405 on a read was audited: ${JSON.stringify(read)}`
  );
});

test("a viewer's 405 names the verb, not their role", async () => {
  // The reason this file also found something. A viewer sending an unsupported
  // verb gets the identical 405 and the identical `Allow` an operator does — the
  // route refused the verb, not the caller — but recorded it as
  // `viewer_cannot_mutate`. An operator reading that would go looking for a
  // permissions fault they would have hit identically.
  const roles = ["viewer", "operator"] as const;
  const recorded: string[] = [];

  for (const role of roles) {
    const audits: AuditEntry[] = [];
    const response: RecordedResponse = responseRecorder();
    const path = `${ROOT}/records/r1/verify`;
    await handleMemoryControlApiRequest(
      makeRequest("PUT", `${path}?workspaceId=ws-1`),
      response,
      path,
      { actor: `test-${role}`, role },
      (entry) => audits.push(entry as AuditEntry),
      { createMemoryService: () => permissiveService() }
    );

    assert.equal(response.statusCode, 405, `${role}: expected 405`);
    assert.equal(
      response.headers.allow,
      "POST",
      `${role}: the Allow header differed by role`
    );
    assert.equal(
      audits.at(-1)?.reason,
      "unsupported_memory_method",
      `${role}: recorded ${String(audits.at(-1)?.reason)}`
    );
    recorded.push(audits.at(-1)?.reason ?? "");
  }

  assert.equal(
    new Set(recorded).size,
    1,
    "the same refusal recorded two different causes by role"
  );
});

test("a viewer refused a write is refused before the method is considered", async () => {
  // Ordering. A viewer has no business POSTing anywhere, and that is a different
  // refusal from "this route does not take POST" — so a viewer POSTing a
  // POST-only route must be told it is not an operator, not that the method is
  // wrong, and must not be told the route accepts GET when it does not.
  const path = `${ROOT}/records/r1/verify`;
  const response: RecordedResponse = responseRecorder();
  const audits: AuditEntry[] = [];
  await handleMemoryControlApiRequest(
    makeRequest("POST", `${path}?workspaceId=ws-1`, PROPOSAL),
    response,
    path,
    { actor: "test-viewer", role: "viewer" },
    (entry) => audits.push(entry as AuditEntry),
    { createMemoryService: () => permissiveService() }
  );

  assert.equal(response.statusCode, 403);
  assert.equal(
    responseBody(response)?.error !== undefined,
    true,
    "a refusal must carry a body the hook can read"
  );
  assert.equal(audits.at(-1)?.reason, "viewer_cannot_mutate");
  // No `Allow` header: nothing here tells a viewer what the route supports, and
  // answering 403 with one would describe a resource they may not use.
  assert.equal(response.headers.allow, undefined);
});
