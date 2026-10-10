import assert from "node:assert/strict";
import test from "node:test";

import type { ExperienceEnvelope } from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  responseBody,
  type RecordedResponse,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The three assessment paths that sit beside the outcome report.
 *
 * A use assessment says *which memories an injection actually influenced*; a
 * session outcome says *how the session as a whole went*. Both are the system
 * learning from itself, and all three routes here — the two writes and the
 * session-outcome read — had no route-level test.
 *
 * They are worth testing together precisely because they are not the same
 * shape. Each differs in a way that is easy to get wrong by assuming the
 * outcome report's rules:
 *
 * - a use assessment requires repository scope, and records *how many* memories
 *   were used rather than which, so the audit trail cannot become a second copy
 *   of the memory graph;
 * - a session outcome is refused outright for a repository-less experience,
 *   because a session's outcome is meaningless without knowing which repository
 *   the session ran against;
 * - its identity comes from the session itself rather than from anything the
 *   caller supplies, so one session has one outcome and a retried report lands
 *   on the same record instead of appending a second claim;
 * - it carries no scope, runId or agentId at all, because it is about one
 *   session rather than a run of it;
 * - the two writes authorize themselves differently, and the same missing grant
 *   produces two different codes on them.
 */

const EXPERIENCE_ID = "exp-1";
const EXPERIENCES = "/control/memory/experiences";
const TASK_HISTORY_ENV = "AUTODEV_MEMORY_READ_TASK_HISTORY";

/** Use assessments are repository-scoped; session outcomes are not. */
const REPO_SCOPE =
  "workspaceId=ws-1&repositoryId=owner/repo-1&includeTaskHistory=true";
const WORKSPACE_SCOPE = "workspaceId=ws-1&includeTaskHistory=true";

interface AuditEntry {
  readonly action: string;
  readonly outcome: string;
  readonly changes: Record<string, unknown> | null;
  readonly reason?: string;
}

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly audits: AuditEntry[];
  readonly recorded: Record<string, unknown> | undefined;
}

function errorCode(body: Record<string, unknown> | null): unknown {
  const envelope = body?.["error"];
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>)["code"]
    : undefined;
}

function experience(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPERIENCE_ID,
    workspaceId: "ws-1",
    repositoryId: "owner/repo-1",
    scope: { kind: "task", workspaceId: "ws-1", taskId: "task-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-orch",
    agentRole: "orchestrator",
    startedAt: "2026-10-03T10:00:00.000Z",
    outcome: "unknown",
    evidence: [],
    trajectory: { steps: [] },
    ...overrides
  } as unknown as ExperienceEnvelope;
}

/** Records whatever the service was handed, so payload and provenance are visible. */
function recordingService(options: { readonly visible?: boolean } = {}) {
  const state: { recorded: Record<string, unknown> | undefined } = {
    recorded: undefined
  };
  const service = {
    getExperience: async () =>
      options.visible === false ? null : experience(),
    recordInjectionUseReport: async (input: Record<string, unknown>) => {
      state.recorded = input;
      return { appended: true };
    },
    recordSessionOutcomeReport: async (input: Record<string, unknown>) => {
      state.recorded = input;
      return {
        id: String((input["report"] as { id: string }).id),
        appended: true
      };
    },
    getSessionOutcomeReport: async () => ({
      id: "memory-session-outcome-abc",
      outcomeKind: "success",
      reportKind: "task",
      evidence: [{ kind: "trajectory", uri: "codex://session/exp-1" }]
    })
  } as unknown as MemoryService;
  return { service, state };
}

async function call(
  method: "GET" | "POST",
  action: string,
  body?: Record<string, unknown>,
  options: {
    readonly query?: string;
    readonly grant?: boolean;
    readonly visible?: boolean;
    readonly overrides?: Record<string, unknown>;
  } = {}
): Promise<CallResult> {
  const { service, state } = recordingService(
    options.visible === undefined ? {} : { visible: options.visible }
  );
  const base = {
    getExperience: service.getExperience as () => Promise<unknown>,
    recordInjectionUseReport: (
      service as unknown as {
        recordInjectionUseReport: (i: Record<string, unknown>) => unknown;
      }
    ).recordInjectionUseReport,
    recordSessionOutcomeReport: (
      service as unknown as {
        recordSessionOutcomeReport: (i: Record<string, unknown>) => unknown;
      }
    ).recordSessionOutcomeReport,
    getSessionOutcomeReport: (
      service as unknown as {
        getSessionOutcomeReport: () => Promise<unknown>;
      }
    ).getSessionOutcomeReport
  };
  if (options.overrides) {
    base.getExperience = async () => experience(options.overrides);
  }
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  const pathname = `${EXPERIENCES}/${EXPERIENCE_ID}/${action}`;
  const query =
    options.query ??
    (action === "use-assessments" ? REPO_SCOPE : WORKSPACE_SCOPE);
  const previous = process.env[TASK_HISTORY_ENV];
  if (options.grant === false) delete process.env[TASK_HISTORY_ENV];
  else process.env[TASK_HISTORY_ENV] = "1";
  try {
    await handleMemoryControlApiRequest(
      makeRequest(method, `${pathname}?${query}`, body),
      response,
      pathname,
      { actor: "test-operator", role: "operator" },
      (entry) => audits.push(entry as AuditEntry),
      { createMemoryService: () => base as unknown as MemoryService }
    );
  } finally {
    if (previous === undefined) delete process.env[TASK_HISTORY_ENV];
    else process.env[TASK_HISTORY_ENV] = previous;
  }
  return {
    status: response.statusCode,
    body: responseBody(response),
    audits,
    recorded: state.recorded
  };
}

