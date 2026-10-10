import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import test from "node:test";

import {
  MEMORY_EVIDENCE_KINDS,
  MEMORY_REASON_CODES,
  type MemoryRecord
} from "@simulatorlife/autodev-core";

import { MemoryRecordsView } from "../src/features/memory/MemoryRecordsView.ts";
import {
  actionForm,
  fieldNames,
  fieldValue,
  selectOptions
} from "./support/memory-markup.ts";
import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";

/**
 * The rendered half of the governance contract.
 *
 * `memory-action-contract.test.ts` proves the Console's transport sends a body
 * the Runtime accepts. It cannot see the form, and the form is where the fields
 * come from: a correct transport driven by a form that never collects `evidence`
 * or a reason code is a refusal the operator can never avoid. That was not
 * hypothetical -- three of these four actions were unreachable at one point or
 * another, and none of it showed up in a request-body test.
 */

function listScope(overrides: Partial<MemoryListScope> = {}): MemoryListScope {
  return {
    tab: "records",
    workspaceId: "SimulatorLife/AutoDev",
    from: "2026-09-01T00:00:00.000Z",
    until: "2026-10-01T00:00:00.000Z",
    limit: 50,
    offset: 0,
    ...overrides
  } as MemoryListScope;
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-1" },
    kind: "procedural",
    claim: "Raise the retry budget when a run times out.",
    status: "active",
    provenance: {
      experienceIds: ["exp-1", "exp-2"],
      evidence: [],
      createdBy: "operator",
      createdAt: "2026-10-01T10:00:00.000Z"
    },
    validity: { state: "verified", evidence: [] },
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    ...overrides
  } as MemoryRecord;
}

/**
 * The records table with its drawer open.
 *
 * `selectedRecord` is what puts the governed actions on the page at all: the
 * table alone renders no action form, so a test that omits it passes against a
 * view that had lost every button.
 */
function render(records: readonly MemoryRecord[]): string {
  return renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records,
      total: records.length,
      selectedRecord: records[0],
      listScope: listScope()
    })
  );
}

/**
 * The markup for whichever governed state offers this action.
 *
 * Eligibility differs per action -- `verify` needs a record awaiting review,
 * `promote-skill` needs an active procedure -- so no single record renders all
 * four. Asking each question of the state that has the button is also what makes
 * "is this action reachable at all" answerable in the same breath.
 */
function markupFor(testId: string): string {
  // Supersession needs a prior to name, so the states are rendered with one
  // eligible active record beside the subject rather than alone.
  for (const status of ["proposed", "active", "uncertain"] as const) {
    const markup = render([
      record({ status }),
      record({ id: "mem-old", claim: "Raise the retry budget to ten minutes." })
    ]);
    if (markup.includes(`data-button="${testId}"`)) return markup;
  }
  assert.fail(`${testId} is not offered for a record in any governed state`);
}

function formFor(testId: string): string {
  return actionForm(markupFor(testId), testId);
}

test("every governed action is reachable from the record drawer", async () => {
  // The states differ per action, so a proposed record and an active one
  // between them have to expose all four. A missing button is the failure this
  // file exists to catch, and it is invisible in the transport tests.
  for (const testId of [
    "memory-verify",
    "memory-invalidate",
    "memory-revise",
    "memory-promote-skill"
  ]) {
    const form = actionForm(markupFor(testId), testId);
    assert.match(form, /^<form/, `${testId} has no form`);
  }
});

test("a revision submits the claim, its source experiences and its evidence", async () => {
  const form = formFor("memory-revise");

  // The experiences come from the record's own provenance. A revision has to
  // name them, and the page is already showing them, so the form states them
  // rather than asking the operator to retype what is on screen.
  assert.equal(fieldValue(form, "experienceIds"), "exp-1,exp-2");
  assert.equal(
    fieldValue(form, "claim"),
    "Raise the retry budget when a run times out."
  );
  assert.deepEqual(selectOptions(form, "evidenceKind"), [
    ...MEMORY_EVIDENCE_KINDS
  ]);
  assert.ok(
    fieldNames(form).includes("evidenceUri"),
    "a revision must ask where the evidence is"
  );
});

