import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import test from "node:test";

import {
  EXPERIENCE_OUTCOMES,
  MEMORY_EVIDENCE_KINDS,
  MEMORY_EXPERIENCE_PURGE_REASONS,
  MEMORY_OUTCOME_REPORT_KINDS,
  MEMORY_USE_KINDS,
  type ControlApiMemoryInjectionOutcomeJoin,
  type ControlApiMemoryInjectionUseAssessment,
  type ExperienceEnvelope
} from "@simulatorlife/autodev-core";

import { MemoryExperiencesView } from "../src/features/memory/MemoryExperiencesView.ts";
import {
  actionForm as formFor,
  allOptions,
  fieldValue,
  selectOptions
} from "./support/memory-markup.ts";
import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";

/**
 * The experiences tab's forms, read off the page.
 *
 * Each of these vocabularies is validated by the Runtime against the list in
 * Core, so a select that spells its own options is a select that can offer a
 * value the Runtime refuses. All four did — outcome kinds, report kinds, use
 * kinds and evidence kinds were written out again beside the form that offered
 * them, and nothing failed when Core moved on. These cases hold every select to
 * Core's list directly, so the next code added anywhere shows up as a missing
 * option rather than as an operator who cannot report what they saw.
 */

function listScope(): MemoryListScope {
  return {
    tab: "experiences",
    workspaceId: "SimulatorLife/AutoDev",
    from: "2026-09-01T00:00:00.000Z",
    until: "2026-10-01T00:00:00.000Z",
    limit: 50,
    offset: 0
  } as MemoryListScope;
}

function experience(
  overrides: Partial<ExperienceEnvelope> = {}
): ExperienceEnvelope {
  return {
    id: "exp-1",
    workspaceId: "SimulatorLife/AutoDev",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    startedAt: "2026-09-20T09:00:00.000Z",
    outcome: "success",
    trajectory: { format: "jsonl", uri: "runs/42/trajectory.jsonl" },
    evidence: [],
    ...overrides
  } as ExperienceEnvelope;
}

function injection(
  overrides: Partial<ControlApiMemoryInjectionOutcomeJoin["injection"]> = {}
): ControlApiMemoryInjectionOutcomeJoin["injection"] {
  return {
    id: "inj-1",
    correlationToken: "corr-1",
    memoryMode: "on",
    injectionResult: "injected",
    packetCharacterCount: 812,
    memoryIds: ["mem-1"],
    occurredAt: "2026-09-20T09:30:00.000Z",
    ...overrides
  } as ControlApiMemoryInjectionOutcomeJoin["injection"];
}

/**
 * The drawer open on one experience, with one observed injection.
 *
 * `outcome` is what decides whether the report form is offered — the Runtime
 * binds one outcome per injection, so a row carrying one is a row the form is
 * withdrawn from. `use` is the same idea for the curator's half.
 */
function render(
  options: {
    readonly reported?: boolean;
    readonly assessed?: boolean;
  } = {}
): string {
  const selected = experience();
  const rows: ControlApiMemoryInjectionOutcomeJoin[] = [
    {
      injection: injection(),
      sessionInjectionCount: 1,
      outcome: options.reported === true
        ? {
            outcomeKind: "success",
            reportKind: "task",
            reportedAt: "2026-09-20T10:00:00.000Z",
            reporterId: "operator",
            reporterAuthority: "operator",
            reasonCode: "verified_current_state"
          }
        : null
    }
  ];
  const assessments: ControlApiMemoryInjectionUseAssessment[] = [
    {
      injection: {
        id: "inj-1",
        memoryMode: "on",
        injectionResult: "injected",
        packetCharacterCount: 812,
        memoryIds: ["mem-1"],
        occurredAt: "2026-09-20T09:30:00.000Z"
      },
      sessionInjectionCount: 1,
      use:
        options.assessed === true
          ? {
              useKind: "used",
              usedMemoryIds: ["mem-1"],
              reportedAt: "2026-09-20T10:05:00.000Z",
              evidence: []
            }
          : null
    }
  ];
  return renderToStaticMarkup(
    React.createElement(MemoryExperiencesView, {
      experiences: [selected],
      total: 1,
      selectedExperience: selected,
      outcomes: rows,
      outcomeTotal: options.reported === true ? 1 : 0,
      useAssessments: assessments,
      useAssessmentTotal: options.assessed === true ? 1 : 0,
      listScope: listScope()
    })
  );
}

