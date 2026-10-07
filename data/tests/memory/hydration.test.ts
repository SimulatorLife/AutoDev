import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryInjectionEvent,
  MemoryOutcomeReport,
  MemorySessionOutcomeReport,
  MemoryUseReport
} from "@simulatorlife/autodev-core";

import { MemoryHydrationError } from "../../src/memory/errors.ts";
import {
  hydrateExperienceRow,
  hydrateInjectionEventRow,
  hydrateInjectionUseReportRow,
  hydrateLifecycleEventRow,
  hydrateMemoryRecordRow,
  hydrateOutcomeReportRow,
  hydrateSessionOutcomeReportRow
} from "../../src/memory/hydration.ts";
import {
  experienceToRow,
  injectionEventToRow,
  injectionUseReportToRow,
  lifecycleEventToRow,
  memoryRecordToRow,
  outcomeReportToRow,
  sessionOutcomeReportToRow
} from "../../src/memory/serialize.ts";
import {
  makeExperience,
  makeLifecycleEvent,
  makeMemoryRecord
} from "./fixtures/builders.ts";

test("hydrateExperienceRow round-trips a serialized experience envelope", () => {
  const experience = makeExperience({
    repositoryId: "repo-1",
    taskKind: "bugfix",
    agentRole: "worker",
    validation: { state: "passed", evidence: [] },
    memoryMode: "retrieval-only"
  });
  const row = experienceToRow(experience);
  const hydrated = hydrateExperienceRow(row);
  assert.deepEqual(hydrated, experience);
});

test("native trajectory provenance round-trips without including transcript payloads", () => {
  const experience = makeExperience({
    trajectory: {
      format: "letta-trajectory-v1",
      uri: "codex://session/run-1",
      digest: "a".repeat(64),
      recordCount: 3,
      sourceAdapter: "codex",
      normalizerId: "@letta-ai/trajectory",
      normalizerVersion: "0.4.3",
      diagnosticCodes: ["injected_context_dropped", "timestamps_synthesized"]
    }
  });
  const row = experienceToRow(experience);

  assert.equal(row.trajectory_source_adapter, "codex");
  assert.equal(row.trajectory_normalizer_id, "@letta-ai/trajectory");
  assert.equal(row.trajectory_normalizer_version, "0.4.3");
  assert.equal(
    row.trajectory_diagnostic_codes,
    JSON.stringify(experience.trajectory.diagnosticCodes)
  );
  assert.deepEqual(hydrateExperienceRow(row), experience);
});

test("hydrateExperienceRow rejects incomplete or malformed trajectory provenance", () => {
  const row = experienceToRow(
    makeExperience({
      trajectory: {
        format: "letta-trajectory-v1",
        uri: "codex://session/run-1",
        sourceAdapter: "codex",
        normalizerId: "@letta-ai/trajectory",
        normalizerVersion: "0.4.3",
        diagnosticCodes: []
      }
    })
  );
  row.trajectory_normalizer_version = null;
  assert.throws(() => hydrateExperienceRow(row), MemoryHydrationError);

  row.trajectory_normalizer_version = "0.4.3";
  row.trajectory_diagnostic_codes = JSON.stringify([
    "timestamps_synthesized",
    1
  ]);
  assert.throws(() => hydrateExperienceRow(row), MemoryHydrationError);
});

test("trajectory serialization and hydration reject noncanonical diagnostic codes", () => {
  const experience = makeExperience({
    trajectory: {
      format: "letta-trajectory-v1",
      uri: "codex://session/run-1",
      sourceAdapter: "codex",
      normalizerId: "@letta-ai/trajectory",
      normalizerVersion: "0.4.3",
      diagnosticCodes: ["a"]
    }
  });
  for (const diagnosticCodes of [
    ["timestamps_synthesized", "injected_context_dropped"],
    ["injected_context_dropped", "injected_context_dropped"],
    [""],
    Array.from({ length: 65 }, (_, index) => `diagnostic_${index}`)
  ]) {
    assert.throws(
      () =>
        experienceToRow({
          ...experience,
          trajectory: { ...experience.trajectory, diagnosticCodes }
        }),
      TypeError
    );

    const row = experienceToRow(experience);
    row.trajectory_diagnostic_codes = JSON.stringify(diagnosticCodes);
    assert.throws(() => hydrateExperienceRow(row), MemoryHydrationError);
  }
});

test("hydrateExperienceRow rejects an unknown memory mode", () => {
  const row = experienceToRow(makeExperience());
  row.memory_mode = "unrecognized-mode";
  assert.throws(() => hydrateExperienceRow(row), MemoryHydrationError);
});

