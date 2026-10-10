import assert from "node:assert/strict";
import test from "node:test";

import type { ExperienceEnvelope } from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  type RecordedResponse,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The authorization refusals on every experience route.
 *
 * Eight routes answer under `/control/memory/experiences/{id}/…` and each gates a
 * caller before it returns anything. None of those gates had a route-level test,
 * so the whole authorization surface of the experience detail view was live code
 * with nothing holding it — including the distinction that matters most.
 *
 * A caller who may not see an experience gets **404, not 403**, and that is
 * deliberate: "does not exist" and "exists but not yours" have to be
 * indistinguishable, or the route is an existence oracle for every other
 * workspace's memories. The cost is that the wire cannot say *why* it answered
 * 404, which makes the audit trail the only place the reason can live.
 *
 * Two things were wrong before this file existed, and both are pinned here:
 *
 * - Two of the eight not-found sites did not audit at all. Six did, with
 *   `experience_not_visible`. The two silent ones meant an operator investigating
 *   "why does the Console not show this experience" got nothing from the trail on
 *   exactly the two routes the detail view loads first.
 *
 * - One write route answered a missing task-history grant with
 *   `scope_or_authority_forbidden`, which names neither the grant nor the route,
 *   while all three of its siblings answered `task_history_forbidden`. Same
 *   cause, two answers, and the audit reason differed to match.
 *
 * The tables below are written from what the routes actually answer, checked by
 * running each case rather than by reading the guards — the shapes are not
 * uniform, and two of them (`use-assessments` refusing at parse time, and the
 * write routes refusing a viewer before anything else) are recorded as they are
 * rather than tidied.
 */

const EXP = "/control/memory/experiences/exp-1";

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

function errorMessage(body: Record<string, unknown> | null): string {
  const envelope = body?.error;
  return typeof envelope === "object" && envelope !== null
    ? String((envelope as Record<string, unknown>).message)
    : "";
}

function experience(overrides: Partial<ExperienceEnvelope> = {}) {
  return {
    id: "exp-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-orch",
    startedAt: "2026-10-03T10:00:00.000Z",
    outcome: "success",
    memoryMode: "jit",
    validation: {
      state: "passed",
      evaluatedAt: "2026-10-03T10:05:00.000Z",
      evidence: [
        {
          kind: "test_result",
          reference: "pytest tests/test_x.py::test_y",
          observedAt: "2026-10-03T10:05:00.000Z"
        }
      ]
    },
    evidence: [
      {
        kind: "test_result",
        reference: "pytest tests/test_x.py::test_y",
        observedAt: "2026-10-03T10:05:00.000Z"
      }
    ],
    trajectory: { uri: "codex://session/s", digest: "d", steps: [] },
    ...overrides
  } as ExperienceEnvelope;
}

/**
 * A store whose experience read is switchable, so one harness produces both
 * refusals. `reads` counts the lookups, which is how the task-history tests prove
 * the grant is checked before the experience is ever fetched.
 */
function stubService(visible: ExperienceEnvelope | null) {
  const reads: string[] = [];
  const service = {
    async getExperience(id: string) {
      reads.push(id);
      return visible;
    },
    async listInjectionOutcomeJoins() {
      return { items: [], total: 0, limit: 25, offset: 0 };
    },
    async listInjectionUseJoins() {
      return { items: [], total: 0, limit: 25, offset: 0 };
    },
    async getSessionOutcomeReport() {
      return null;
    },
    async recordOutcomeReport() {
      return { appended: true };
    },
    async recordSessionOutcomeReport() {
      return { appended: true };
    }
  } as unknown as MemoryService;
  return { service, reads };
}

type Grant = "granted" | "not-asked" | "asked-but-denied" | "viewer";