const USE_ASSESSMENT = {
  injectionEventId: "inj-1",
  useKind: "partially_used",
  usedMemoryIds: ["mem-1", "mem-2"],
  evidence: [{ kind: "trajectory", uri: "codex://session/exp-1" }]
} as const;

const SESSION_OUTCOME = {
  outcomeKind: "success",
  reportKind: "task",
  evidence: [{ kind: "trajectory", uri: "codex://session/exp-1" }]
} as const;

test("a use assessment records how many memories were used, never which", async () => {
  // The privacy property, stated as a test. The audit trail is operator-facing
  // and long-lived; if it listed the memory ids it would become a second copy
  // of the memory graph, readable by anyone who can read the trail.
  const { status, audits, recorded } = await call(
    "POST",
    "use-assessments",
    USE_ASSESSMENT
  );

  assert.equal(status, 200);
  assert.deepEqual(audits.at(-1)?.changes, {
    useKind: "partially_used",
    usedMemoryCount: 2,
    appended: true
  });
  assert.doesNotMatch(
    JSON.stringify(audits.at(-1)?.changes ?? {}),
    /mem-1|mem-2/u,
    "the audit must not name the memories that were used"
  );
  // The ids do reach the service, which is what the assessment is for.
  assert.deepEqual(recorded?.["usedMemoryIds"], ["mem-1", "mem-2"]);
  assert.equal(recorded?.["experienceId"], EXPERIENCE_ID);
  assert.equal(recorded?.["injectionEventId"], "inj-1");
});

test("a use assessment is refused without repository scope", async () => {
  // Which memories a repository's session used is a repository-scoped question,
  // so the route refuses rather than widening to the whole workspace.
  const { status, body } = await call(
    "POST",
    "use-assessments",
    USE_ASSESSMENT,
    {
      query: WORKSPACE_SCOPE
    }
  );

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_filter");
});

test("a use assessment is stopped at the filter gate without the grant", async () => {
  const { status, body } = await call(
    "POST",
    "use-assessments",
    USE_ASSESSMENT,
    {
      grant: false
    }
  );

  assert.equal(status, 403);
  assert.equal(errorCode(body), "autodev_memory_scope_forbidden");
});

test("a session outcome answers the same missing grant with a different code", async () => {
  // The same deficiency, on a sibling route, reported differently — and the
  // difference is real rather than cosmetic. This handler checks its own
  // authority and names task history, so the operator is told which grant to
  // ask for; the use assessment is stopped in filter parsing before any
  // handler runs and can only say the scope was refused.
  const use = await call("POST", "use-assessments", USE_ASSESSMENT, {
    grant: false
  });
  const session = await call("POST", "session-outcome", SESSION_OUTCOME, {
    grant: false,
    query: "workspaceId=ws-1"
  });

  assert.equal(use.status, 403);
  assert.equal(session.status, 403);
  assert.equal(errorCode(use.body), "autodev_memory_scope_forbidden");
  assert.equal(
    errorCode(session.body),
    "autodev_memory_task_history_forbidden"
  );
  assert.equal(session.audits.at(-1)?.reason, "task_history_not_granted");
});

