import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMemoryInjectionOutcomeCohortFilter,
  assertMemoryInjectionUseCohortFilter,
  assertMemorySessionOutcomeCohortFilter,
  assertMemoryUseReportInvariants,
  assertTrajectoryProvenance,
  type ExperienceEnvelope,
  isMemoryExperienceVisibleTo,
  isMemoryInjectionSessionCardinality,
  isMemoryScopeVisibleTo,
  isMemorySessionCohortAssignedMode,
  isMemoryUseKind,
  MAX_TRAJECTORY_DIAGNOSTIC_CODES,
  type MemoryInjectionEvent,
  type MemoryOutcomeReport,
  type MemoryReadContext,
  type MemoryScope,
  type MemorySessionOutcomeReport,
  type MemoryUseReport,
  outcomeReportBodyMatches,
  parseMemoryExecutionMode,
  sessionOutcomeReportBodyMatches,
  useReportBodyMatches
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

test("native trajectory provenance is complete, bounded, stable, and code-only", () => {
  const trajectory: ExperienceEnvelope["trajectory"] = {
    format: "letta-trajectory-v1",
    uri: "codex://session/run-a",
    sourceAdapter: "codex",
    normalizerId: "@letta-ai/trajectory",
    normalizerVersion: "0.4.3",
    diagnosticCodes: ["injected_context_dropped", "timestamps_synthesized"]
  };
  assert.doesNotThrow(() => assertTrajectoryProvenance(trajectory));
  assert.doesNotThrow(() =>
    assertTrajectoryProvenance({ format: "legacy-v1", uri: "old://run" })
  );

  assert.throws(
    () =>
      assertTrajectoryProvenance({
        format: trajectory.format,
        uri: trajectory.uri,
        sourceAdapter: "codex"
      }),
    /populated together/u
  );
  assert.throws(
    () =>
      assertTrajectoryProvenance({
        ...trajectory,
        diagnosticCodes: ["timestamps_synthesized", "injected_context_dropped"]
      }),
    /distinct and lexicographically sorted/u
  );
  assert.throws(
    () =>
      assertTrajectoryProvenance({
        ...trajectory,
        diagnosticCodes: [
          "injected_context_dropped",
          "injected_context_dropped"
        ]
      }),
    /distinct and lexicographically sorted/u
  );
  assert.throws(
    () =>
      assertTrajectoryProvenance({
        ...trajectory,
        diagnosticCodes: [""]
      }),
    /must not be empty/u
  );
  assert.throws(
    () =>
      assertTrajectoryProvenance({
        ...trajectory,
        diagnosticCodes: Array.from(
          { length: MAX_TRAJECTORY_DIAGNOSTIC_CODES + 1 },
          (_, index) => `diagnostic_${String(index).padStart(2, "0")}`
        )
      }),
    /maximum/u
  );
});

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
  assert.doesNotThrow(() =>
    assertMemorySessionOutcomeCohortFilter(validFilter)
  );

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

function outcomeReport(
  overrides: Partial<MemoryOutcomeReport> = {}
): MemoryOutcomeReport {
  return {
    id: "out-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1"
    },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    correlationToken: "token-1",
    outcomeKind: "success",
    reportKind: "task",
    reportedAt: "2026-09-01T00:00:00.000Z",
    reporterId: "curator-1",
    reporterAuthority: "curator",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "trajectory", uri: "codex://session/1" }],
    ...overrides
  };
}

test("outcomeReportBodyMatches treats evidence as a set, not a serialised structure", () => {
  const base = outcomeReport({
    evidence: [
      { kind: "trajectory", uri: "codex://session/1" },
      { kind: "file", uri: "file://repo/a.ts" }
    ]
  });

  assert.equal(outcomeReportBodyMatches(base, { ...base }), true);

  // The same references submitted in a different array order are the same
  // body. A `JSON.stringify` comparison called this a conflict.
  assert.equal(
    outcomeReportBodyMatches(base, {
      ...base,
      evidence: [
        { kind: "file", uri: "file://repo/a.ts" },
        { kind: "trajectory", uri: "codex://session/1" }
      ]
    }),
    true
  );

  // So are the same references whose own keys were serialised in a different
  // insertion order, which happens whenever the reporter's JSON parser or
  // database round-trip rebuilds the object.
  assert.equal(
    outcomeReportBodyMatches(base, {
      ...base,
      evidence: [
        { uri: "codex://session/1", kind: "trajectory" },
        { uri: "file://repo/a.ts", kind: "file" }
      ]
    }),
    true
  );

  // `revision` participates in the identity, so dropping it is a real change.
  assert.equal(
    outcomeReportBodyMatches(
      outcomeReport({
        evidence: [{ kind: "file", uri: "file://repo/a.ts", revision: "abc" }]
      }),
      outcomeReport({
        evidence: [{ kind: "file", uri: "file://repo/a.ts", revision: "def" }]
      })
    ),
    false
  );
});

