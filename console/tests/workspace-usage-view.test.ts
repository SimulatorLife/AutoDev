import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { UsageWorkspaceRequestBreakdown } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type WorkspaceRequestLookup,
  workspaceRequestLookup,
  workspaceRequestValue
} from "../src/features/workspaces/workspace-usage.ts";
import { workspaceRequestReadings } from "../src/features/workspaces/WorkspaceRequestTelemetry.ts";
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

/**
 * The telemetry answer the browser holds.
 *
 * The island reads the breakdown in the browser, so the answer it holds is
 * the payload the endpoint answers with, and the readings it resolves are
 * the rows' own.
 */
function readyTelemetry(
  source: Parameters<typeof workspaceRequestLookup>[0]
): ReturnType<typeof workspaceRequestReadings> {
  return workspaceRequestReadings(
    {
      status: "ready",
      payload: {
        schema: "autodev-console-usage-v1",
        scope: "workspace-requests",
        source
      }
    },
    [WORKSPACE_ID, OTHER_WORKSPACE_ID]
  );
}

function renderWorkspaces(): string {
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
      revision: "a".repeat(64),
      catalogStatus: "valid"
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

test("the Requests cell renders the count and the two kinds of absence", () => {
  const observed = renderToStaticMarkup(
    workspaceRequestValue({ kind: "observed", count: 7 })
  );
  assert.match(observed, /data-workspace-requests="observed"/u);
  assert.match(observed, />7</u);

  const unavailable = renderToStaticMarkup(
    workspaceRequestValue({ kind: "unavailable" })
  );
  assert.match(unavailable, /data-workspace-requests="unavailable"/u);
  assert.match(unavailable, />Unavailable</u);

  const notObserved = renderToStaticMarkup(
    workspaceRequestValue({ kind: "not-observed" })
  );
  assert.match(notObserved, /data-workspace-requests="not-observed"/u);
  assert.match(notObserved, />Not observed</u);
});

test("a reading that has not arrived is pending, and pending is not zero", () => {
  // The read happens in the browser, so the cell has a state in which it has
  // no number yet. That state is its own state: rendering it as a zero would
  // report a measurement of no requests that nobody made.
  const pending = renderToStaticMarkup(
    workspaceRequestValue({ kind: "pending" })
  );

  assert.match(pending, /data-workspace-requests="pending"/u);
  assert.match(pending, /aria-busy="true"/u);
  assert.doesNotMatch(pending, />0</u);
});

test("the rows are pending until the breakdown arrives", () => {
  const pending = workspaceRequestReadings(
    { status: "pending" },
    [WORKSPACE_ID, OTHER_WORKSPACE_ID]
  );

  assert.deepEqual(pending.get(WORKSPACE_ID), { kind: "pending" });
  assert.deepEqual(pending.get(OTHER_WORKSPACE_ID), { kind: "pending" });
});

test("a read that failed leaves every row unavailable, not empty", () => {
  // A source the Console could not read is a source that reported nothing.
  // The rows must say so rather than render a zero.
  const unavailable = workspaceRequestReadings(
    { status: "unavailable" },
    [WORKSPACE_ID, OTHER_WORKSPACE_ID]
  );

  assert.deepEqual(unavailable.get(WORKSPACE_ID), { kind: "unavailable" });
  assert.deepEqual(unavailable.get(OTHER_WORKSPACE_ID), { kind: "unavailable" });
});

test("the breakdown the endpoint answered with resolves every row", () => {
  const readings = readyTelemetry({
    kind: "observed",
    breakdown: breakdown([{ workspace: WORKSPACE_ID, count: 7 }])
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

test("the list renders the pending state until the answer arrives", () => {
  const markup = renderWorkspaces();

  // The page's own content is not waiting on the telemetry read, so the rows
  // are on screen with their numbers still to come.
  assert.match(markup, /data-workspace-requests="pending"/u);
  assert.match(markup, /aria-busy="true"/u);
  assert.doesNotMatch(
    markup,
    /data-workspace-requests="observed"/u,
    "a row renders no measurement before the measurement arrives"
  );
});

test("the workspaces page does not await a Usage read", () => {
  // The page's own subject is the workspace catalogue, and the catalogue is
  // answered in milliseconds while the Usage telemetry read is answered in
  // minutes. The read belongs to the browser, and a page that awaited it
  // would hold every navigation to /workspaces for the length of a telemetry
  // fan-out.
  const source = readFileSync(
    new URL("../app/workspaces/page.tsx", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(
    source,
    /readWorkspaceRequest|loadOpenLITUsage|readUsageTelemetry/u,
    "the page starts a Usage read the navigation then waits for"
  );
});

test("the workspace detail page does not await a Usage read", () => {
  const source = readFileSync(
    new URL(
      "../app/workspaces/[owner]/[repository]/page.tsx",
      import.meta.url
    ),
    "utf8"
  );

  assert.doesNotMatch(
    source,
    /readWorkspaceRequest|loadOpenLITUsage|readUsageTelemetry/u,
    "the page starts a Usage read the navigation then waits for"
  );
});

function renderDetail(): string {
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
      visualTargets: null
    })
  );
}

test("the workspace detail shows the same aggregate usage the list shows", () => {
  const markup = renderDetail();

  // The detail renders the value the list renders, from the same reading, so
  // the two surfaces cannot drift into different vocabularies for the same
  // fact.
  assert.match(markup, /Requests \(24h\)/u);
  assert.match(markup, /data-workspace-requests="pending"/u);
});