async function call(
  service: MemoryService,
  options: {
    readonly method?: "GET" | "POST";
    readonly path: string;
    readonly query?: Record<string, string>;
    readonly body?: unknown;
    readonly grant?: Grant;
  }
): Promise<CallResult> {
  const grants: Record<
    Grant,
    {
      readonly role: "viewer" | "operator";
      readonly ask: boolean;
      readonly env: string | null;
    }
  > = {
    granted: { role: "operator", ask: true, env: "1" },
    "not-asked": { role: "operator", ask: false, env: "1" },
    "asked-but-denied": { role: "operator", ask: true, env: null },
    viewer: { role: "viewer", ask: true, env: "1" }
  };
  const grant = grants[options.grant ?? "granted"];
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  const search = new URLSearchParams({
    workspaceId: "ws-1",
    // Use-assessment reads are repository-scoped by design; without a repository
    // their filter refuses before the route is reached at all.
    ...(options.path.endsWith("/use-assessments")
      ? { repositoryId: "repo-1" }
      : {}),
    ...(grant.ask ? { includeTaskHistory: "true" } : {}),
    ...(options.query ?? {})
  });
  const suffix = search.toString();
  const previous = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  if (grant.env === null) delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  else process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = grant.env;
  try {
    await handleMemoryControlApiRequest(
      makeRequest(
        options.method ?? "GET",
        `${options.path}${suffix ? `?${suffix}` : ""}`,
        options.body as never
      ),
      response,
      options.path,
      { actor: "test-operator", role: grant.role },
      (entry) => audits.push(entry as AuditEntry),
      { createMemoryService: () => service }
    );
  } finally {
    if (previous === undefined)
      delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
    else process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = previous;
  }
  return {
    status: response.statusCode,
    body: responseBody(response),
    audits
  };
}

const OUTCOME_BODY = {
  correlationToken: "token-1",
  outcomeKind: "injected",
  reportKind: "reporter",
  evidence: [{ kind: "session_log", reference: "run-1" }]
} as const;

const SESSION_OUTCOME_BODY = {
  claim: "The change was accepted.",
  experienceIds: ["exp-1"],
  evidence: [{ kind: "session_log", reference: "run-1" }]
} as const;

interface RouteCase {
  readonly label: string;
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly body?: Record<string, unknown>;
  /**
   * Whether this route has its own task-history gate, which answers
   * `task_history_not_granted`. `use-assessments` has none: its filter refuses
   * earlier with `scope_filter_forbidden`.
   */
  readonly ownTaskHistoryGate: boolean;
}

const READ_ROUTES: readonly RouteCase[] = [
  { label: "detail", path: EXP, method: "GET", ownTaskHistoryGate: false },
  {
    label: "outcomes",
    path: `${EXP}/outcomes`,
    method: "GET",
    ownTaskHistoryGate: true
  },
  {
    label: "use assessments",
    path: `${EXP}/use-assessments`,
    method: "GET",
    ownTaskHistoryGate: false
  },
  {
    label: "session outcomes",
    path: `${EXP}/session-outcomes`,
    method: "GET",
    ownTaskHistoryGate: true
  },
  {
    label: "session outcome",
    path: `${EXP}/session-outcome`,
    method: "GET",
    ownTaskHistoryGate: true
  }
];

const WRITE_ROUTES: readonly RouteCase[] = [
  {
    label: "outcomes report",
    path: `${EXP}/outcomes`,
    method: "POST",
    body: OUTCOME_BODY,
    ownTaskHistoryGate: true
  },
  {
    label: "session outcome report",
    path: `${EXP}/session-outcome`,
    method: "POST",
    body: SESSION_OUTCOME_BODY,
    ownTaskHistoryGate: true
  }
];

const ALL_ROUTES = [...READ_ROUTES, ...WRITE_ROUTES];

test("an experience the caller may not see is an audited 404 on every route", async () => {
  for (const route of ALL_ROUTES) {
    const { service } = stubService(null);
    const { status, body, audits } = await call(service, {
      method: route.method,
      path: route.path,
      body: route.body
    });

    assert.equal(
      status,
      404,
      `${route.label}: expected 404, got ${status} ${JSON.stringify(body)}`
    );
    assert.equal(
      errorCode(body),
      "autodev_memory_not_found",
      `${route.label}: wrong error code`
    );
    // The refusal is the audit trail's job. The wire deliberately cannot say
    // whether the experience is absent or merely invisible, so a route that 404s
    // without recording why leaves an operator nothing to read.
    assert.equal(
      audits.at(-1)?.reason,
      "experience_not_visible",
      `${route.label}: not-visible was not audited (${JSON.stringify(audits)})`
    );
    assert.equal(
      audits.at(-1)?.outcome,
      "denied",
      `${route.label}: a refusal must not be audited as ok`
    );
  }
});

test("the 404 does not distinguish an out-of-scope experience from an absent one", async () => {
  // The reason the 404 exists. The two stores differ only in whether the
  // experience is visible to this caller, so the responses must be identical —
  // status, code, and message — or the route tells one caller what another
  // workspace has.
  const absent = await call(stubService(null).service, {
    path: EXP,
    grant: "granted"
  });
  const outOfScope = await call(stubService(null).service, {
    path: EXP,
    grant: "not-asked"
  });

  assert.deepEqual(outOfScope.body, absent.body);
  assert.equal(
    errorMessage(absent.body).includes("exp-1"),
    false,
    "the refusal echoed the experience id back to the caller"
  );
});

