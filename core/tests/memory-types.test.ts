import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMemoryInjectionOutcomeCohortFilter,
  assertMemorySessionOutcomeCohortFilter,
  type ExperienceEnvelope,
  isMemoryExperienceVisibleTo,
  isMemoryInjectionSessionCardinality,
  isMemoryScopeVisibleTo,
  isMemorySessionCohortAssignedMode,
  type MemoryReadContext,
  type MemoryScope,
  type MemorySessionOutcomeReport,
  parseMemoryExecutionMode,
  sessionOutcomeReportBodyMatches
} from "../src/memory/types.ts";

const context: MemoryReadContext = {
  workspaceId: "workspace-a",
  repositoryId: "repo-a",
  role: "worker",
  taskId: "task-a",
  runId: "run-a",
  agentId: "agent-a",
  canReadGlobal: false
};

test("memory execution modes distinguish safe defaults, gated ablations, and invalid config", () => {
  assert.equal(parseMemoryExecutionMode(undefined), "unknown");
  assert.equal(parseMemoryExecutionMode("jit"), "jit");
  assert.equal(parseMemoryExecutionMode("disabled"), "disabled");
  assert.equal(parseMemoryExecutionMode("retrieval-only"), "invalid");
  assert.equal(
    parseMemoryExecutionMode("retrieval-only", true),
    "retrieval-only"
  );
  assert.equal(parseMemoryExecutionMode("unrecognized"), "invalid");
});

test("memory outcome cohorts reject task-, run-, role-, and agent-selected context", () => {
  const cohort = {
    context: {
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      canReadGlobal: false
    },
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-10-01T00:00:00.000Z"
  };
  assert.doesNotThrow(() => assertMemoryInjectionOutcomeCohortFilter(cohort));

  for (const selector of ["role", "taskId", "runId", "agentId"] as const) {
    assert.throws(
      () =>
        assertMemoryInjectionOutcomeCohortFilter({
          ...cohort,
          context: {
            ...cohort.context,
            [selector]: "caller-selected"
          }
        }),
      /cannot select a role, task, run, or agent/u
    );
  }
});

test("memory scope visibility requires exact workspace, repository, and role matches", () => {
  assert.equal(
    isMemoryScopeVisibleTo(
      { kind: "workspace", workspaceId: "workspace-a" },
      context
    ),
    true
  );
  assert.equal(
    isMemoryScopeVisibleTo(
      {
        kind: "repository",
        workspaceId: "workspace-a",
        repositoryId: "repo-a"
      },
      context
    ),
    true
  );
  assert.equal(
    isMemoryScopeVisibleTo(
      {
        kind: "repository",
        workspaceId: "workspace-a",
        repositoryId: "repo-b"
      },
      context
    ),
    false
  );
  assert.equal(
    isMemoryScopeVisibleTo(
      { kind: "role", workspaceId: "workspace-a", role: "worker" },
      context
    ),
    true
  );
  assert.equal(
    isMemoryScopeVisibleTo(
      { kind: "role", workspaceId: "workspace-a", role: "validator" },
      context
    ),
    false
  );
});

test("task and agent working memories never cross run or agent boundaries", () => {
  const taskScope: MemoryScope = {
    kind: "task",
    workspaceId: "workspace-a",
    taskId: "task-a",
    runId: "run-a"
  };
  const agentScope: MemoryScope = {
    kind: "agent",
    workspaceId: "workspace-a",
    taskId: "task-a",
    runId: "run-a",
    agentId: "agent-a"
  };

  assert.equal(isMemoryScopeVisibleTo(taskScope, context), true);
  assert.equal(isMemoryScopeVisibleTo(agentScope, context), true);
  assert.equal(
    isMemoryScopeVisibleTo(taskScope, { ...context, runId: "run-b" }),
    false
  );
  assert.equal(
    isMemoryScopeVisibleTo(agentScope, { ...context, agentId: "agent-b" }),
    false
  );
});

test("global memory requires an explicit grant", () => {
  const globalScope: MemoryScope = { kind: "global" };
  assert.equal(isMemoryScopeVisibleTo(globalScope, context), false);
  assert.equal(
    isMemoryScopeVisibleTo(globalScope, { ...context, canReadGlobal: true }),
    true
  );
});

test("task history remains private unless a curator grants workspace-bounded experience reads", () => {
  const priorTaskExperience: ExperienceEnvelope = {
    id: "prior-experience",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    scope: {
      kind: "task",
      workspaceId: "workspace-a",
      taskId: "prior-task",
      runId: "prior-run"
    },
    taskId: "prior-task",
    runId: "prior-run",
    agentId: "prior-agent",
    startedAt: "2026-01-01T00:00:00.000Z",
    outcome: "success",
    trajectory: { format: "codex-v1", uri: "codex://session/prior" },
    evidence: []
  };
  assert.equal(
    isMemoryExperienceVisibleTo(priorTaskExperience, context),
    false
  );
  const curatorContext = { ...context, canReadTaskHistory: true };
  assert.equal(
    isMemoryExperienceVisibleTo(priorTaskExperience, curatorContext),
    true
  );
  assert.equal(
    isMemoryExperienceVisibleTo(priorTaskExperience, {
      ...curatorContext,
      repositoryId: "repo-b"
    }),
    false
  );
  assert.equal(
    isMemoryScopeVisibleTo(priorTaskExperience.scope, curatorContext),
    false,
    "experience history grants never widen durable memory record visibility"
  );
});