test("a use assessment refuses an unknown use kind", async () => {
  const { status, body, recorded } = await call("POST", "use-assessments", {
    ...USE_ASSESSMENT,
    useKind: "ignored"
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
  assert.equal(recorded, undefined);
});

test("a use assessment refuses duplicated memory ids", async () => {
  // Duplicates would inflate the count the audit reports, so the count is only
  // trustworthy because the list is refused before it is used.
  const { status, body } = await call("POST", "use-assessments", {
    ...USE_ASSESSMENT,
    usedMemoryIds: ["mem-1", "mem-1"]
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("a use assessment refuses an unknown body key", async () => {
  // `outcomeKind` belongs to the sibling route. Carrying it here would be
  // ignored by the handler, which is exactly how a field starts meaning one
  // thing on the wire and another in the code that reads it.
  const { status, body } = await call("POST", "use-assessments", {
    ...USE_ASSESSMENT,
    outcomeKind: "success"
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("a use assessment refuses ids that are not strings", async () => {
  const { status, body } = await call("POST", "use-assessments", {
    ...USE_ASSESSMENT,
    usedMemoryIds: [1, 2]
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("a use assessment refuses an experience the caller cannot see", async () => {
  const { status, body, recorded } = await call(
    "POST",
    "use-assessments",
    USE_ASSESSMENT,
    { visible: false }
  );

  assert.equal(status, 404);
  assert.equal(errorCode(body), "autodev_memory_not_found");
  assert.equal(recorded, undefined);
});

test("a session outcome is refused for a repository-less experience", async () => {
  // A session's outcome is a statement about work against a repository, so with
  // no repository the statement has nothing to be about. The use assessment has
  // no such requirement, which is why assuming one rule for both would be wrong.
  const { status, body, recorded } = await call(
    "POST",
    "session-outcome",
    SESSION_OUTCOME,
    {
      overrides: { repositoryId: undefined }
    }
  );

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
  assert.equal(recorded, undefined);
});

test("a session outcome is named by the session, not by the caller", async () => {
  // No correlation token here, and deliberately so: the identity is the session
  // itself, so there is exactly one outcome per session and a retried report
  // lands on the same record instead of appending a second, competing claim.
  const first = await call("POST", "session-outcome", SESSION_OUTCOME);
  const second = await call("POST", "session-outcome", SESSION_OUTCOME);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstReport = first.recorded?.["report"] as { id?: string } | undefined;
  const secondReport = second.recorded?.["report"] as
    { id?: string } | undefined;
  assert.ok(firstReport?.id, "no report reached the service");
  assert.equal(secondReport?.id, firstReport.id);
  assert.match(String(firstReport.id), /^memory-session-outcome-/u);
});

test("a different session gets a different session-outcome identity", async () => {
  // The property the previous case cannot see. Asserting only that two reports
  // of the *same* session agree, and that the id has the right prefix, passes
  // just as well for an id that is constant — which would silently give every
  // session in every workspace the same outcome record. The id has to move when
  // the session does.
  const first = await call("POST", "session-outcome", SESSION_OUTCOME, {
    overrides: { taskId: "task-1" }
  });
  const second = await call("POST", "session-outcome", SESSION_OUTCOME, {
    overrides: { taskId: "task-2" }
  });

  const firstId = (first.recorded?.["report"] as { id?: string } | undefined)
    ?.id;
  const secondId = (second.recorded?.["report"] as { id?: string } | undefined)
    ?.id;
  assert.ok(firstId && secondId, "a report never reached the service");
  assert.notEqual(
    secondId,
    firstId,
    "two sessions were given the same outcome identity"
  );
});

test("the same session in a different repository gets a different identity", async () => {
  // The other half of what the id is derived from. A session id is only unique
  // within a repository, so an id built from the session alone would collide
  // across repositories in the same workspace.
  const first = await call("POST", "session-outcome", SESSION_OUTCOME, {
    overrides: { repositoryId: "owner/repo-1" }
  });
  const second = await call("POST", "session-outcome", SESSION_OUTCOME, {
    overrides: { repositoryId: "owner/repo-2" }
  });

  const firstId = (first.recorded?.["report"] as { id?: string } | undefined)
    ?.id;
  const secondId = (second.recorded?.["report"] as { id?: string } | undefined)
    ?.id;
  assert.ok(firstId && secondId, "a report never reached the service");
  assert.notEqual(secondId, firstId);
});

test("the same session id in another workspace gets another identity", async () => {
  // A session id is namespaced by workspace as well as repository, so the
  // workspace has to be part of what the id is derived from. Dropping it from
  // the hash is invisible to the two cases above and would let two workspaces
  // collide on one outcome record.
  const first = await call("POST", "session-outcome", SESSION_OUTCOME, {
    overrides: { workspaceId: "ws-1" }
  });
  const second = await call("POST", "session-outcome", SESSION_OUTCOME, {
    overrides: { workspaceId: "ws-2" }
  });

  const firstId = (first.recorded?.["report"] as { id?: string } | undefined)
    ?.id;
  const secondId = (second.recorded?.["report"] as { id?: string } | undefined)
    ?.id;
  assert.ok(firstId && secondId, "a report never reached the service");
  assert.notEqual(secondId, firstId);
});

test("a session outcome names the reporter who filed it", async () => {
  // The report is evidence that a particular reader said the session went this
  // way. A report attributed to nobody — or to a fixed identity — would make
  // the whole record unattributable, which is the one thing an audit trail
  // cannot be.
  const { recorded } = await call("POST", "session-outcome", SESSION_OUTCOME);
  const report = recorded?.["report"] as
    { reporterId?: string; reporterAuthority?: string } | undefined;

  assert.equal(report?.reporterId, "test-operator");
  assert.equal(report?.reporterAuthority, "root");
});

test("a session outcome carries no run scope the caller could widen", async () => {
  // Unlike the outcome report, this envelope has no scope, runId or agentId: it
  // is about one session, not a run of it. Asserting the absence is the point —
  // an added field would be a new way to claim something about a session.
  const { recorded } = await call("POST", "session-outcome", SESSION_OUTCOME);
  const report = recorded?.["report"] as Record<string, unknown> | undefined;

  for (const absent of ["scope", "runId", "agentId", "correlationToken"]) {
    assert.equal(
      report?.[absent],
      undefined,
      `a session outcome must not carry ${absent}`
    );
  }
});

test("a claimed session outcome needs evidence, and `unknown` stands alone", async () => {
  const claimed = await call("POST", "session-outcome", {
    ...SESSION_OUTCOME,
    evidence: []
  });
  const unknown = await call("POST", "session-outcome", {
    ...SESSION_OUTCOME,
    outcomeKind: "unknown",
    evidence: []
  });

  assert.equal(claimed.status, 400);
  assert.equal(unknown.status, 200);
  const report = unknown.recorded?.["report"] as
    { outcomeKind?: string; reasonCode?: string } | undefined;
  assert.equal(report?.outcomeKind, "unknown");
  assert.equal(report?.reasonCode, "reporter_unknown");
});

test("a session outcome refuses an unknown outcome or report kind", async () => {
  for (const body of [
    { ...SESSION_OUTCOME, outcomeKind: "spectacular" },
    { ...SESSION_OUTCOME, reportKind: "vibes" }
  ]) {
    const result = await call("POST", "session-outcome", body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(errorCode(result.body), "autodev_memory_invalid_request");
    assert.equal(result.recorded, undefined);
  }
});

test("reading a session outcome answers from the captured session", async () => {
  const { status, body } = await call("GET", "session-outcomes");

  assert.equal(status, 200);
  assert.equal(body?.["schema"], "autodev-memory-session-outcome-report-v1");
  assert.equal(body?.["experienceId"], EXPERIENCE_ID);
});

test("an unreported session outcome is an absence, not a failure", async () => {
  // `null` here is an observed answer about a session, not a broken read: the
  // session exists and nobody has reported how it went. Answering with a
  // different code would send an operator looking for a permission problem.
  const audits: AuditEntry[] = [];
  const response = responseRecorder();
  const pathname = `${EXPERIENCES}/${EXPERIENCE_ID}/session-outcomes`;
  const previous = process.env[TASK_HISTORY_ENV];
  process.env[TASK_HISTORY_ENV] = "1";
  try {
    await handleMemoryControlApiRequest(
      makeRequest("GET", `${pathname}?${WORKSPACE_SCOPE}`, undefined),
      response,
      pathname,
      { actor: "test-operator", role: "operator" },
      (entry) => audits.push(entry as AuditEntry),
      {
        createMemoryService: () =>
          ({
            getExperience: async () => experience(),
            getSessionOutcomeReport: async () => null
          }) as unknown as MemoryService
      }
    );
  } finally {
    if (previous === undefined) delete process.env[TASK_HISTORY_ENV];
    else process.env[TASK_HISTORY_ENV] = previous;
  }

  assert.equal(response.statusCode, 404);
  assert.equal(errorCode(responseBody(response)), "autodev_memory_not_found");
});

test("no refusal across the three paths is audited as a success", async () => {
  const results = [
    await call("POST", "use-assessments", { ...USE_ASSESSMENT, extra: true }),
    await call("POST", "use-assessments", {
      ...USE_ASSESSMENT,
      usedMemoryIds: ["mem-1", "mem-1"]
    }),
    await call("POST", "use-assessments", USE_ASSESSMENT, { visible: false }),
    await call("POST", "use-assessments", USE_ASSESSMENT, {
      query: WORKSPACE_SCOPE
    }),
    await call("POST", "session-outcome", { ...SESSION_OUTCOME, evidence: [] }),
    await call("POST", "session-outcome", {
      ...SESSION_OUTCOME,
      outcomeKind: "spectacular"
    }),
    await call("POST", "session-outcome", SESSION_OUTCOME, {
      overrides: { repositoryId: undefined }
    })
  ];

  for (const result of results) {
    assert.ok(result.audits.length > 0, "a refusal must be audited");
    assert.notEqual(
      result.audits.at(-1)?.outcome,
      "ok",
      `a refusal reported success: ${JSON.stringify(result.audits.at(-1))}`
    );
    assert.equal(
      result.recorded,
      undefined,
      `a refusal still reached the service: ${JSON.stringify(result.audits.at(-1))}`
    );
  }
});