test("outcomeReportBodyMatches still separates idempotent retries from real conflicts", () => {
  const base = outcomeReport();

  assert.equal(
    outcomeReportBodyMatches(base, { ...base, outcomeKind: "failure" }),
    false
  );
  assert.equal(
    outcomeReportBodyMatches(base, { ...base, reportKind: "issue" }),
    false
  );
  assert.equal(
    outcomeReportBodyMatches(base, {
      ...base,
      evidence: [{ kind: "trajectory", uri: "codex://session/2" }]
    }),
    false
  );

  // A different reference count is a conflict even when the shared prefix
  // matches, so the length check cannot be skipped.
  assert.equal(
    outcomeReportBodyMatches(base, {
      ...base,
      evidence: [
        { kind: "trajectory", uri: "codex://session/1" },
        { kind: "file", uri: "file://repo/a.ts" }
      ]
    }),
    false
  );

  // Two empty evidence sets match; `outcomeKind: "unknown"` is the only kind
  // allowed to carry none.
  assert.equal(
    outcomeReportBodyMatches(
      outcomeReport({ outcomeKind: "unknown", evidence: [] }),
      outcomeReport({ outcomeKind: "unknown", evidence: [] })
    ),
    true
  );

  // Identity and timing fields are deliberately not part of the body.
  assert.equal(
    outcomeReportBodyMatches(
      base,
      outcomeReport({
        id: "out-2",
        reportedAt: "2026-10-06T00:00:00.000Z",
        reporterId: "root-1",
        reporterAuthority: "root",
        evidence: base.evidence
      })
    ),
    true
  );
});

test("isMemoryUseKind accepts only the bounded used/partially_used/not_used/unobservable values", () => {
  assert.equal(isMemoryUseKind("used"), true);
  assert.equal(isMemoryUseKind("partially_used"), true);
  assert.equal(isMemoryUseKind("not_used"), true);
  assert.equal(isMemoryUseKind("unobservable"), true);
  assert.equal(isMemoryUseKind("unassessed"), false);
  assert.equal(isMemoryUseKind(undefined), false);
});

function injectedEvent(
  overrides: Partial<
    Pick<MemoryInjectionEvent, "injectionResult" | "memoryMode" | "memoryIds">
  > = {}
): Pick<MemoryInjectionEvent, "injectionResult" | "memoryMode" | "memoryIds"> {
  return {
    injectionResult: "injected",
    memoryMode: "jit",
    memoryIds: ["mem-1", "mem-2"],
    ...overrides
  };
}

const trajectoryEvidence = [
  { kind: "trajectory" as const, uri: "codex://session/1" }
];

function useAssessment(
  useKind: "used" | "partially_used" | "not_used" | "unobservable",
  usedMemoryIds: readonly string[],
  evidence: MemoryUseReport["evidence"]
) {
  return {
    repositoryId: "repo-a",
    useKind,
    usedMemoryIds,
    evidence,
    reasonCode:
      useKind === "unobservable"
        ? ("reporter_unobservable" as const)
        : ("reporter_supplied" as const)
  };
}

test("assertMemoryUseReportInvariants rejects any use report targeting a non-injected or empty-packet event", () => {
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment("not_used", [], trajectoryEvidence),
        { injectionResult: "empty", memoryMode: "jit", memoryIds: [] }
      ),
    /eligible injected event/u
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment("not_used", [], trajectoryEvidence),
        { injectionResult: "injected", memoryMode: "jit", memoryIds: [] }
      ),
    /eligible injected event/u
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment("not_used", [], trajectoryEvidence),
        { injectionResult: "skipped", memoryMode: "jit", memoryIds: ["mem-1"] }
      ),
    /eligible injected event/u
  );
  for (const memoryMode of ["disabled", "invalid", "unknown"] as const) {
    assert.throws(
      () =>
        assertMemoryUseReportInvariants(
          useAssessment("not_used", [], trajectoryEvidence),
          injectedEvent({ memoryMode })
        ),
      /eligible injected event/u
    );
  }
});

