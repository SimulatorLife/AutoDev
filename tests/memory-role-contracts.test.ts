import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type {
  MemoryAssessmentCohortReader,
  MemoryAssessmentReader,
  MemoryAssessmentRecorder,
  MemoryExperienceLister,
  MemoryExperiencePurger
} from "@simulatorlife/autodev-runtime/memory";

const repositoryRoot = path.join(import.meta.dirname, "..");

const emptyPage = { items: [], total: 0, limit: 0, offset: 0 };
const cohortWindow = {
  workspaceId: "ws",
  repositoryId: "repo",
  occurredFrom: "2026-01-01T00:00:00.000Z",
  occurredUntil: "2026-01-02T00:00:00.000Z",
  cells: []
};

test("each Memory role is satisfiable on its own", () => {
  // The point of the split. A consumer that only aggregates cohorts should be
  // able to say exactly that, instead of depending on all 53 members of
  // MemoryService. These literals are the assertion: each names every member
  // its role requires, and they only typecheck if the interfaces really are
  // this narrow.
  const cohortReader: MemoryAssessmentCohortReader = {
    aggregateInjectionOutcomeCohorts: async () => ({
      ...cohortWindow,
      schema: "autodev-memory-injection-outcome-cohorts-v1",
      exposureCount: 0,
      reportCount: 0
    }),
    aggregateSessionOutcomeCohorts: async () => ({
      ...cohortWindow,
      schema: "autodev-memory-session-outcome-cohorts-v1",
      sessionCount: 0,
      reportedSessionCount: 0,
      unreportedSessionCount: 0,
      conflictingOutcomeSessionCount: 0,
      mixedModeSessionCount: 0
    }),
    aggregateInjectionUseCohorts: async () => ({
      ...cohortWindow,
      schema: "autodev-memory-injection-use-cohorts-v1",
      exposureCount: 0
    })
  };
  const assessmentReader: MemoryAssessmentReader = {
    getExperience: async () => null,
    listInjectionOutcomeJoins: async () => emptyPage,
    listInjectionUseJoins: async () => emptyPage,
    getSessionOutcomeReport: async () => null
  };
  const recorder: MemoryAssessmentRecorder = {
    getExperience: async () => null,
    recordOutcomeReport: async () => ({ appended: true, id: "r1" }),
    recordInjectionUseReport: async () => ({ appended: true, id: "r2" }),
    recordSessionOutcomeReport: async () => ({ appended: true, id: "r3" })
  };
  const lister: MemoryExperienceLister = {
    getExperience: async () => null,
    listExperiences: async () => emptyPage
  };
  const purger: MemoryExperiencePurger = {
    purgeExperience: async () => "purged"
  };

  const roles = { cohortReader, assessmentReader, recorder, lister, purger };
  const expected = {
    cohortReader: 3,
    assessmentReader: 4,
    recorder: 4,
    lister: 2,
    purger: 1
  };
  for (const [name, role] of Object.entries(roles)) {
    assert.equal(
      Object.keys(role).length,
      expected[name as keyof typeof expected],
      `${name} should expose exactly the members its role declares`
    );
  }
});

test("Control API handlers depend on a role, not on the whole service", () => {
  // Ten handlers each used one to six members of a 53-member type. Pin the
  // narrowings so a later edit does not quietly widen a handler back to
  // `MemoryService`.
  const source = readFileSync(
    path.join(repositoryRoot, "runtime/src/control-api/memory.ts"),
    "utf8"
  );
  const handlers: [string, string][] = [
    ["serveExperienceOutcomes", "MemoryAssessmentReader"],
    ["serveExperienceInjectionUseAssessments", "MemoryAssessmentReader"],
    ["serveExperienceSessionOutcome", "MemoryAssessmentReader"],
    ["reportExperienceOutcome", "MemoryAssessmentRecorder"],
    ["reportExperienceInjectionUse", "MemoryAssessmentRecorder"],
    ["reportExperienceSessionOutcome", "MemoryAssessmentRecorder"],
    ["serveInjectionOutcomeCohorts", "MemoryAssessmentCohortReader"],
    ["serveSessionOutcomeCohorts", "MemoryAssessmentCohortReader"],
    ["serveInjectionUseCohorts", "MemoryAssessmentCohortReader"],
    ["purgeMemoryExperience", "MemoryExperiencePurger"]
  ];
  for (const [handler, role] of handlers) {
    assert.match(
      source,
      new RegExp(String.raw`function ${handler}\(\n  service: ${role},`, "u"),
      `${handler} should declare ${role}`
    );
  }
});
