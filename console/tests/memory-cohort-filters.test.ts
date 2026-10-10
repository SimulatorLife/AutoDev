import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import test from "node:test";

import {
  EXPERIENCE_OUTCOMES,
  MEMORY_INJECTION_RESULTS,
  MEMORY_OUTCOME_REPORT_KINDS,
  MEMORY_SESSION_COHORT_ASSIGNED_MODES,
  MEMORY_USE_KINDS
} from "@simulatorlife/autodev-core";

import { MemoryCohortsView } from "../src/features/memory/MemoryCohortsView.ts";
import { selectEntries, selectOptions } from "./support/memory-markup.ts";
import {
  MEMORY_COHORT_MODE_LABEL,
  MEMORY_INJECTION_RESULT_LABEL,
  MEMORY_OUTCOME_LABEL,
  MEMORY_REPORT_KIND_LABEL,
  MEMORY_USE_KIND_LABEL
} from "../src/features/memory/memory-status.ts";
import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";

/**
 * The cohort filter bar offers Core's vocabularies, not its own.
 *
 * The Runtime validates a submitted cohort filter against the lists in Core, so
 * a filter spelling its own options is a filter that can offer a value the
 * Runtime refuses and quietly stop offering one it had gained. All five of these
 * were written out by hand beside the controls that offered them.
 *
 * The labels are asserted too, because sourcing the values from Core is only
 * half of it: a select that renders `used` and `success` raw has the same defect
 * as one that offers the wrong value, and this repo already has tests forbidding
 * wire keys on screen.
 */

function listScope(): MemoryListScope {
  return {
    tab: "cohorts",
    workspaceId: "SimulatorLife/AutoDev",
    from: "2026-09-01T00:00:00.000Z",
    until: "2026-10-01T00:00:00.000Z",
    limit: 50,
    offset: 0
  } as MemoryListScope;
}

/** Both matrices absent: the read did not succeed, which is its own state. */
function render(): string {
  return renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts: null,
      useCohorts: null,
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "repo-1",
      occurredFrom: "2026-09-01T00:00:00.000Z",
      occurredUntil: "2026-10-01T00:00:00.000Z",
      listScope: listScope()
    })
  );
}

const FILTERS: readonly {
  readonly name: string;
  readonly codes: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}[] = [
  {
    name: "memoryMode",
    codes: MEMORY_SESSION_COHORT_ASSIGNED_MODES,
    labels: MEMORY_COHORT_MODE_LABEL
  },
  {
    name: "injectionResult",
    codes: MEMORY_INJECTION_RESULTS,
    labels: MEMORY_INJECTION_RESULT_LABEL
  },
  {
    name: "reportKind",
    codes: MEMORY_OUTCOME_REPORT_KINDS,
    labels: MEMORY_REPORT_KIND_LABEL
  },
  {
    name: "outcomeKind",
    codes: EXPERIENCE_OUTCOMES,
    // In a filter, `unknown` means no reporter supplied an outcome, which is the
    // state the shared missing-evidence word names.
    labels: { ...MEMORY_OUTCOME_LABEL, unknown: "Not observed" }
  },
  {
    name: "useKind",
    codes: MEMORY_USE_KINDS,
    labels: MEMORY_USE_KIND_LABEL
  }
];

test('every cohort filter offers Core\'s vocabulary behind an "all"', async () => {
  for (const filter of FILTERS) {
    assert.deepEqual(
      selectOptions(render(), filter.name),
      ["all", ...filter.codes],
      `${filter.name} must offer exactly what the Runtime accepts, plus "all"`
    );
  }
});

test("no cohort filter renders a wire key as its label", async () => {
  const markup = render();
  for (const filter of FILTERS) {
    const entries = selectEntries(markup, filter.name);
    for (const { value, label } of entries) {
      if (value === "all") continue;
      assert.equal(
        label,
        filter.labels[value],
        `${filter.name} must show the Console's word for ${value}, not its wire key`
      );
      assert.notEqual(
        label,
        value,
        `${filter.name} rendered the raw wire key ${value}`
      );
    }
  }
});

test("a cohort filter's word is the same one its cells read", async () => {
  // An operator selects "Used" and then reads the cells; two spellings of one
  // vocabulary is how a filter silently fails to match what it appears to.
  const markup = render();
  assert.ok(
    selectEntries(markup, "useKind").some(
      ({ value, label }) =>
        value === "used" && label === MEMORY_USE_KIND_LABEL.used
    ),
    "the use filter must use the same label the cohort cells render"
  );
  assert.ok(
    selectEntries(markup, "outcomeKind").some(
      ({ value, label }) =>
        value === "success" && label === MEMORY_OUTCOME_LABEL.success
    ),
    "the outcome filter must use the same label the cohort cells render"
  );
});