test("hydrateMemoryRecordRow round-trips a serialized memory record", () => {
  const record = makeMemoryRecord({
    status: "active",
    supersedes: ["mem-0"],
    validity: {
      state: "verified",
      validFrom: "2026-01-01T00:00:00.000Z",
      evidence: []
    }
  });
  const row = memoryRecordToRow(record);
  const hydrated = hydrateMemoryRecordRow(row);
  assert.deepEqual(hydrated, record);
});

test("hydrateLifecycleEventRow round-trips a serialized lifecycle event", () => {
  const event = makeLifecycleEvent({
    action: "superseded",
    fromStatus: "active",
    toStatus: "superseded"
  });
  const row = lifecycleEventToRow(event);
  const hydrated = hydrateLifecycleEventRow(row);
  assert.deepEqual(hydrated, event);
});

test("hydrateLifecycleEventRow reads canonical skill-promotion history", () => {
  const event = makeLifecycleEvent({
    action: "procedure_promoted",
    fromStatus: "active",
    toStatus: "invalidated",
    reasonCode: "promoted_to_skill",
    evidence: [
      {
        kind: "skill",
        uri: "rulesync://skills/verified-workflow/SKILL.md",
        revision: "a".repeat(64)
      }
    ]
  });
  assert.deepEqual(hydrateLifecycleEventRow(lifecycleEventToRow(event)), event);
});

test("hydrateMemoryRecordRow rejects an unknown status value instead of returning a garbage record", () => {
  const row = memoryRecordToRow(makeMemoryRecord());
  row.status = "not-a-real-status";
  assert.throws(() => hydrateMemoryRecordRow(row), MemoryHydrationError);
});

test("hydrateMemoryRecordRow rejects malformed provenance JSON", () => {
  const row = memoryRecordToRow(makeMemoryRecord());
  row.provenance = "{not valid json";
  assert.throws(() => hydrateMemoryRecordRow(row), MemoryHydrationError);
});

test("hydrateMemoryRecordRow rejects provenance missing required fields", () => {
  const row = memoryRecordToRow(makeMemoryRecord());
  row.provenance = JSON.stringify({
    evidence: [],
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  assert.throws(() => hydrateMemoryRecordRow(row), MemoryHydrationError);
});

test("hydrateMemoryRecordRow rejects an invalid scope_kind", () => {
  const row = memoryRecordToRow(makeMemoryRecord());
  row.scope_kind = "galaxy";
  assert.throws(() => hydrateMemoryRecordRow(row), MemoryHydrationError);
});

test("hydrateExperienceRow rejects a non-ISO timestamp", () => {
  const row = experienceToRow(makeExperience());
  row.started_at = "not-a-timestamp";
  assert.throws(() => hydrateExperienceRow(row), MemoryHydrationError);
});

test("hydrateExperienceRow rejects an evidence entry with an invalid kind", () => {
  const row = experienceToRow(makeExperience());
  row.evidence = JSON.stringify([{ kind: "not-a-real-kind", uri: "x://1" }]);
  assert.throws(() => hydrateExperienceRow(row), MemoryHydrationError);
});

// The four evaluation rows carry the correlation token, the reason code, and the
// scope that every cohort read is grouped by, and all four had no direct test:
// three of the seven serializers were exercised only through a live Postgres
// integration run, and none of the four hydrators ran at all outside one. A
// round trip is the narrowest proof that the pair agrees on every column name,
// including the optional ones that disappear on the way to `null`.

test("hydrateInjectionEventRow round-trips a serialized injection event", () => {
  const event: MemoryInjectionEvent = {
    id: "inj-1",
    workspaceId: "ws-1",
    repositoryId: "owner/repo",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    agentRole: "orchestrator",
    correlationToken: "corr-1",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 1234,
    packetTokenCount: 321,
    memoryIds: ["mem-1", "mem-2"],
    occurredAt: "2026-10-01T00:00:00.000Z",
    reasonCode: "packet_attached",
    evidence: [{ kind: "trajectory", uri: "trace://ci/1" }],
    recordedBy: "router"
  };
  assert.deepEqual(hydrateInjectionEventRow(injectionEventToRow(event)), event);
});

test("an injection event without its optional columns round-trips unchanged", () => {
  // `agentRole`, `packetTokenCount` and `repositoryId` are all nullable, and a
  // hydrator that reconstructs them as empty strings or `[null]` would look
  // right in a row count and wrong to every reader downstream.
  const event: MemoryInjectionEvent = {
    id: "inj-2",
    workspaceId: "ws-1",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    correlationToken: "corr-2",
    memoryMode: "disabled",
    injectionResult: "skipped",
    packetCharacterCount: 0,
    memoryIds: [],
    occurredAt: "2026-10-01T00:00:00.000Z",
    reasonCode: "memory_mode_disabled",
    evidence: [],
    recordedBy: "router"
  };
  const row = injectionEventToRow(event);
  assert.equal(row.agent_role, null);
  assert.equal(row.packet_token_count, null);
  assert.equal(row.repository_id, null);
  assert.deepEqual(hydrateInjectionEventRow(row), event);
});

test("hydrateOutcomeReportRow round-trips a serialized outcome report", () => {
  const report: MemoryOutcomeReport = {
    id: "out-1",
    workspaceId: "ws-1",
    repositoryId: "owner/repo",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    correlationToken: "corr-1",
    outcomeKind: "success",
    reportKind: "task",
    reportedAt: "2026-10-01T00:00:00.000Z",
    reporterId: "operator-1",
    reporterAuthority: "root",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "pull_request", uri: "pr://7" }]
  };
  assert.deepEqual(hydrateOutcomeReportRow(outcomeReportToRow(report)), report);
});

