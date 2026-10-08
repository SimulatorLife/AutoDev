import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import test from "node:test";

import { MemoryView } from "../src/features/memory/MemoryView.ts";
import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";
import type { MemoryRecord } from "@simulatorlife/autodev-core";

/**
 * What the top stat cards claim about the list underneath them.
 *
 * "Durable Records" and "Experiences" each pair a *collection* count — the
 * Runtime's `total` for the filtered read — with a subtitle built from
 * `records.length` / `experiences.length`, which is the *page*. Both were
 * labelled "N in scope", which under a total of 1,204 says that 50 of the
 * matching records were in scope when in fact all 1,204 were and 50 were merely
 * how many this page holds.
 *
 * The same confusion had already been found and fixed one card below, for the
 * lifecycle counts, with a comment explaining it. These two subtitles were the
 * instances the fix did not reach.
 *
 * The wording is what is asserted, not the numbers: a card that renders the
 * right count under a misleading word is the failure, so the test fails if the
 * subtitle drifts back to describing something other than the page.
 */

function listScope(tab: "records" | "experiences" | "cohorts"): MemoryListScope {
  return {
    tab,
    workspaceId: "SimulatorLife/AutoDev",
    offset: 0,
    limit: 25
  } as MemoryListScope;
}

/**
 * A page of real-shaped records. The records table renders every row it is
 * given, so a stub carrying only an `id` fails inside `formatScopeString`
 * before the stat cards are ever reached.
 */
function records(count: number): MemoryRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `rec-${index}`,
    kind: "semantic",
    scope: { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
    claim: `claim ${index}`,
    status: "active",
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "test",
      createdAt: "2026-10-01T00:00:00.000Z"
    },
    validity: { state: "unverified", evidence: [] },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  }));
}

function render(page: {
  readonly recordCount: number;
  readonly totalRecords: number;
  readonly experienceCount: number;
  readonly totalExperiences: number | null;
}): string {
  return renderToStaticMarkup(
    React.createElement(MemoryView, {
      listScope: listScope("records"),
      records: records(page.recordCount),
      totalRecords: page.totalRecords,
      experiences: Array.from({ length: page.experienceCount }, (_, index) => ({
        id: `exp-${index}`
      })) as never,
      totalExperiences: page.totalExperiences,
      sessionCohorts: null,
      useCohorts: null,
      repositoryId: "SimulatorLife/AutoDev",
      workspaces: [],
      unapplied: []
    })
  );
}

test("a stat card's subtitle names the page, not a subset of the collection", () => {
  // The two page counts are deliberately different. With the same number on
  // both cards, `/2 on this page/` matches the *experiences* card whether or not
  // the records card says anything true -- so a records subtitle naming the
  // collection total would have passed this test. Each assertion below can now
  // only be satisfied by the card it describes.
  const markup = render({
    recordCount: 2,
    totalRecords: 1204,
    experienceCount: 3,
    totalExperiences: 1207
  });

  // The numbers the operator narrowed to, and the numbers these pages hold.
  assert.match(markup, />1,?204</u, "the records total must still be the headline");
  assert.match(markup, />1,?207</u, "the experiences total must still be the headline");
  assert.match(
    markup,
    /2 on this page/u,
    "the records subtitle must say this page holds 2 of the 1,204 matching"
  );
  assert.match(
    markup,
    /3 on this page/u,
    "the experiences subtitle must say this page holds 3 of the 1,207 matching"
  );
  assert.doesNotMatch(
    markup,
    /1,?204 on this page/u,
    'reading "1,204 on this page" claims the page holds every matching record'
  );
  assert.doesNotMatch(
    markup,
    /2 in scope/u,
    'reading "2 in scope" under a total of 1,204 claims 2 of the matching records are in scope, which is the inverse of the truth'
  );
  assert.doesNotMatch(
    markup,
    /3 in scope/u,
    "the experiences card made the same claim about its own total"
  );
});

test("an unobserved experience total keeps its own subtitle rather than naming a page", () => {
  // The observed/unobserved branch: a null experiences total means the source
  // could not be read at all. Pairing that headline with a page count would
  // claim a measurement the Runtime never made.
  const markup = render({
    recordCount: 2,
    totalRecords: 1204,
    experienceCount: 2,
    totalExperiences: null
  });

  assert.match(markup, /Not observed/u);
  // The records card is observed, so it keeps its page count; the experiences
  // card must not gain one. Counting the occurrences keeps the two apart.
  assert.equal(
    (markup.match(/on this page/gu) ?? []).length,
    1,
    "only the observed records card may name a page"
  );
});