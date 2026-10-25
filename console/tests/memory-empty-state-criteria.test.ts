import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  isMemoryScopeNarrowed,
  type MemoryListScope
} from "../src/features/memory/memory-list-url.ts";
import { MemoryCohortsView } from "../src/features/memory/MemoryCohortsView.ts";
import { MemoryExperiencesView } from "../src/features/memory/MemoryExperiencesView.ts";
import { MemoryRecordsView } from "../src/features/memory/MemoryRecordsView.ts";

/**
 * An empty list says which of two things happened.
 *
 * The memory holds nothing for this scope, or the criteria the operator chose
 * hold nothing. The second of those is a claim about something the operator
 * did, so it may only be made when they did it.
 *
 * The records table made it unconditionally: an operator who opened the memory
 * for a workspace that holds no records yet was told that "no memory records
 * found matching the current criteria", which blames a filter they never
 * touched. The other lists in the Console -- prompts, tools, skills, the
 * GitHub runs and workflows, the evaluations -- have said which of the two
 * happened since they were narrowed, and the memory is now the same.
 */

const SCOPE: MemoryListScope = {
  workspaceId: "SimulatorLife/AutoDev",
  from: "2026-10-01T00:00:00.000Z",
  until: "2026-10-02T00:00:00.000Z",
  limit: 25,
  offset: 0,
  tab: "records"
} as MemoryListScope;

const NARROWED: MemoryListScope = { ...SCOPE, query: "nothing matches this" };

test("a scope knows whether the operator narrowed it", () => {
  assert.equal(isMemoryScopeNarrowed(SCOPE), false);
  assert.equal(isMemoryScopeNarrowed(NARROWED), true);
  assert.equal(
    isMemoryScopeNarrowed({ ...SCOPE, kind: "all" }),
    false,
    `"all" means unfiltered, and the URL never writes it out`
  );
  assert.equal(isMemoryScopeNarrowed({ ...SCOPE, kind: "semantic" }), true);
  assert.equal(isMemoryScopeNarrowed({ ...SCOPE, status: "active" }), true);
  assert.equal(
    isMemoryScopeNarrowed({ ...SCOPE, tab: "cohorts", outcomeKind: "success" }),
    true,
    "the cohort filters belong to the cohort tab, and they narrow it"
  );
});

function recordsMarkup(scope: MemoryListScope): string {
  return renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records: [],
      total: 0,
      listScope: scope
    })
  );
}

function experiencesMarkup(scope: MemoryListScope): string {
  return renderToStaticMarkup(
    React.createElement(MemoryExperiencesView, {
      experiences: [],
      total: 0,
      listScope: scope
    })
  );
}

test("the records table says which of the two happened", () => {
  const narrowed = recordsMarkup(NARROWED);
  assert.match(
    narrowed,
    /No memory records found matching the current criteria\./u,
    "a filter that matched nothing says so"
  );
  assert.doesNotMatch(
    narrowed,
    /No memory records were observed for this scope\./u,
    "the unnarrowed sentence is not what happened"
  );

  const unnarrowed = recordsMarkup(SCOPE);
  assert.match(
    unnarrowed,
    /No memory records were observed for this scope\./u,
    "a scope that holds nothing says that, and does not blame a filter"
  );
  assert.doesNotMatch(
    unnarrowed,
    /matching the current criteria/u,
    "the unnarrowed empty state claims a narrowing that never happened"
  );
});

test("the experiences table says which of the two happened", () => {
  const narrowed = experiencesMarkup(NARROWED);
  assert.match(
    narrowed,
    /No captured memory experiences found matching the current criteria\./u
  );
  const unnarrowed = experiencesMarkup(SCOPE);
  assert.match(
    unnarrowed,
    /No captured memory experiences were observed in this workspace scope\./u
  );
  assert.doesNotMatch(unnarrowed, /matching the current criteria/u);
});

test("the cohort tables and charts say which of the two happened", () => {
  const scope: MemoryListScope = { ...SCOPE, tab: "cohorts" };
  const narrowed: MemoryListScope = {
    ...scope,
    outcomeKind: "success"
  };
  const markup = renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      listScope: narrowed,
      cohortTotals: null,
      cohortSessionTotals: null,
      injectionUseCohorts: null,
      sessionOutcomeCohorts: null
    } as never)
  );
  assert.match(
    markup,
    /matching the current criteria/u,
    "a cohort filter that matched nothing says so"
  );
});