test("assertMemoryUseReportInvariants requires 'used' to cite every injected memory id", () => {
  assert.doesNotThrow(() =>
    assertMemoryUseReportInvariants(
      useAssessment("used", ["mem-1", "mem-2"], trajectoryEvidence),
      injectedEvent()
    )
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment("used", ["mem-1"], trajectoryEvidence),
        injectedEvent()
      ),
    /'used' reports must cite every injected memory id/u
  );
});

test("assertMemoryUseReportInvariants requires 'partially_used' to be a non-empty strict subset", () => {
  assert.doesNotThrow(() =>
    assertMemoryUseReportInvariants(
      useAssessment("partially_used", ["mem-1"], trajectoryEvidence),
      injectedEvent()
    )
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment("partially_used", [], trajectoryEvidence),
        injectedEvent()
      ),
    /non-empty strict subset/u
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment("partially_used", ["mem-1", "mem-2"], trajectoryEvidence),
        injectedEvent()
      ),
    /non-empty strict subset/u
  );
});

test("assertMemoryUseReportInvariants requires 'not_used' and 'unobservable' to carry no memory ids", () => {
  for (const useKind of ["not_used", "unobservable"] as const) {
    assert.doesNotThrow(() =>
      assertMemoryUseReportInvariants(
        useAssessment(
          useKind,
          [],
          useKind === "unobservable" ? [] : trajectoryEvidence
        ),
        injectedEvent()
      )
    );
    assert.throws(
      () =>
        assertMemoryUseReportInvariants(
          useAssessment(useKind, ["mem-1"], trajectoryEvidence),
          injectedEvent()
        ),
      /must not cite any memory id/u
    );
  }
});

test("assertMemoryUseReportInvariants rejects usedMemoryIds outside the injected packet and duplicate ids", () => {
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment(
          "partially_used",
          ["mem-not-in-packet"],
          trajectoryEvidence
        ),
        injectedEvent()
      ),
    /subset of the injected memoryIds/u
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment("used", ["mem-1", "mem-1"], trajectoryEvidence),
        injectedEvent({ memoryIds: ["mem-1"] })
      ),
    /must not contain duplicates/u
  );
});

test("assertMemoryUseReportInvariants requires a trajectory evidence reference for every kind except unobservable", () => {
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment("not_used", [], []),
        injectedEvent()
      ),
    /require a trajectory evidence reference/u
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment(
          "used",
          ["mem-1", "mem-2"],
          [{ kind: "file", uri: "file://a.ts" }]
        ),
        injectedEvent()
      ),
    /require a trajectory evidence reference/u
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        useAssessment(
          "used",
          ["mem-1", "mem-2"],
          [{ kind: "trajectory", uri: "  " }]
        ),
        injectedEvent()
      ),
    /require a trajectory evidence reference/u
  );
  assert.doesNotThrow(() =>
    assertMemoryUseReportInvariants(
      useAssessment("unobservable", [], []),
      injectedEvent()
    )
  );
});

test("assertMemoryUseReportInvariants rejects an invalid useKind", () => {
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        {
          ...useAssessment("used", [], trajectoryEvidence),
          useKind: "maybe_used" as never
        },
        injectedEvent()
      ),
    /useKind is invalid/u
  );
});

test("assertMemoryUseReportInvariants requires a repository and a valid persisted reason", () => {
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        {
          ...useAssessment("used", ["mem-1", "mem-2"], trajectoryEvidence),
          repositoryId: " "
        },
        injectedEvent()
      ),
    /require a repository id/u
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        {
          ...useAssessment("used", ["mem-1", "mem-2"], trajectoryEvidence),
          reasonCode: "scope_mismatch" as never
        },
        injectedEvent()
      ),
    /reasonCode is invalid/u
  );
  assert.throws(
    () =>
      assertMemoryUseReportInvariants(
        {
          ...useAssessment("unobservable", [], []),
          reasonCode: "reporter_supplied"
        },
        injectedEvent()
      ),
    /reasonCode does not match useKind/u
  );
});