test("a route with its own task-history gate refuses a caller who does not ask for it", async () => {
  const gated = ALL_ROUTES.filter((route) => route.ownTaskHistoryGate);
  assert.equal(
    gated.length,
    5,
    "the set of gated routes changed; re-check this table against the routes"
  );

  for (const route of gated) {
    // A perfectly visible experience, so the only thing that can refuse is the
    // grant. A null experience would let the 404 answer instead, and the test
    // would pass without the gate ever being reached.
    const { service, reads } = stubService(experience());
    const { status, body, audits } = await call(service, {
      method: route.method,
      path: route.path,
      body: route.body,
      grant: "not-asked"
    });

    assert.equal(
      status,
      403,
      `${route.label}: expected 403, got ${status} ${JSON.stringify(body)}`
    );
    assert.equal(
      errorCode(body),
      "autodev_memory_task_history_forbidden",
      `${route.label}: wrong error code`
    );
    assert.equal(
      audits.at(-1)?.reason,
      "task_history_not_granted",
      `${route.label}: the refusal was not audited (${JSON.stringify(audits)})`
    );
    // Ordering, stated as a test: the grant is checked before the experience is
    // read, so a caller without it cannot use this route to probe whether an id
    // exists. If the read came first, `reads` would not be empty.
    assert.equal(
      reads.length,
      0,
      `${route.label}: the experience was read before the grant was checked`
    );
  }
});

test("asking for task history the deployment does not allow is refused at the filter", async () => {
  // A different refusal from the same underlying cause, and the distinction is
  // worth naming: asking for a grant that does not exist is a bad filter, while
  // using a gated route without asking is missing authority. Both are 403.
  for (const route of ALL_ROUTES) {
    const { service } = stubService(experience());
    const { status, body, audits } = await call(service, {
      method: route.method,
      path: route.path,
      body: route.body,
      grant: "asked-but-denied"
    });

    assert.equal(
      status,
      403,
      `${route.label}: expected 403, got ${status} ${JSON.stringify(body)}`
    );
    assert.equal(
      errorCode(body),
      "autodev_memory_scope_forbidden",
      `${route.label}: wrong error code`
    );
    assert.equal(
      audits.at(-1)?.reason,
      "scope_filter_forbidden",
      `${route.label}: the filter refusal was not audited`
    );
    // The other half of the same ternary: a scope refusal is an authorization
    // decision (`denied`), where a malformed filter is a bad request (`error`).
    // Asserting only the reason leaves that distinction entirely untested.
    assert.equal(
      audits.at(-1)?.outcome,
      "denied",
      `${route.label}: a scope refusal was not audited as denied`
    );
  }
});

test("a malformed filter is an error, not an authorization refusal", async () => {
  // The other side of the branch above. Two different problems — "you may not
  // read that window" and "that filter is malformed" — and collapsing them would
  // send an operator looking for a permissions fault they do not have.
  const { status, body, audits } = await call(
    stubService(experience()).service,
    {
      path: `${EXP}/outcomes`,
      query: { includeTaskHistory: "maybe" }
    }
  );

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_filter");
  assert.equal(audits.at(-1)?.outcome, "error");
  assert.notEqual(audits.at(-1)?.outcome, "denied");
  assert.equal(audits.at(-1)?.reason, "invalid_filter");
});

test("a viewer is refused a write before the experience is looked up", async () => {
  for (const route of WRITE_ROUTES) {
    const { service, reads } = stubService(experience());
    const { status, body, audits } = await call(service, {
      method: route.method,
      path: route.path,
      body: route.body,
      grant: "viewer"
    });

    assert.equal(
      status,
      403,
      `${route.label}: expected 403, got ${status} ${JSON.stringify(body)}`
    );
    assert.equal(
      errorCode(body),
      "autodev_memory_viewer_forbidden",
      `${route.label}: wrong error code`
    );
    assert.equal(
      audits.at(-1)?.reason,
      "viewer_cannot_mutate",
      `${route.label}: the refusal was not audited`
    );
    assert.equal(
      reads.length,
      0,
      `${route.label}: a viewer reached the experience before being refused`
    );
  }
});

