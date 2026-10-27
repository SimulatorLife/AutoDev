import assert from "node:assert/strict";
import test from "node:test";

import type { ControlApiWorkspaceRecord } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceDetailView } from "../src/features/workspaces/WorkspaceDetailView.ts";
import { WorkspacesView } from "../src/features/workspaces/WorkspacesView.ts";

/**
 * The canonical workspace catalog publishes the shared desired-vs-actual view.
 *
 * Every other canonical source in the Control API reports convergence with a
 * write: the operator is told whether the runtime holds what was written, or
 * whether it has not observed it yet. The workspace catalog was the one
 * canonical write that did not, so a saved configuration looked the same as a
 * configuration the runtime had actually picked up.
 *
 * These tests hold the two surfaces that edit the catalog to that contract:
 * the list and the workspace's own page both render the Runtime's verdict
 * rather than deciding one of their own.
 */

function workspace(id: string): ControlApiWorkspaceRecord {
  return {
    id,
    baseBranch: "main",
    enabled: true,
    agentRoles: null,
    configuration: { status: "configured" },
    runtime: { status: "not-observed" }
  } as ControlApiWorkspaceRecord;
}

function reconciliation(
  convergence: "converged" | "pending" | "error" | "not-observed"
): {
  readonly status: {
    readonly convergence: string;
    readonly desiredGeneration: string | null;
    readonly observedGeneration: string | null;
    readonly lastApplyAt: string | null;
    readonly lastObservationAt: string | null;
    readonly lastError: string | null;
    readonly explanation: string;
  };
  readonly history: readonly unknown[];
} {
  return {
    status: {
      convergence,
      desiredGeneration: "a".repeat(64),
      observedGeneration: convergence === "converged" ? "a".repeat(64) : null,
      lastApplyAt: "2026-10-07T00:00:00Z",
      lastObservationAt:
        convergence === "converged" ? "2026-10-07T00:00:05Z" : null,
      lastError: null,
      explanation: "The canonical catalog matches the desired state."
    },
    history: []
  };
}

test("the workspaces list renders the Runtime's verdict on the canonical catalog", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspacesView, {
      workspaces: [workspace("SimulatorLife/AutoDev")],
      approvals: new Map(),
      requests: new Map(),
      revision: "a".repeat(64),
      catalogStatus: "valid",
      reconciliation: reconciliation("converged")
    })
  );

  assert.match(
    markup,
    /data-feature="reconciliation"/u,
    "the list renders the shared reconciliation panel"
  );
  assert.match(markup, />Converged</u);
});

test("a catalog the runtime has not observed is not rendered as converged", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspacesView, {
      workspaces: [workspace("SimulatorLife/AutoDev")],
      approvals: new Map(),
      requests: new Map(),
      revision: "a".repeat(64),
      catalogStatus: "valid",
      reconciliation: reconciliation("not-observed")
    })
  );

  assert.match(markup, /data-feature="reconciliation"/u);
  assert.doesNotMatch(
    markup,
    />Converged</u,
    "an unobserved catalog must not read as converged"
  );
});

test("the workspace's own page renders the same verdict as the list", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspaceDetailView, {
      workspace: workspace("SimulatorLife/AutoDev"),
      approval: null,
      requests: undefined,
      revision: "a".repeat(64),
      catalogStatus: "valid",
      reconciliation: reconciliation("converged")
    })
  );

  assert.match(markup, /data-feature="reconciliation"/u);
  assert.match(markup, />Converged</u);
});

test("a surface with no reconciliation renders no panel rather than an empty one", () => {
  const markup = renderToStaticMarkup(
    React.createElement(WorkspacesView, {
      workspaces: [workspace("SimulatorLife/AutoDev")],
      approvals: new Map(),
      requests: new Map(),
      revision: "a".repeat(64),
      catalogStatus: "valid"
    })
  );

  assert.doesNotMatch(
    markup,
    /data-feature="reconciliation"/u,
    "no reconciliation means no panel, not a panel with nothing in it"
  );
});