function useReport(overrides: Partial<MemoryUseReport> = {}): MemoryUseReport {
  return {
    id: "use-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1"
    },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    injectionEventId: "inj-1",
    correlationToken: "token-1",
    useKind: "used",
    usedMemoryIds: ["mem-1", "mem-2"],
    reportedAt: "2026-10-01T00:00:00.000Z",
    reporterId: "curator-1",
    reporterAuthority: "curator",
    reasonCode: "reporter_supplied",
    evidence: trajectoryEvidence,
    ...overrides
  };
}

test("useReportBodyMatches checks useKind, usedMemoryIds, and evidence ignoring order", () => {
  const base = useReport();
  assert.equal(useReportBodyMatches(base, { ...base }), true);
  assert.equal(
    useReportBodyMatches(base, {
      ...base,
      usedMemoryIds: ["mem-2", "mem-1"]
    }),
    true,
    "order of usedMemoryIds must not affect idempotency comparison"
  );
  assert.equal(
    useReportBodyMatches(base, { ...base, useKind: "partially_used" }),
    false
  );
  assert.equal(
    useReportBodyMatches(base, { ...base, usedMemoryIds: ["mem-1"] }),
    false
  );
  assert.equal(useReportBodyMatches(base, { ...base, evidence: [] }), false);
  assert.equal(
    useReportBodyMatches(base, {
      ...base,
      evidence: [{ kind: "trajectory", uri: "codex://session/2" }]
    }),
    false
  );
});

test("assertMemoryInjectionUseCohortFilter validates bounded use cohort filters", () => {
  const validFilter = {
    context: {
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      canReadGlobal: false
    },
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-10-01T00:00:00.000Z"
  };
  assert.doesNotThrow(() => assertMemoryInjectionUseCohortFilter(validFilter));

  assert.throws(
    () =>
      assertMemoryInjectionUseCohortFilter({
        ...validFilter,
        context: { ...validFilter.context, workspaceId: "" }
      }),
    /requires a workspace id/u
  );

  assert.throws(
    () =>
      assertMemoryInjectionUseCohortFilter({
        ...validFilter,
        context: { ...validFilter.context, repositoryId: "" }
      }),
    /requires a repository id/u
  );

  for (const selector of ["role", "taskId", "runId", "agentId"] as const) {
    assert.throws(
      () =>
        assertMemoryInjectionUseCohortFilter({
          ...validFilter,
          context: { ...validFilter.context, [selector]: "caller-selected" }
        }),
      /cannot select a role, task, run, or agent/u
    );
  }

  assert.throws(
    () =>
      assertMemoryInjectionUseCohortFilter({
        ...validFilter,
        occurredFrom: "not-a-date"
      }),
    /not a valid timestamp/u
  );

  assert.throws(
    () =>
      assertMemoryInjectionUseCohortFilter({
        ...validFilter,
        occurredFrom: "2026-10-01T00:00:00.000Z",
        occurredUntil: "2026-09-01T00:00:00.000Z"
      }),
    /must be greater than or equal to 'from'/u
  );

  assert.throws(
    () =>
      assertMemoryInjectionUseCohortFilter({
        ...validFilter,
        occurredFrom: "2024-01-01T00:00:00.000Z",
        occurredUntil: "2026-01-01T00:00:00.000Z"
      }),
    /exceeds the 365-day maximum/u
  );

  assert.throws(
    () =>
      assertMemoryInjectionUseCohortFilter({
        ...validFilter,
        memoryModes: ["invalid" as never]
      }),
    /memoryMode is invalid/u
  );

  assert.throws(
    () =>
      assertMemoryInjectionUseCohortFilter({
        ...validFilter,
        useKinds: ["bad" as never]
      }),
    /useKind is invalid/u
  );

  assert.doesNotThrow(() =>
    assertMemoryInjectionUseCohortFilter({
      ...validFilter,
      memoryModes: ["jit", "retrieval-only", "disabled"],
      useKinds: ["used", "partially_used", "not_used", "unobservable"]
    })
  );
});
