import assert from "node:assert/strict";
import test from "node:test";

import type { UsageWorkspaceRequestBreakdown } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type WorkspaceRequestLookup,
  workspaceRequestLookup
} from "../src/features/workspaces/workspace-usage.ts";
import { WorkspaceDetailView } from "../src/features/workspaces/WorkspaceDetailView.ts";
import { WorkspacesView } from "../src/features/workspaces/WorkspacesView.ts";

const WORKSPACE_ID = "SimulatorLife/FixtureGame";
const OTHER_WORKSPACE_ID = "SimulatorLife/OtherGame";

function breakdown(
  rows: UsageWorkspaceRequestBreakdown["rows"],
  partial = false
): UsageWorkspaceRequestBreakdown {
  return { rows, partial };
}

function lookup(
  source: Parameters<typeof workspaceRequestLookup>[0],
  workspaceIds: readonly string[] = [WORKSPACE_ID, OTHER_WORKSPACE_ID]
): WorkspaceRequestLookup {
  return workspaceRequestLookup(source, workspaceIds);
}

function renderWorkspaces(requests: WorkspaceRequestLookup): string {
  return renderToStaticMarkup(
    React.createElement(WorkspacesView, {
      workspaces: [
        {
          id: WORKSPACE_ID,
          baseBranch: "main",
          enabled: true,
          agentRoles: null,
          configuration: { status: "configured" },
          runtime: { status: "not-observed" }
        },
        {
          id: OTHER_WORKSPACE_ID,
          baseBranch: "main",
          enabled: true,
          agentRoles: null,
          configuration: { status: "configured" },
          runtime: { status: "not-observed" }
        }
      ],
      approvals: new Map(),
      requests
    })
  );
}

test("a measured count is reported for the workspace that made the requests", () => {
  const readings = lookup({
    kind: "observed",
    breakdown: breakdown([{ workspace: WORKSPACE_ID, count: 7 }])
  });

  assert.deepEqual(readings.get(WORKSPACE_ID), {
    kind: "observed",
    count: 7
  });
});

test("a workspace absent from a complete breakdown is a measured zero, not a gap", () => {
  // The breakdown lists every workspace that made a request, so a complete
  // breakdown that omits one is evidence that it made none. Reporting it as
  // unobserved would hide a real measurement; reporting it as unavailable
  // would claim the source failed.
  const readings = lookup({
    kind: "observed",
    breakdown: breakdown([{ workspace: WORKSPACE_ID, count: 7 }])
  });

  assert.deepEqual(readings.get(OTHER_WORKSPACE_ID), {
    kind: "observed",
    count: 0
  });
});

test("a workspace absent from a truncated breakdown stays unobserved", () => {
  // The source's own row limit truncated the breakdown, so a workspace that
  // is not in it was not reported -- it may have made requests that the limit
  // cut off. Reading it as zero would report a measurement nobody made.
  const readings = lookup({
    kind: "observed",
    breakdown: breakdown([{ workspace: WORKSPACE_ID, count: 7 }], true)
  });

  assert.deepEqual(readings.get(OTHER_WORKSPACE_ID), {
    kind: "not-observed"
  });
  assert.deepEqual(readings.get(WORKSPACE_ID), {
    kind: "observed",
    count: 7
  });
});

test("requests without workspace attribution are counted in no workspace", () => {
  const readings = lookup({
    kind: "observed",
    breakdown: breakdown([
      { workspace: WORKSPACE_ID, count: 7 },
      { workspace: null, count: 3 }
    ])
  });

  assert.deepEqual(readings.get(WORKSPACE_ID), {
    kind: "observed",
    count: 7
  });
  assert.deepEqual(readings.get(OTHER_WORKSPACE_ID), {
    kind: "observed",
    count: 0
  });
});

test("an unread source is unavailable, not an observed absence", () => {
  const readings = lookup({ kind: "unavailable" });

  assert.deepEqual(readings.get(WORKSPACE_ID), { kind: "unavailable" });
  assert.deepEqual(readings.get(OTHER_WORKSPACE_ID), { kind: "unavailable" });
});

test("a source that read but reported no breakdown is not observed", () => {
  const readings = lookup({ kind: "not-observed" });

  assert.deepEqual(readings.get(WORKSPACE_ID), { kind: "not-observed" });
  assert.deepEqual(readings.get(OTHER_WORKSPACE_ID), { kind: "not-observed" });
});

test("the Requests column renders the count and the two kinds of absence", () => {
  const markup = renderWorkspaces(
    lookup({
      kind: "observed",
      breakdown: breakdown([
        { workspace: WORKSPACE_ID, count: 7 },
        { workspace: OTHER_WORKSPACE_ID, count: 0 }
      ])
    })
  );

  assert.match(markup, /data-workspace-requests="observed"/u);
  assert.match(markup, />7</u);
  // The measured zero is rendered as a zero, not as an absence.
  assert.match(markup, /data-workspace-requests="observed"[^>]*>0</u);
  assert.doesNotMatch(
    markup,
    /data-workspace-requests="not-observed"/u,
    "a measured zero is not an absence"
  );
});

test("the Requests column says why there is no count", () => {
  const unavailable = renderWorkspaces(lookup({ kind: "unavailable" }));
  assert.match(unavailable, /data-workspace-requests="unavailable"/u);
  assert.match(unavailable, />Unavailable</u);

  const notObserved = renderWorkspaces(lookup({ kind: "not-observed" }));
  assert.match(notObserved, /data-workspace-requests="not-observed"/u);
  assert.match(notObserved, />Not observed</u);
});

function renderDetail(
  requests: Parameters<typeof WorkspaceDetailView>[0]["requests"]
): string {
  return renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: true,
        agentRoles: null,
        configuration: { status: "configured" },
        runtime: { status: "not-observed" }
      },
      approval: null,
      visualTargets: null,
      requests
    })
  );
}

test("the workspace detail shows the same aggregate usage the list shows", () => {
  const markup = renderDetail({ kind: "observed", count: 12 });

  // The detail page renders the value the list renders, from the same
  // reading, so the two surfaces cannot drift into different vocabularies
  // for the same fact.
  assert.match(markup, /Requests \(24h\)/u);
  assert.match(markup, /data-workspace-requests="observed"/u);
  assert.match(markup, />12</u);
});

test("the workspace detail says why there is no aggregate usage count", () => {
  const unavailable = renderDetail({ kind: "unavailable" });
  assert.match(unavailable, /data-workspace-requests="unavailable"/u);
  assert.match(unavailable, />Unavailable</u);

  const notObserved = renderDetail({ kind: "not-observed" });
  assert.match(notObserved, /data-workspace-requests="not-observed"/u);
  assert.match(notObserved, />Not observed</u);
});