test("hydrateInjectionUseReportRow round-trips a serialized use report", () => {
  const report: MemoryUseReport = {
    id: "use-1",
    workspaceId: "ws-1",
    repositoryId: "owner/repo",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    agentRole: "orchestrator",
    injectionEventId: "inj-1",
    correlationToken: "corr-1",
    useKind: "partially_used",
    usedMemoryIds: ["mem-1"],
    reportedAt: "2026-10-01T00:00:00.000Z",
    reporterId: "curator-1",
    reporterAuthority: "curator",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "trajectory", uri: "trace://ci/1" }]
  };
  assert.deepEqual(
    hydrateInjectionUseReportRow(injectionUseReportToRow(report)),
    report
  );
});

test("hydrateSessionOutcomeReportRow round-trips a serialized session report", () => {
  const report: MemorySessionOutcomeReport = {
    id: "sess-1",
    workspaceId: "ws-1",
    repositoryId: "owner/repo",
    taskId: "task-1",
    outcomeKind: "unknown",
    reportKind: "other",
    reportedAt: "2026-10-01T00:00:00.000Z",
    reporterId: "operator-1",
    reporterAuthority: "root",
    reasonCode: "reporter_unknown",
    evidence: []
  };
  assert.deepEqual(
    hydrateSessionOutcomeReportRow(sessionOutcomeReportToRow(report)),
    report
  );
});

test("the evaluation hydrators refuse a row whose reason code is not its own vocabulary", () => {
  // The reason code is what makes an unexposed cell explicit, so a row that
  // cannot name one has not been observed in a way the cohorts can report.
  assert.throws(
    () =>
      hydrateInjectionEventRow({
        ...injectionEventToRow({
          id: "inj-3",
          workspaceId: "ws-1",
          scope: { kind: "workspace", workspaceId: "ws-1" },
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          correlationToken: "corr-3",
          memoryMode: "jit",
          injectionResult: "injected",
          packetCharacterCount: 1,
          memoryIds: [],
          occurredAt: "2026-10-01T00:00:00.000Z",
          reasonCode: "packet_attached",
          evidence: [],
          recordedBy: "router"
        }),
        reason_code: "reporter_supplied"
      }),
    MemoryHydrationError
  );
});

/**
 * The row-hydration primitives, rather than the policies layered over them.
 *
 * `hydration.ts` is seven public hydrators over five shared primitives --
 * `requireString`, `optionalString`, `requireJson`, `parseIdArray` and
 * `requireNonNegativeInteger` -- and every one of those five had a refusal
 * branch no test could reach. Each hydrator test here builds a row with the
 * real serializer, so every column is well-formed by construction; the ones
 * above corrupt a *policy* field (an unknown status, a bad scope kind, an
 * unrecognised evidence kind) while the primitive that reads an ordinary
 * column had never been handed anything but a good one.
 *
 * That is the gap this closes: a version of `requireString` that returned the
 * value unchecked, or of `requireNonNegativeInteger` that dropped its screen,
 * would have passed every case in this file.
 */

