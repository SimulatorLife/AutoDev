import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import test from "node:test";

import type {
  MemoryRecord,
  MemoryScope,
  MemoryValidity
} from "@simulatorlife/autodev-core";

import { MemoryRecordsView } from "../src/features/memory/MemoryRecordsView.ts";
import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";

/**
 * How a record names its scope, and when its claim is in force.
 *
 * Two things here were decided by convention rather than by anything the
 * compiler checked.
 *
 * `formatScopeString` switched over Core's six `MemoryScope` kinds and then
 * ended in `default: return "unknown"`. That branch was unreachable, and it
 * returned the Console's own word for missing evidence — so the one thing it
 * could say about an unnameable scope was that the scope was unobserved. It
 * also swallowed every future kind: adding a seventh to Core would have
 * compiled and rendered "unknown" instead of failing. The branch is now typed
 * `never`, so that addition is a type error.
 *
 * The validity window and the provenance meta lines were reachable but never
 * rendered by a test, including the two half-open windows a record actually
 * carries most often: valid from a date, or valid until one.
 */

const LIST_SCOPE: MemoryListScope = {
  workspaceId: "SimulatorLife/AutoDev",
  offset: 0,
  limit: 25,
  tab: "records"
} as MemoryListScope;

const TIMESTAMP = "2026-10-01T00:00:00.000Z";

function record(
  id: string,
  scope: MemoryScope,
  validity: MemoryValidity = { state: "verified", evidence: [] }
): MemoryRecord {
  return {
    id,
    kind: "semantic",
    status: "active",
    scope,
    claim: `Claim ${id}.`,
    validity,
    provenance: {
      experienceIds: [],
      evidence: [],
      createdBy: "operator",
      createdAt: TIMESTAMP
    },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  };
}

function render(
  records: readonly MemoryRecord[],
  selected?: MemoryRecord
): string {
  return renderToStaticMarkup(
    React.createElement(MemoryRecordsView, {
      records,
      total: records.length,
      ...(selected ? { selectedRecord: selected } : {}),
      listScope: LIST_SCOPE
    })
  );
}

test("every scope Core defines is named, and each says which scope it is", () => {
  // The three kinds after `repository` had no test, so a record scoped to a
  // task or an agent — which is how run-bound findings are actually stored —
  // had its label written by code nothing exercised.
  //
  // Asserted through the drawer subtitle, which carries the string whole. The
  // table column renders the same value through `PathText`, which splits it into
  // segments so the text an operator reads is not contiguous in the markup.
  //
  // Scoped to the `Scope:` label rather than the whole document. Asserting the
  // document contains no "unknown" at all passes for the wrong reason here: the
  // word does appear on this screen, as a reason code, in the drawer below the
  // claim. It is the scope label that must never fall back to it.
  const cases: readonly [MemoryScope, string][] = [
    [{ kind: "global" }, "global"],
    [
      { kind: "workspace", workspaceId: "SimulatorLife/AutoDev" },
      "SimulatorLife/AutoDev"
    ],
    [
      {
        kind: "repository",
        workspaceId: "SimulatorLife/AutoDev",
        repositoryId: "simulatorlife/autodev"
      },
      "simulatorlife/autodev"
    ],
    [
      { kind: "role", workspaceId: "SimulatorLife/AutoDev", role: "reviewer" },
      "SimulatorLife/AutoDev (@reviewer)"
    ],
    [
      {
        kind: "task",
        workspaceId: "SimulatorLife/AutoDev",
        taskId: "task-7",
        runId: "run-1"
      },
      "task:task-7"
    ],
    [
      {
        kind: "agent",
        workspaceId: "SimulatorLife/AutoDev",
        taskId: "task-7",
        runId: "run-1",
        agentId: "agent-3"
      },
      "agent:agent-3"
    ]
  ];

  for (const [scope, expected] of cases) {
    const markup = render([], record("mem-scope", scope));
    const named = /Scope: ([^<]*)</u.exec(markup)?.[1];

    assert.equal(
      named,
      expected,
      `a record scoped ${JSON.stringify(scope.kind)} was not named as ${JSON.stringify(expected)}`
    );
  }
});

test("a half-open validity window is named, not left blank", () => {
  // A claim that becomes valid later, or stops being valid later, is the normal
  // case. Only the both-ends and neither-end shapes were exercised, so the two
  // single-ended windows rendered nothing at all and a record with a real
  // window looked like a record with no validity information.
  // Read out of the validity card rather than matched against the document:
  // the whole render is one long line of markup, so a `^…$` pattern would never
  // match it. The window is the only text in that card.
  const windowText = (markup: string): string | undefined =>
    /font-mono text-xs text-fg-muted">(Valid[^<]*)</u.exec(markup)?.[1];

  const cases: readonly [string, MemoryValidity, RegExp][] = [
    [
      "both ends",
      {
        state: "verified",
        validFrom: "2026-10-01T00:00:00.000Z",
        validTo: "2026-11-01T00:00:00.000Z",
        evidence: []
      },
      /^Valid .* to .*$/u
    ],
    [
      "valid from",
      {
        state: "verified",
        validFrom: "2026-10-01T00:00:00.000Z",
        evidence: []
      },
      /^Valid from /u
    ],
    [
      "valid until",
      {
        state: "verified",
        validTo: "2026-11-01T00:00:00.000Z",
        evidence: []
      },
      /^Valid until /u
    ]
  ];

  for (const [label, validity, expected] of cases) {
    const rendered = windowText(
      render([], record("mem-window", { kind: "global" }, validity))
    );
    assert.ok(rendered, `a ${label} validity window was not rendered at all`);
    assert.match(rendered, expected, `a ${label} validity window was misnamed`);
  }

  const openEnded = windowText(
    render(
      [],
      record(
        "mem-open",
        { kind: "global" },
        { state: "verified", evidence: [] }
      )
    )
  );
  assert.equal(
    openEnded,
    undefined,
    "a claim with no window bounds must not claim one"
  );
});

test("the record's verification provenance is shown, not just held", () => {
  // Three fields answer "who confirmed this, and when" for the current-state
  // verification §11 asks the Console to surface, and they live in two places:
  // `checkedAt` and `verificationSource` on the validity, `lastVerifiedAt` on
  // the provenance. All three render only when present, and none of the three
  // was rendered by a test, so dropping any of them would have gone unnoticed —
  // and a record whose validity says "verified" with no date beside it looks
  // equally true whether it was confirmed last week or never.
  const verified = record(
    "mem-provenance",
    { kind: "global" },
    {
      state: "verified",
      checkedAt: TIMESTAMP,
      verificationSource: "git-and-rulesync",
      evidence: []
    }
  );
  const markup = render([], {
    ...verified,
    provenance: {
      ...verified.provenance,
      lastVerifiedAt: TIMESTAMP,
      verificationSource: "git-and-rulesync"
    }
  });

  assert.match(markup, /Checked at:/u);
  assert.match(markup, /Verification source: git-and-rulesync/u);
  assert.match(
    markup,
    /Last verified:/u,
    "the provenance-side verification date must be shown too"
  );

  // Never verified is not the same as not shown: a claim that has never been
  // checked carries no verification date at all, and must not borrow one.
  const neverChecked = render([], record("mem-never", { kind: "global" }));
  assert.equal(neverChecked.includes("Last verified:"), false);
  assert.equal(neverChecked.includes("Checked at:"), false);
});