test("a revision does not collect a reason the Runtime would discard", async () => {
  // The Runtime reads a revision as claim, experienceIds and evidence. A reason
  // box here looked like an audit trail and was thrown away on submit, so the
  // history said "revised" and nothing about why.
  const form = formFor("memory-revise");
  assert.ok(
    !fieldNames(form).includes("reason"),
    "a reason field here is discarded by the route and cannot be recorded"
  );
});

test("an invalidation offers the Runtime's own reason codes and an evidence reference", async () => {
  const form = formFor("memory-invalidate");

  // Bounded, not prose: the Runtime refuses any reason outside its list, so the
  // control is a select over exactly that list rather than a text box.
  assert.deepEqual(
    selectOptions(form, "reason"),
    [...MEMORY_REASON_CODES],
    "the invalidation reason must be the Runtime's vocabulary, not free text"
  );
  assert.deepEqual(selectOptions(form, "evidenceKind"), [
    ...MEMORY_EVIDENCE_KINDS
  ]);
  assert.ok(fieldNames(form).includes("evidenceUri"));
});

test("verify and promotion both state the task they should be checked against", async () => {
  // These two are re-derived by the Runtime from a research request rather than
  // taken on trust, and it refuses both without one. `promote-skill` rendered no
  // such box at all, so the route refused every promotion as `reason_required`
  // and the button could not succeed however it was pressed.
  const proposed = render([record({ status: "proposed" })]);
  const active = render([record({ status: "active" })]);

  for (const [markup, testId] of [
    [proposed, "memory-verify"],
    [active, "memory-promote-skill"]
  ] as const) {
    const form = actionForm(markup, testId);
    assert.ok(
      fieldNames(form).includes("reason"),
      `${testId} must submit the research task; the Runtime refuses it without one`
    );
  }
});

test("a promotion carries the procedure body the Runtime writes to the skill", async () => {
  const form = formFor("memory-promote-skill");

  // A MemoryRecord has a claim, not a document, so the skill file is written
  // from what the record asserts. The Runtime refuses a promotion without it.
  assert.equal(
    fieldValue(form, "promotedContent"),
    "Raise the retry budget when a run times out."
  );
});

test("a record citing no experiences is not offered a revision it cannot make", async () => {
  // A revision cites the experiences it derives from, and the form can only
  // offer what the record's own provenance holds. For a record that cites none
  // the Runtime refuses every revision, so the button would be an action
  // guaranteed to fail -- replaced by the reason it cannot be performed.
  const markup = render([
    record({
      provenance: {
        experienceIds: [],
        evidence: [],
        createdBy: "operator",
        createdAt: "2026-10-01T10:00:00.000Z"
      }
    })
  ]);

  assert.ok(
    !markup.includes('data-button="memory-revise"'),
    "a revision with nothing to derive from would only ever be refused"
  );
  assert.match(
    markup,
    /cites no experiences/u,
    "the record should say why it cannot be revised"
  );
  // The other governed actions do not depend on provenance, so they stay.
  assert.match(markup, /data-button="memory-invalidate"/);
});

test("a proposal offers to supersede the active record it corrects", async () => {
  // Verify promotes a proposal while the claim it contradicts stays active, so
  // both keep answering the same question. Supersession is the only transition
  // that retires the older record, and it was unreachable from the Console --
  // the status, the filter and the lineage panel were all reachable only by a
  // hand-written request.
  const prior = record({
    id: "mem-old",
    status: "active",
    claim: "Raise the retry budget to ten minutes."
  });
  const markup = render([record({ status: "proposed" }), prior]);
  const form = actionForm(markup, "memory-supersede");

  // The prior is named by choice, not typed: the Runtime admits only an active
  // record of the same kind and exact scope, so asking for an id would be asking
  // for something that is usually refused.
  assert.deepEqual(selectOptions(form, "priorId"), ["mem-old"]);
  assert.equal(fieldValue(form, "recordId"), "mem-1");
  assert.ok(
    fieldNames(form).includes("reason"),
    "a supersession is re-derived by the Runtime and needs its research context"
  );
});