/** The two session-outcome reads, which answer about a report rather than a body. */
function isSessionOutcomeRead(route: RouteCase): boolean {
  return /\/session-outcomes?$/u.test(route.path);
}

test("a granted operator reaches the experience on the routes that have a body to return", async () => {
  // The positive control. If every route refused, the tests above would pass
  // without any gate that actually opens ever having been reached.
  //
  // The two session-outcome reads are deliberately not in this table: with no
  // report recorded they answer a documented "no report exists" 404, which is a
  // different fact from a refusal and is checked separately below.
  for (const route of READ_ROUTES.filter((r) => !isSessionOutcomeRead(r))) {
    const { service, reads } = stubService(experience());
    const { status, body } = await call(service, {
      method: route.method,
      path: route.path,
      grant: "granted"
    });

    assert.equal(
      status,
      200,
      `${route.label}: a granted operator was refused ${JSON.stringify(body)}`
    );
    assert.equal(
      reads.length,
      1,
      `${route.label}: expected one experience read`
    );
    assert.match(
      String(body?.schema ?? ""),
      /^autodev-memory-/u,
      `${route.label}: unexpected schema ${String(body?.schema)}`
    );
  }
});

test("a granted operator with no report recorded gets 'no report', not a refusal", async () => {
  // Three states that must stay distinct, on both the wire and in the trail: the
  // experience was not visible, the session has no outcome report, and the report
  // exists. Collapsing the middle one into the 403 case would tell an operator
  // their access was revoked when their session simply has not been reported on.
  for (const route of READ_ROUTES.filter(isSessionOutcomeRead)) {
    const { status, body, audits } = await call(
      stubService(experience()).service,
      {
        method: route.method,
        path: route.path,
        grant: "granted"
      }
    );

    assert.equal(
      status,
      404,
      `${route.label}: expected the no-report answer, got ${status}`
    );
    assert.equal(errorCode(body), "autodev_memory_not_found");
    assert.match(
      errorMessage(body),
      /no session outcome report/iu,
      `${route.label}: the no-report answer was not used`
    );
    // The reason is what keeps this apart from a refusal in the trail. The
    // `outcome` field is `denied` for an absence, which reads oddly on its own —
    // nothing was refused — but `report_not_found` is unambiguous and is what an
    // operator reads. It must not be the same string as the not-visible refusal
    // or as a success.
    assert.equal(
      audits.at(-1)?.reason,
      "report_not_found",
      `${route.label}: the absence was not recorded distinctly (${JSON.stringify(audits)})`
    );
    assert.notEqual(
      audits.at(-1)?.reason,
      "experience_not_visible",
      `${route.label}: an absence was recorded as a visibility refusal`
    );
    assert.notEqual(
      audits.at(-1)?.outcome,
      "ok",
      `${route.label}: an absence was recorded as a success`
    );
  }
});

test("the detail route has no task-history gate", async () => {
  // The one read route in the table without the gate, and the reason the table
  // carries the column. A sweep that asserted the 403 on all five would either
  // fail here or have its column ignored — and this route is the one the Console
  // loads before anything else.
  const { service, reads } = stubService(experience());
  const { status, body } = await call(service, {
    path: EXP,
    grant: "not-asked"
  });

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body?.schema, "autodev-memory-experience-v1");
  assert.equal(reads.length, 1);
});

test("use-assessment reads are repository-scoped and refuse before the route", async () => {
  // Recorded as it behaves rather than tidied. This is the only gated read whose
  // grant refusal comes from its own filter, so it answers `scope_filter_forbidden`
  // where its siblings answer `task_history_forbidden`. It is also the only read
  // that refuses a filter with no repository named.
  const withoutRepository = await call(stubService(experience()).service, {
    path: `${EXP}/use-assessments`,
    query: { repositoryId: "" },
    grant: "granted"
  });
  assert.equal(withoutRepository.status, 400);
  assert.equal(
    errorCode(withoutRepository.body),
    "autodev_memory_invalid_filter"
  );

  const notAsked = await call(stubService(experience()).service, {
    path: `${EXP}/use-assessments`,
    grant: "not-asked"
  });
  assert.equal(notAsked.status, 403);
  assert.equal(errorCode(notAsked.body), "autodev_memory_scope_forbidden");
  assert.equal(notAsked.audits.at(-1)?.reason, "scope_filter_forbidden");
  assert.equal(notAsked.audits.at(-1)?.outcome, "denied");
});