test("a required column that is missing or empty is refused", () => {
  const row = experienceToRow(makeExperience());
  for (const [label, column] of [
    ["an empty id", "id"],
    ["an empty workspace id", "workspace_id"],
    ["an empty task id", "task_id"],
    ["an empty run id", "run_id"],
    ["an empty agent id", "agent_id"]
  ] as const) {
    assert.throws(
      () => hydrateExperienceRow({ ...row, [column]: "" }),
      MemoryHydrationError,
      `${label} must be refused rather than hydrated as an empty string`
    );
    assert.throws(
      () => hydrateExperienceRow({ ...row, [column]: undefined }),
      MemoryHydrationError,
      `${label} must be refused when absent`
    );
  }
});

test("a nullable string column holding a non-string is refused, not coerced", () => {
  const row = experienceToRow(makeExperience({ repositoryId: "repo-1" }));
  // These columns are nullable, which is exactly why the guard exists: without
  // it a NULL-or-typed value would pass straight through as a number or an
  // object into an enumerated field the rest of the system treats as a string.
  for (const column of [
    "repository_id",
    "task_kind",
    "agent_role",
    "provider",
    "model",
    "branch"
  ] as const) {
    assert.throws(
      () => hydrateExperienceRow({ ...row, [column]: 42 }),
      MemoryHydrationError,
      `${column} must be refused when it holds a number`
    );
    assert.doesNotThrow(
      () => hydrateExperienceRow({ ...row, [column]: null }),
      `${column} must still accept null, which is what the column is for`
    );
  }
});

test("an id column that is not a JSON array of strings is refused", () => {
  const row = memoryRecordToRow(makeMemoryRecord());
  for (const [label, value] of [
    ["a non-array", '"experience-a"'],
    ["an array holding a number", '["experience-a", 7]'],
    ["an array holding null", '["experience-a", null]'],
    ["malformed JSON", "[unclosed"]
  ] as const) {
    for (const column of ["supersedes", "superseded_by"] as const) {
      assert.throws(
        () => hydrateMemoryRecordRow({ ...row, [column]: value }),
        MemoryHydrationError,
        `${label} in ${column} must be refused`
      );
    }
  }
  // The positive control: an absent column is an empty list, and the record
  // then omits the key rather than carrying `[]` -- an optional field that is
  // present and empty is a different thing from one that is absent.
  assert.equal(
    hydrateMemoryRecordRow({ ...row, supersedes: null }).supersedes,
    undefined,
    "an absent supersedes list must leave the key off the record"
  );
  assert.equal(
    hydrateMemoryRecordRow({ ...row, supersedes: "[]" }).supersedes,
    undefined,
    "an empty supersedes list must leave the key off the record"
  );
  assert.deepEqual(
    hydrateMemoryRecordRow({ ...row, supersedes: '["experience-a"]' })
      .supersedes,
    ["experience-a"]
  );
});

test("a packet count is refused unless it is a non-negative integer", () => {
  const event: MemoryInjectionEvent = {
    id: "inj-1",
    workspaceId: "ws-1",
    repositoryId: "owner/repo",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    agentRole: "orchestrator",
    correlationToken: "corr-1",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 12,
    packetTokenCount: 3,
    memoryIds: ["mem-1"],
    occurredAt: "2026-10-01T00:00:00.000Z",
    reasonCode: "packet_attached",
    evidence: [],
    recordedBy: "router"
  };
  const row = injectionEventToRow(event);
  for (const [label, value] of [
    ["a negative count", -1],
    ["a fractional count", 1.5],
    ["a non-numeric string", "seven"],
    ["an exponent string", "1e3"],
    ["a null", null],
    ["a boolean", true]
  ] as const) {
    assert.throws(
      () => hydrateInjectionEventRow({ ...row, packet_character_count: value }),
      MemoryHydrationError,
      `${label} must be refused`
    );
  }

  // The driver hands `int` columns back as numbers, and `0` is a real count of
  // an empty packet rather than a missing one, so both must survive.
  assert.equal(
    hydrateInjectionEventRow({ ...row, packet_character_count: 0 })
      .packetCharacterCount,
    0
  );
  // The string branch exists for a driver that reports counts as text; it has
  // to accept the integer form and refuse the rest, or it is dead code that
  // looks like validation.
  assert.equal(
    hydrateInjectionEventRow({ ...row, packet_character_count: "42" })
      .packetCharacterCount,
    42
  );
});

test("a provenance column that is null is refused rather than read as empty", () => {
  const row = memoryRecordToRow(makeMemoryRecord());
  assert.throws(
    () => hydrateMemoryRecordRow({ ...row, provenance: null }),
    MemoryHydrationError,
    "a null provenance must be refused, not treated as an empty object"
  );
  assert.throws(
    () => hydrateMemoryRecordRow({ ...row, provenance: undefined }),
    MemoryHydrationError
  );
});