test("supersession offers only records the Runtime would admit", async () => {
  const active = record({ id: "mem-old", status: "active" });
  const proposed = record({ id: "mem-new", status: "proposed" });

  // Wrong kind, wrong scope, wrong status: each is refused by the Runtime, so
  // each must be absent from the choice rather than offered and turned down.
  const markup = render([
    proposed,
    active,
    record({ id: "mem-semantic", status: "active", kind: "semantic" }),
    record({
      id: "mem-elsewhere",
      status: "active",
      scope: { kind: "global" }
    }),
    record({ id: "mem-proposed-too", status: "proposed" })
  ]);

  assert.deepEqual(
    selectOptions(actionForm(markup, "memory-supersede"), "priorId"),
    ["mem-old"]
  );
});

test("a proposal with no active record to supersede says so", async () => {
  const markup = render([record({ status: "proposed" })]);

  assert.ok(
    !markup.includes('data-button="memory-supersede"'),
    "there is nothing to supersede, so the action would only ever be refused"
  );
  assert.match(markup, /to supersede/u);
  // The rest of the governance surface is unaffected.
  assert.match(markup, /data-button="memory-verify"/);
});

test("a proposal says the filters are hiding the record it would supersede", async () => {
  // The candidates are the records on this list, so filtering to `proposed` --
  // the obvious way to find something to review -- excludes every active record
  // that could have been superseded. Told only "no record visible", an operator
  // concludes there is nothing to supersede, which is the opposite of the truth.
  const markup = renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [record({ status: "proposed" })],
      total: 1,
      selectedRecord: record({ status: "proposed" }),
      listScope: listScope({ status: "proposed" })
    })
  );

  assert.match(
    markup,
    /Clear the filters to choose the record this one replaces/u,
    "the drawer must name the filters as the reason, not imply there is nothing"
  );
  assert.ok(!markup.includes('data-button="memory-supersede"'));
});

test("an unfiltered list says plainly that no record is eligible", async () => {
  const markup = render([record({ status: "proposed" })]);

  assert.match(markup, /No active record of this kind and scope/u);
  assert.ok(
    !/Clear the filters/u.test(markup),
    "there are no filters to clear here, so blaming them would be wrong"
  );
});

test("an active record is not offered supersession", async () => {
  // Only a proposal can supersede, and only an active record can be superseded;
  // an active record is the subject of neither.
  const markup = render([
    record({ status: "active" }),
    record({ id: "mem-old" })
  ]);

  assert.ok(!markup.includes('data-button="memory-supersede"'));
  assert.ok(!markup.includes('name="priorId"'));
});

test("every action form names its record, its workspace and where to return to", async () => {
  for (const testId of [
    "memory-verify",
    "memory-invalidate",
    "memory-revise",
    "memory-promote-skill"
  ]) {
    const form = formFor(testId);
    assert.equal(
      fieldValue(form, "recordId"),
      "mem-1",
      `${testId} must name its record`
    );
    assert.equal(
      fieldValue(form, "workspaceId"),
      "SimulatorLife/AutoDev",
      `${testId} must name its workspace`
    );
    const returned = fieldValue(form, "returned") ?? "";
    assert.ok(
      returned.includes("workspaceId=SimulatorLife%2FAutoDev") &&
        returned.includes("limit=50"),
      `${testId} must carry the filters it was made on so the redirect stays in scope`
    );
  }
});
