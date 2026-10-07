import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import test from "node:test";

import { MemoryCohortsView } from "../src/features/memory/MemoryCohortsView.ts";
import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";

/**
 * A count must not be labelled as something broader than the number measures.
 *
 * The headline session card read "Observed Sessions". The Runtime's
 * `sessionCount` is not that: per the repository's own contract it sums only
 * eligible single-assigned-mode cells, counting mixed-mode sessions solely in
 * `mixedModeSessionCount` and dropping sessions whose injections are all
 * invalid or unknown mode from the response entirely. So the card showed the
 * sessions that qualified for the mode-isolated table under a name that invited
 * an operator to read it as every session seen — and then to add the mixed
 * count to it for a denominator that was never computed.
 *
 * That inference is the one the spec rules out at
 * `docs/memory-target-state.md` line 426: controlled cohorts must not be
 * inferred from telemetry that was never classified.
 */

function listScope(): MemoryListScope {
  return {
    tab: "cohorts",
    workspaceId: "SimulatorLife/AutoDev",
    offset: 0,
    limit: 25
  } as MemoryListScope;
}

function render(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts: {
        schema: "autodev-memory-session-outcome-cohorts-v1",
        workspaceId: "SimulatorLife/AutoDev",
        repositoryId: "simulatorlife/autodev",
        occurredFrom: "2026-10-01T00:00:00.000Z",
        occurredUntil: "2026-10-08T00:00:00.000Z",
        cells: [
          { memoryMode: "jit", outcomeKind: "success", sessionCount: 15 },
          { memoryMode: "jit", outcomeKind: null, sessionCount: 6 }
        ],
        sessionCount: 21,
        reportedSessionCount: 15,
        unreportedSessionCount: 6,
        conflictingOutcomeSessionCount: 1,
        mixedModeSessionCount: 4,
        ...overrides
      },
      useCohorts: null,
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "simulatorlife/autodev",
      occurredFrom: "2026-10-01T00:00:00.000Z",
      occurredUntil: "2026-10-08T00:00:00.000Z",
      listScope: listScope()
    })
  );
}

test("the headline session count is named for what the Runtime counts", () => {
  const markup = render();

  assert.match(
    markup,
    /Mode-Isolated Sessions/u,
    "the card must name the eligible single-mode sessions it actually counts"
  );
  assert.match(
    markup,
    /Reported plus unreported/u,
    "the card must say which totals it sums"
  );
  assert.doesNotMatch(
    markup,
    /Observed Sessions/u,
    "`sessionCount` excludes mixed-mode and all-invalid/unknown sessions, so " +
      "calling it the observed sessions overstates what was counted"
  );
});

test("the sessions the headline excludes stay visible on the page", () => {
  // The mixed-mode sessions are the ones an operator would most want to add
  // back, so their count has to be on the same page as the headline — and has
  // to say it was excluded, rather than appearing as a fifth bucket that looks
  // like a subset of the first.
  const markup = render();

  assert.match(markup, /Mixed-Mode Sessions/u);
  assert.match(
    markup,
    /Excluded from mode-isolated cells/u,
    "the mixed-mode card must say it is outside the headline count"
  );
});