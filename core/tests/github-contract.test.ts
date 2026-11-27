import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_GITHUB_SCHEMA_ID,
  controlApiGithubResponseSchema
} from "../src/control-api/github.ts";

/**
The Control API GitHub contract.

The Runtime produces this response and the Console reads it. One schema,
owned by Core, answers for both -- so these tests are the contract: every
shape the Console's old hand-written guards refused is still refused here,
and the rows those guards let through unchecked are now checked too.
*/
const WORKFLOW_ROW = {
  id: "_scheduler.yml",
  name: "Scheduler",
  path: ".github/workflows/_scheduler.yml",
  events: ["schedule", "workflow_dispatch"],
  schedules: ["*/15 * * * *"]
};

const OBSERVED_ROW = {
  ...WORKFLOW_ROW,
  actionsState: "active",
  actionsWorkflowId: 42,
  actionsHtmlUrl: "https://github.com/o/r/actions/workflows/_scheduler.yml",
  recentRunsCount: 1,
  lastRunStatus: "completed",
  lastRunConclusion: "success",
  lastRunCreatedAt: "2026-11-26T12:00:00Z",
  lastRunHtmlUrl: "https://github.com/o/r/actions/runs/7"
};

const RUN = {
  id: 7,
  name: "Scheduler",
  workflowId: 42,
  workflowPath: ".github/workflows/_scheduler.yml",
  headBranch: "main",
  headSha: "abc123",
  event: "schedule",
  status: "completed",
  conclusion: "success",
  htmlUrl: "https://github.com/o/r/actions/runs/7",
  createdAt: "2026-11-26T12:00:00Z",
  updatedAt: "2026-11-26T12:01:00Z",
  runAttempt: 1
};

const STATS = {
  totalRuns: 1,
  successfulRuns: 1,
  failedRuns: 0,
  inProgressRuns: 0,
  cancelledRuns: 0,
  successRate: 1
};

function unavailableResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: CONTROL_API_GITHUB_SCHEMA_ID,
    source: ".github/workflows",
    readOnly: true,
    catalogStatus: "valid",
    totalWorkflows: 1,
    workflows: [WORKFLOW_ROW],
    runtimeFactsAvailable: false,
    runtimeStatus: "unavailable",
    runtimeMessage: "AUTODEV_GITHUB_TOKEN is not configured.",
    repository: null,
    stats: null,
    recentRuns: null,
    ...overrides
  };
}

function observedResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return unavailableResponse({
    workflows: [OBSERVED_ROW],
    runtimeFactsAvailable: true,
    runtimeStatus: "available",
    runtimeMessage: null,
    repository: "o/r",
    stats: STATS,
    recentRuns: [RUN],
    ...overrides
  });
}

function isAccepted(value: unknown): boolean {
  return controlApiGithubResponseSchema.safeParse(value).success;
}

test("the GitHub contract accepts both the observed and the unavailable read", () => {
  assert.equal(isAccepted(unavailableResponse()), true);
  assert.equal(isAccepted(observedResponse()), true);
  // A read that happened and found no runs is a measured zero, not absence.
  assert.equal(isAccepted(observedResponse({ recentRuns: [] })), true);
  assert.equal(
    isAccepted(observedResponse({ stats: { ...STATS, successRate: null } })),
    true
  );
  // A catalog that cannot be read says so instead of listing nothing.
  assert.equal(
    isAccepted(
      unavailableResponse({
        catalogStatus: "invalid",
        totalWorkflows: null,
        workflows: [],
        runtimeStatus: "invalid"
      })
    ),
    true
  );
  // A workflow without a declared `name:` is still a row.
  assert.equal(
    isAccepted(
      unavailableResponse({ workflows: [{ ...WORKFLOW_ROW, name: null }] })
    ),
    true
  );
});

test("the GitHub contract refuses a drifted envelope", () => {
  const refused: readonly [string, Record<string, unknown>][] = [
    ["another schema", { schema: "autodev-control-github-v2" }],
    ["a non-string source", { source: 1 }],
    ["a non-boolean readOnly", { readOnly: "true" }],
    ["an unknown catalog status", { catalogStatus: "partial" }],
    ["a string total", { totalWorkflows: "1" }],
    ["an unknown runtime status", { runtimeStatus: "degraded" }],
    ["a non-string runtime message", { runtimeMessage: 1 }],
    ["a non-string repository", { repository: 1 }],
    ["a runs field that is neither null nor a list", { recentRuns: "none" }],
    ["a workflows field that is not a list", { workflows: null }]
  ];
  for (const [label, overrides] of refused) {
    assert.equal(isAccepted(unavailableResponse(overrides)), false, label);
  }
  for (const field of ["runtimeFactsAvailable", "recentRuns", "stats"]) {
    const response = unavailableResponse();
    delete response[field];
    assert.equal(isAccepted(response), false, `missing ${field}`);
  }
});

test("the GitHub contract refuses unreadable run statistics", () => {
  // An empty record rendered `NaN%` and an empty stat card.
  assert.equal(isAccepted(observedResponse({ stats: {} })), false);
  for (const field of Object.keys(STATS)) {
    const stats: Record<string, unknown> = { ...STATS };
    delete stats[field];
    assert.equal(
      isAccepted(observedResponse({ stats })),
      false,
      `stats without ${field}`
    );
  }
  assert.equal(
    isAccepted(observedResponse({ stats: { ...STATS, totalRuns: "1" } })),
    false
  );
});

test("the GitHub contract refuses a workflow row the view cannot render", () => {
  for (const field of ["id", "name", "path", "events", "schedules"]) {
    const row: Record<string, unknown> = { ...WORKFLOW_ROW };
    delete row[field];
    assert.equal(
      isAccepted(unavailableResponse({ workflows: [row] })),
      false,
      `a row without ${field}`
    );
  }
  assert.equal(
    isAccepted(
      unavailableResponse({ workflows: [{ ...WORKFLOW_ROW, events: [1] }] })
    ),
    false
  );
  assert.equal(
    isAccepted(
      unavailableResponse({
        workflows: [{ ...OBSERVED_ROW, actionsState: "paused" }]
      })
    ),
    false
  );
  // An optional observed field is absent or a value, never explicitly undefined.
  assert.equal(
    isAccepted(
      unavailableResponse({
        workflows: [{ ...WORKFLOW_ROW, actionsWorkflowId: undefined }]
      })
    ),
    false
  );
});

test("the GitHub contract refuses a recent run the view cannot render", () => {
  assert.equal(isAccepted(observedResponse({ recentRuns: [{}] })), false);
  assert.equal(
    isAccepted(observedResponse({ recentRuns: [{ ...RUN, id: "7" }] })),
    false
  );
});
