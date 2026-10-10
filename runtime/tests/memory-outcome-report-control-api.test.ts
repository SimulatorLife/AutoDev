import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExperienceEnvelope,
  MemoryOutcomeReport
} from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  responseBody,
  type RecordedResponse,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * `POST /control/memory/experiences/:id/outcomes` — the outcome-report write.
 *
 * This is where a session's work becomes something the memory system can learn
 * from, and it is the one leg of the learning loop with no unit test at all: its
 * only coverage was the PostgreSQL integration suite, which skips without a
 * live database. A developer with no repository never exercises the route that
 * matters most.
 *
 * The design claim worth pinning down is provenance. A report asserts that
 * something happened, and the rest of the system treats that assertion as
 * evidence. So: the caller supplies *what happened* and *what proves it*, and
 * the handler supplies *who it was about* — workspace, scope, task, run and
 * agent all come from the captured experience, never from the request. A caller
 * that could name its own session identity could report an outcome against a
 * session it never ran, and that fabricated report would then be attached to a
 * real session's history.
 */

const EXPERIENCE_ID = "exp-1";
const OUTCOMES = `/control/memory/experiences/${EXPERIENCE_ID}/outcomes`;
const SCOPE = "workspaceId=ws-1&includeTaskHistory=true";

interface AuditEntry {
  readonly action: string;
  readonly outcome: string;
  readonly changes: Record<string, unknown> | null;
  readonly reason?: string;
}

interface RecordInput {
  readonly report: MemoryOutcomeReport;
  readonly actor: { readonly id: string; readonly authority: string };
  readonly context: Record<string, unknown>;
}

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly audits: AuditEntry[];
  readonly report: MemoryOutcomeReport | undefined;
  readonly recorded: RecordInput | undefined;
}

function experience(overrides: Partial<ExperienceEnvelope> = {}) {
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

function errorCode(body: Record<string, unknown> | null): unknown {
  const envelope = body?.["error"];
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>)["code"]
    : undefined;
}

/** A service that records what it was handed, so provenance is visible. */
function recordingService(options: { readonly visible?: boolean } = {}) {
  const state: { recorded: RecordInput | undefined } = { recorded: undefined };
  const service = {
    getExperience: async () =>
      options.visible === false ? null : experience(),
    recordOutcomeReport: async (input: RecordInput) => {
      state.recorded = input;
      return { id: input.report.id, appended: true };
    }
  } as unknown as MemoryService;
  return { service, state };
}

async function report(
  body: Record<string, unknown>,
  options: {
    readonly role?: "viewer" | "operator";
    readonly query?: string;
    readonly grant?: boolean;
    readonly visible?: boolean;
  } = {}
): Promise<CallResult> {
  const { service, state } = recordingService({
    ...(options.visible === undefined ? {} : { visible: options.visible })
  });
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  const previousGrant = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  if (options.grant === false) {
    delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  } else {
    process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
  }
  const query = options.query ?? SCOPE;
  try {
    await handleMemoryControlApiRequest(
      makeRequest("POST", `${OUTCOMES}?${query}`, body),
      response,
      OUTCOMES,
      { actor: "test-operator", role: options.role ?? "operator" },
      (entry) => audits.push(entry as AuditEntry),
      { createMemoryService: () => service }
    );
  } finally {
    if (previousGrant === undefined) {
      delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
    } else {
      process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = previousGrant;
    }
  }
  return {
    status: response.statusCode,
    body: responseBody(response),
    audits,
    report: state.recorded?.report,
    recorded: state.recorded
  };
}

const EVIDENCE = [{ kind: "trajectory", uri: "codex://session/exp-1" }];

const CLAIMED = {
  correlationToken: "token-1",
  outcomeKind: "success",
  reportKind: "task",
  evidence: EVIDENCE
} as const;

test("a report's identity is derived from the captured experience, not the request", async () => {
  // The core provenance claim. Everything about *which session* this report
  // belongs to comes from the envelope the capture route already wrote under
  // the router's authority. If any of it could come from the body, a caller
  // could file a success against a session it never ran.
  const { status, report: filed } = await report(CLAIMED);

  assert.equal(status, 200);
  assert.ok(filed, "no report reached the service");
  assert.equal(filed?.workspaceId, "ws-1");
  assert.equal(filed?.repositoryId, "owner/repo-1");
  assert.deepEqual(filed?.scope, {
    kind: "task",
    workspaceId: "ws-1",
    taskId: "task-1"
  });
  assert.equal(filed?.taskId, "task-1");
  assert.equal(filed?.runId, "run-1");
  assert.equal(filed?.agentId, "agent-orch");
});

