import assert from "node:assert/strict";
import test from "node:test";

import { MemoryHydrationError } from "../../src/memory/errors.ts";
import {
  hydrateExperienceRow,
  hydrateLifecycleEventRow,
  hydrateMemoryRecordRow
} from "../../src/memory/hydration.ts";
import {
  experienceToRow,
  lifecycleEventToRow,
  memoryRecordToRow
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