test("isMemoryInjectionSessionCardinality accepts only the bounded single/multiple cardinality values", () => {
  assert.equal(isMemoryInjectionSessionCardinality("single"), true);
  assert.equal(isMemoryInjectionSessionCardinality("multiple"), true);
  assert.equal(isMemoryInjectionSessionCardinality("none"), false);
  assert.equal(isMemoryInjectionSessionCardinality(1), false);
  assert.equal(isMemoryInjectionSessionCardinality(undefined), false);
});

test("isMemorySessionCohortAssignedMode accepts only assigned modes", () => {
  assert.equal(isMemorySessionCohortAssignedMode("jit"), true);
  assert.equal(isMemorySessionCohortAssignedMode("retrieval-only"), true);
  assert.equal(isMemorySessionCohortAssignedMode("disabled"), true);
  assert.equal(isMemorySessionCohortAssignedMode("invalid"), false);
  assert.equal(isMemorySessionCohortAssignedMode("unknown"), false);
  assert.equal(isMemorySessionCohortAssignedMode("mixed"), false);
  assert.equal(isMemorySessionCohortAssignedMode(""), false);
  assert.equal(isMemorySessionCohortAssignedMode(undefined), false);
});

test("assertMemorySessionOutcomeCohortFilter validates bounded session cohort filters", () => {
  const validFilter = {
    context: {
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      canReadGlobal: false,
      canReadTaskHistory: true
    },
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-10-01T00:00:00.000Z"
  };
  assert.doesNotThrow(() => assertMemorySessionOutcomeCohortFilter(validFilter));

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        context: { ...validFilter.context, workspaceId: "" }
      }),
    /requires a workspace id/u
  );

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        context: { ...validFilter.context, repositoryId: "" }
      }),
    /requires a repository id/u
  );

  for (const selector of ["role", "taskId", "runId", "agentId"] as const) {
    assert.throws(
      () =>
        assertMemorySessionOutcomeCohortFilter({
          ...validFilter,
          context: { ...validFilter.context, [selector]: "bad" }
        }),
      /cannot select a role, task, run, or agent/u
    );
  }

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        occurredFrom: "invalid"
      }),
    /not a valid timestamp/u
  );

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        occurredFrom: "2026-10-01T00:00:00.000Z",
        occurredUntil: "2026-09-01T00:00:00.000Z"
      }),
    /must be greater than or equal to 'from'/u
  );

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        occurredFrom: "2024-01-01T00:00:00.000Z",
        occurredUntil: "2026-01-01T00:00:00.000Z"
      }),
    /exceeds the 365-day maximum/u
  );

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        memoryModes: ["invalid" as never]
      }),
    /memoryMode is invalid/u
  );

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        memoryModes: ["unknown" as never]
      }),
    /memoryMode is invalid/u
  );

  assert.doesNotThrow(() =>
    assertMemorySessionOutcomeCohortFilter({
      ...validFilter,
      memoryModes: ["jit", "retrieval-only", "disabled"],
      injectionResults: ["injected", "empty", "skipped"],
      outcomeKinds: ["success", "failure"],
      reportKinds: ["task", "pull_request"]
    })
  );

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        injectionResults: ["bad" as never]
      }),
    /injectionResult is invalid/u
  );

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        outcomeKinds: ["bad" as never]
      }),
    /outcomeKind is invalid/u
  );

  assert.throws(
    () =>
      assertMemorySessionOutcomeCohortFilter({
        ...validFilter,
        reportKinds: ["bad" as never]
      }),
    /reportKind is invalid/u
  );
});

test("sessionOutcomeReportBodyMatches checks outcomeKind, reportKind, and evidence", () => {
  const base: MemorySessionOutcomeReport = {
    id: "rep-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    taskId: "t-1",
    outcomeKind: "success",
    reportKind: "task",
    reportedAt: "2026-09-01T00:00:00.000Z",
    reporterId: "curator-1",
    reporterAuthority: "curator",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "trajectory", uri: "codex://session/1" }]
  };

  assert.equal(sessionOutcomeReportBodyMatches(base, { ...base }), true);
  assert.equal(
    sessionOutcomeReportBodyMatches(base, { ...base, outcomeKind: "failure" }),
    false
  );
  assert.equal(
    sessionOutcomeReportBodyMatches(base, { ...base, reportKind: "issue" }),
    false
  );
  assert.equal(
    sessionOutcomeReportBodyMatches(base, { ...base, evidence: [] }),
    false
  );
  assert.equal(
    sessionOutcomeReportBodyMatches(base, {
      ...base,
      evidence: [{ kind: "trajectory", uri: "codex://session/2" }]
    }),
    false
  );
});
