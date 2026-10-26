import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceDetailView } from "../src/features/workspaces/WorkspaceDetailView.ts";
import { WorkspacesView } from "../src/features/workspaces/WorkspacesView.ts";

/**
 * The one control that writes a workspace's canonical configuration.
 *
 * The control appears twice -- on the workspace's row on the list and on the
 * workspace's own page -- and these cases pin that it is one control: the
 * same fields, the same route, the same revision check and the same disabled
 * reason in both places. A second implementation would pass a test that only
 * looked at one of them, which is why both are rendered here.
 */

const WORKSPACE_ID = "SimulatorLife/AutoDev";
const REVISION = "a".repeat(64);
const CONFIGURATION_ACTION = `/api/workspaces/SimulatorLife/AutoDev`;

const WORKSPACE = {
  id: WORKSPACE_ID,
  baseBranch: "main",
  enabled: true,
  agentRoles: null,
  configuration: { status: "configured" },
  runtime: { status: "not-observed" }
} as const;

function listMarkup(revision: string | null = REVISION): string {
  return renderToStaticMarkup(
    React.createElement(WorkspacesView, {
      workspaces: [WORKSPACE],
      approvals: new Map(),
      requests: new Map(),
      revision,
      catalogStatus: revision === null ? "unavailable" : "valid"
    })
  );
}

function detailMarkup(revision: string | null = REVISION): string {
  return renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: WORKSPACE,
      approval: null,
      revision,
      catalogStatus: revision === null ? "unavailable" : "valid"
    })
  );
}

/** The fields one rendered control carries. */
function controlFields(markup: string): {
  readonly action: string | undefined;
  readonly fields: readonly string[];
} {
  const form = markup.match(
    /<form[^>]*data-workspace-configuration="[^"]*"[^>]*>[\s\S]*?<\/form>/u
  );
  assert.ok(form, "the control renders a form");
  const action = form[0]?.match(/action="([^"]*)"/u)?.[1];
  const fields = Array.from(
    (form[0] ?? "").matchAll(/<(?:input|select)[^>]*name="([^"]+)"/gu),
    (match) => match[1] ?? ""
  );
  return { action, fields };
}

test("the list row and the workspace's own page carry the same control", () => {
  const list = controlFields(listMarkup());
  const detail = controlFields(detailMarkup());

  assert.equal(list.action, CONFIGURATION_ACTION);
  assert.equal(detail.action, CONFIGURATION_ACTION);
  assert.deepEqual([...list.fields].sort(), [...detail.fields].sort());
  // The control writes a workspace's whole configuration: enablement, base
  // branch and role scope, and the revision the write is compared against.
  assert.deepEqual([...new Set(list.fields)].sort(), [
    "agentRoles",
    "agentRolesMode",
    "baseBranch",
    "enabled",
    "expectedRevision",
    "returnTo"
  ]);
});

test("the control carries the revision the write is compared against", () => {
  for (const markup of [listMarkup(), detailMarkup()]) {
    assert.match(
      markup,
      new RegExp(
        `<input type="hidden" name="expectedRevision" value="${REVISION}"`,
        "u"
      )
    );
  }
});

test("the control posts to the same-origin route and names where the write answers to", () => {
  assert.match(
    listMarkup(),
    /action="\/api\/workspaces\/SimulatorLife\/AutoDev"/u
  );
  assert.match(listMarkup(), /name="returnTo" value="\/workspaces"/u);
  assert.match(
    detailMarkup(),
    /name="returnTo" value="\/workspaces\/SimulatorLife\/AutoDev"/u
  );
});

test("a catalog that could not be read leaves the control in place, disabled, with the reason", () => {
  for (const markup of [listMarkup(null), detailMarkup(null)]) {
    assert.match(markup, /data-workspace-configuration-disabled="true"/u);
    assert.match(markup, /The canonical workspace catalog could not be read/u);
    // The fields are still there and still carry their values: a control
    // that disappears is a control the operator cannot find.
    assert.match(markup, /name="baseBranch"/u);
    assert.match(markup, /disabled/u);
  }
});

test("the control writes the configuration it was filled from", () => {
  const markup = listMarkup();
  assert.match(markup, /name="baseBranch"[^>]*value="main"/u);
  assert.match(markup, /name="enabled"/u);
  assert.match(markup, /Any role may work here/u);
});
