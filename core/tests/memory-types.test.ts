import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMemoryInjectionOutcomeCohortFilter,
  type ExperienceEnvelope,
  isMemoryExperienceVisibleTo,
  isMemoryScopeVisibleTo,
  type MemoryReadContext,
  type MemoryScope,
  parseMemoryExecutionMode
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
