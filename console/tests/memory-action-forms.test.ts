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

/** The `<form>` that submits through the button with this test id. */
function actionForm(markup: string, testId: string): string {
  const button = markup.indexOf(`data-button="${testId}"`);
  assert.notEqual(button, -1, `no action button rendered for ${testId}`);
  // The form opens before its button and closes after it.
  const open = markup.lastIndexOf("<form", button);
  const close = markup.indexOf("</form>", button);
  assert.ok(open !== -1 && close > open, `${testId} is not inside a form`);
  return markup.slice(open, close);
}

/** The `name` of every control a form will submit, in document order. */
function fieldNames(form: string): string[] {
  return [...form.matchAll(/<(?:input|select|textarea)\b[^>]*>/gu)]
    .map((match) => /\bname="([^"]*)"/u.exec(match[0])?.[1])
    .filter((name): name is string => name !== undefined);
}

/** What a single control submits. A `<select>` submits its chosen option. */
function fieldValue(form: string, name: string): string | undefined {
  const tag = new RegExp(
    `<(input|textarea|select)\\b[^>]*\\bname="${name}"[^>]*>`,
    "u"
  ).exec(form);
  if (!tag) return undefined;
  if (tag[1] === "select") {
    const body = form.slice(tag.index, form.indexOf("</select>", tag.index));
    return /<option[^>]*\bvalue="([^"]*)"/u.exec(body)?.[1] ?? "";
  }
  // A textarea's value is its text, not an attribute; React escapes it on the
  // way out, so it has to be read back the way it will arrive on submit.
  if (tag[1] === "textarea") {
    const text = form.slice(
      tag.index + tag[0].length,
      form.indexOf("</textarea>", tag.index)
    );
    return text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#x27;", "'")
      .replaceAll("&amp;", "&");
  }
  return /\bvalue="([^"]*)"/u.exec(tag[0])?.[1] ?? "";
}

/** Every option a `<select>` offers, so a bounded vocabulary can be checked. */
function selectOptions(form: string, name: string): string[] {
  const open = new RegExp(`<select\\b[^>]*\\bname="${name}"[^>]*>`, "u").exec(
    form
  );
  assert.ok(open, `no select named ${name}`);
  const body = form.slice(
    open.index,
    form.indexOf("</select>", open.index)
  );
  return [...body.matchAll(/<option[^>]*\bvalue="([^"]*)"/gu)].map(
    (match) => match[1]!
  );
}

/**
 * The form for one action, from whichever governed state offers it.
 *
 * Eligibility differs per action -- `verify` needs a record awaiting review,
 * `promote-skill` needs an active procedure -- so no single record renders all
 * four. Asking each question of the state that has the button is also what makes
 * "is this action reachable at all" answerable in the same breath.
 */
function formFor(testId: string): string {
  for (const status of ["proposed", "active", "uncertain"] as const) {
    const markup = render([record({ status })]);
    if (markup.includes(`data-button="${testId}"`)) {
      return actionForm(markup, testId);
    }
  }
  assert.fail(`${testId} is not offered for a record in any governed state`);
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
    const form = formFor(testId);
    assert.match(form, /^<form/, `${testId} has no form`);
  }
});

test("a revision submits the claim, its source experiences and its evidence", async () => {
  const form = formFor("memory-revise");

  // The experiences come from the record's own provenance. A revision has to
  // name them, and the page is already showing them, so the form states them
  // rather than asking the operator to retype what is on screen.
  assert.equal(fieldValue(form, "experienceIds"), "exp-1,exp-2");
  assert.equal(fieldValue(form, "claim"), "Raise the retry budget when a run times out.");
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
  assert.deepEqual(selectOptions(form, "evidenceKind"), [...MEMORY_EVIDENCE_KINDS]);
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

test("every action form names its record, its workspace and where to return to", async () => {
  for (const testId of [
    "memory-verify",
    "memory-invalidate",
    "memory-revise",
    "memory-promote-skill"
  ]) {
    const form = formFor(testId);
    assert.equal(fieldValue(form, "recordId"), "mem-1", `${testId} must name its record`);
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