test("the write is authorized against the captured session, not the caller's window", async () => {
  // The report body is only half the provenance claim. The service decides
  // whether to accept the write from the *context* handed alongside it, so if
  // that context stayed as the caller's own — the `workspaceId` they asked for,
  // with global reads still available — the report would be authorized against
  // a window the capture route never granted.
  const { status, recorded } = await report(CLAIMED);

  assert.equal(status, 200);
  assert.equal(recorded?.context["workspaceId"], "ws-1");
  assert.equal(recorded?.context["repositoryId"], "owner/repo-1");
  assert.equal(recorded?.context["taskId"], "task-1");
  assert.equal(recorded?.context["runId"], "run-1");
  assert.equal(recorded?.context["agentId"], "agent-orch");
  assert.equal(
    recorded?.context["canReadGlobal"],
    false,
    "an outcome write must not carry global read authority"
  );
});

test("a caller cannot smuggle its own session identity through the body", async () => {
  // `exactKeys` is the enforcement. Without it these fields would simply be
  // ignored by the current handler — and the first time someone wires them up,
  // they would quietly start winning over the experience's own identity.
  const {
    status,
    body,
    report: filed
  } = await report({
    ...CLAIMED,
    taskId: "attacker-run",
    agentId: "attacker-agent",
    workspaceId: "ws-victim"
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
  assert.equal(filed, undefined, "a refused report still reached the service");
});

test("the session identity may not arrive in the query either", async () => {
  // The query is the same attack wearing a different hat: outcome identity is
  // derived from the captured experience, so naming it here is refused.
  //
  // The identity sent here is deliberately *well formed* — `taskId` and `runId`
  // together, which is what `readContext` requires of every other route. A
  // half-supplied identity would be refused by that generic pairing rule and
  // this case would pass without the outcomes-specific guard ever running.
  for (const identity of [
    "taskId=attacker-task&runId=attacker-run",
    "taskId=attacker-task&runId=attacker-run&agentId=attacker-agent"
  ]) {
    const {
      status,
      body,
      report: filed
    } = await report(CLAIMED, {
      query: `${SCOPE}&${identity}`
    });

    assert.equal(status, 400, `query identity accepted: ${identity}`);
    assert.equal(errorCode(body), "autodev_memory_invalid_filter");
    assert.equal(
      filed,
      undefined,
      `query identity reached the service: ${identity}`
    );
  }
});

test("an outcome other than unknown cannot be claimed without evidence", async () => {
  // The load-bearing rule of the whole system. "success" with nothing behind it
  // is indistinguishable from a guess, and a guess that enters history as
  // evidence will be believed later.
  const {
    status,
    body,
    report: filed
  } = await report({
    ...CLAIMED,
    evidence: []
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
  assert.equal(filed, undefined);
});

test("`unknown` is the one outcome that stands without evidence", async () => {
  // Not a loophole: not knowing is a legitimate, recordable result, and it is
  // carried as such rather than being forced into a guess. The reason code is
  // what tells a later reader the absence of evidence was declared, not found.
  const { status, report: filed } = await report({
    ...CLAIMED,
    outcomeKind: "unknown",
    evidence: []
  });

  assert.equal(status, 200);
  assert.equal(filed?.outcomeKind, "unknown");
  assert.deepEqual(filed?.evidence, []);
  assert.equal(filed?.reasonCode, "reporter_unknown");
});

test("a claimed outcome is marked as reporter-supplied", async () => {
  // The counterpart to `reporter_unknown`, so the history can distinguish
  // "nobody said" from "somebody said so".
  const { report: filed } = await report(CLAIMED);

  assert.equal(filed?.reasonCode, "reporter_supplied");
  assert.equal(filed?.reporterId, "test-operator");
  assert.equal(filed?.reporterAuthority, "root");
});

test("an unknown outcome kind is refused rather than stored verbatim", async () => {
  const {
    status,
    body,
    report: filed
  } = await report({
    ...CLAIMED,
    outcomeKind: "spectacular"
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
  assert.equal(filed, undefined);
});

test("an unknown report kind is refused", async () => {
  const { status, body } = await report({
    ...CLAIMED,
    reportKind: "vibes"
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("an evidence reference of an unknown kind is refused", async () => {
  const { status, body } = await report({
    ...CLAIMED,
    evidence: [{ kind: "hearsay", uri: "codex://session/exp-1" }]
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("a viewer is refused with the lifecycle refusal, not the report refusal", async () => {
  // Two different refusals, and the distinction is worth keeping: a viewer is
  // refused for being a viewer, before anything about the report is examined.
  const { status, body, audits } = await report(CLAIMED, { role: "viewer" });

  assert.equal(status, 403);
  assert.equal(errorCode(body), "autodev_memory_viewer_forbidden");
  assert.equal(audits.at(-1)?.reason, "viewer_cannot_mutate");
});

test("an operator without the task-history grant is refused", async () => {
  // Reporting an outcome is a statement about a specific session's history, so
  // it needs task-history authority. The refusal lands at the filter gate,
  // before the handler's own `requireTaskHistoryOperator` can run, so the code
  // is the scope one — the same order the session-outcome sibling relies on.
  const { status, body, audits } = await report(CLAIMED, { grant: false });

  assert.equal(status, 403);
  assert.equal(errorCode(body), "autodev_memory_scope_forbidden");
  assert.equal(audits.at(-1)?.reason, "scope_filter_forbidden");
  assert.equal(audits.at(-1)?.outcome, "denied");
});

test("a refused filter is audited rather than vanishing", async () => {
  // The filter gate runs before the service is constructed, so nothing else
  // records that the request happened. An operator asking why a caller keeps
  // being refused has only the audit trail to go on, so a refusal that leaves
  // no entry is indistinguishable from a request that was never made.
  const { status, audits } = await report(CLAIMED, {
    query: `${SCOPE}&taskId=attacker-task&runId=attacker-run`
  });

  assert.equal(status, 400);
  assert.equal(audits.length, 1);
  assert.equal(audits.at(-1)?.reason, "invalid_filter");
  assert.equal(audits.at(-1)?.outcome, "error");
  assert.equal(audits.at(-1)?.changes, null);
});

test("an experience the caller cannot see is reported as not found", async () => {
  // Not "forbidden": the caller is an operator, and telling them the record
  // exists but is invisible would leak the shape of what they cannot reach.
  const {
    status,
    body,
    report: filed
  } = await report(CLAIMED, {
    visible: false
  });

  assert.equal(status, 404);
  assert.equal(errorCode(body), "autodev_memory_not_found");
  assert.equal(filed, undefined);
});

test("the same correlation token names the same report", async () => {
  // Idempotency by construction: a retried capture of the same session event
  // lands on the same report id rather than appending a duplicate claim. The
  // identity is the experience plus the token, both of which the caller
  // cannot choose freely.
  const first = await report(CLAIMED);
  const second = await report(CLAIMED);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.ok(first.report?.id);
  assert.equal(second.report?.id, first.report?.id);

  const different = await report({ ...CLAIMED, correlationToken: "token-2" });
  assert.notEqual(different.report?.id, first.report?.id);
});

test("a stored report is audited with what changed", async () => {
  // The audit is how an operator later reconstructs why a session's history
  // says what it says, so it names the outcome and the report kind rather than
  // just "ok".
  const { audits } = await report(CLAIMED);

  assert.deepEqual(audits.at(-1)?.changes, {
    outcomeKind: "success",
    reportKind: "task",
    appended: true
  });
  assert.equal(audits.at(-1)?.outcome, "ok");
});

test("no refusal is audited as a success", async () => {
  // The guarantee that a refused report left nothing behind. `outcome: "ok"`
  // is emitted only after the service has accepted the report.
  const results = [
    await report({ ...CLAIMED, taskId: "attacker-run" }),
    await report({ ...CLAIMED, evidence: [] }),
    await report({ ...CLAIMED, outcomeKind: "spectacular" }),
    await report({ ...CLAIMED, reportKind: "vibes" }),
    await report(CLAIMED, { role: "viewer" }),
    await report(CLAIMED, { grant: false }),
    await report(CLAIMED, { visible: false })
  ];

  for (const result of results) {
    assert.ok(result.audits.length > 0, "a refusal must be audited");
    assert.notEqual(
      result.audits.at(-1)?.outcome,
      "ok",
      `a refusal reported success: ${JSON.stringify(result.audits.at(-1))}`
    );
    assert.equal(result.report, undefined, "a refusal still stored a report");
  }
});
