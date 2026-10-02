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