test("a purge offers only the reasons the Runtime accepts", async () => {
  const form = formFor(render(), "purge-experience");

  assert.deepEqual(
    selectOptions(form, "reason"),
    [...MEMORY_EXPERIENCE_PURGE_REASONS],
    "the purge reason must be the Runtime's vocabulary, not free text"
  );
  assert.equal(fieldValue(form, "experienceId"), "exp-1");
});

test("a purge is confirmed explicitly, because it cannot be undone", async () => {
  const form = formFor(render(), "purge-experience");

  // The Memory form is server-rendered, so an unchecked box is not a UI-only
  // guard — it is a request the route refuses. The confirmation is what makes
  // the click mean it, and it has to be a control the operator operates.
  assert.match(
    form,
    /type="checkbox"[^>]*name="confirm"[^>]*value="purge"/u,
    "an irreversible purge must carry a confirmation the operator gives"
  );
});

test("an outcome report submits the token it binds to and the Runtime's own vocabularies", async () => {
  const form = formFor(render(), "memory-report-outcome-inj-1");

  // The token binds the report to this injection; the Runtime re-resolves it
  // against the reporter's scope, so a wrong one fails closed.
  assert.equal(fieldValue(form, "correlationToken"), "corr-1");
  assert.deepEqual(selectOptions(form, "outcomeKind"), [...EXPERIENCE_OUTCOMES]);
  assert.deepEqual(selectOptions(form, "reportKind"), [
    ...MEMORY_OUTCOME_REPORT_KINDS
  ]);
  assert.deepEqual(selectOptions(form, "evidenceKind"), [
    ...MEMORY_EVIDENCE_KINDS
  ]);
  assert.ok(form.includes('name="evidenceUri"'), "a report needs where its evidence lives");
});

test("a use assessment submits the injection it judges and the Runtime's use kinds", async () => {
  const form = formFor(render(), "memory-report-use-inj-1");

  assert.equal(fieldValue(form, "injectionEventId"), "inj-1");
  assert.deepEqual(selectOptions(form, "useKind"), [...MEMORY_USE_KINDS]);
  assert.deepEqual(selectOptions(form, "evidenceKind"), [
    ...MEMORY_EVIDENCE_KINDS
  ]);
  assert.ok(form.includes('name="usedMemoryIds"'));
});

test("every evidence-kind select on the page offers one identical list", async () => {
  // The duplication this file exists to prevent: two forms citing the same
  // vocabulary from two hand-written lists, which agree until one is edited.
  const lists = allOptions(render(), "evidenceKind");

  assert.ok(lists.length >= 2, "expected several evidence selects on one drawer");
  for (const list of lists) {
    assert.deepEqual(
      list.map((entry) => entry.value),
      [...MEMORY_EVIDENCE_KINDS]
    );
  }
});

test("an outcome already reported is not offered a second report", async () => {
  // The Runtime binds one outcome per injection, so a second form would be an
  // offer it refuses.
  const markup = render({ reported: true });

  assert.ok(
    !markup.includes('data-button="memory-report-outcome-inj-1"'),
    "one outcome per injection is the Runtime's rule, not a UI choice"
  );
  assert.match(markup, /already reported/u);
});

test("an injection already assessed is not offered a second assessment", async () => {
  const markup = render({ assessed: true });

  assert.ok(
    !markup.includes('data-button="memory-report-use-inj-1"'),
    "a curated verdict is not re-asked once it exists"
  );
});