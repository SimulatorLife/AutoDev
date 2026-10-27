import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiProviderHealth,
  ControlApiProviderRecord,
  ControlApiProvidersResponse,
  ControlApiWorkspaceRecord,
  WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  countValue,
  observedTotal,
  scopedCount
} from "../src/components/status/observed-count.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge
} from "../src/components/status/StatusBadge.ts";
import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";
import { MemoryCohortsView } from "../src/features/memory/MemoryCohortsView.ts";
import { ProvidersView } from "../src/features/providers/ProvidersView.ts";
import {
  type WorkspaceApprovalLookup,
  WorkspacesView
} from "../src/features/workspaces/WorkspacesView.ts";

/**
 * A count the Console did not observe is not a count.
 *
 * The target state's state-correctness rule (`docs/autodev-console-target-state.md`,
 * "State correctness") says missing evidence stays explicit: never synthesize
 * zero, ready, converged or healthy because the telemetry is absent. A count is
 * where that rule was being broken most often, because a count over a scope
 * whose elements were only partly read still *looks* like a measurement: the
 * number is exactly right for the elements that were read and merely incomplete
 * for the ones that were not.
 *
 * Four surfaces were doing it, each in its own way:
 *
 * - the memory experience panel printed "0 observed injections" for a read that
 *   never answered;
 * - the memory cohort filter printed "0 cohort cells" for a read that never
 *   answered, beside panels saying the data was unavailable;
 * - the workspaces card counted an unreadable approval as "not approved", while
 *   the row badge beside it said "Unavailable";
 * - the providers card counted a provider whose health was never observed as
 *   unready, while the row badge beside it said "Not observed".
 *
 * The rule is stated once, in `console/src/components/status/observed-count.ts`,
 * and these tests hold each surface to it.
 */

/** A provider whose health was never observed: no success, no failure. */
function unobservedHealth(): ControlApiProviderHealth | null {
  return null;
}

/** A provider health record that proves a successful request. */
function readyHealth(): ControlApiProviderHealth {
  return {
    cooldown: null,
    failureStreak: 0,
    probeFailureStreak: 0,
    inFlightRequests: 0,
    activeAgents: 0,
    attempts: 4,
    successes: 4,
    failures: 0,
    lastSuccessAt: "2026-10-26T09:00:00.000Z",
    lastFailure: null
  };
}

function provider(
  id: string,
  health: ControlApiProviderHealth | null
): ControlApiProviderRecord {
  const roles = {
    default: roleAssignment(),
    smart: roleAssignment(),
    orchestrator: roleAssignment(),
    subagent: roleAssignment()
  };
  return {
    id,
    links: {
      usage: `https://usage.example.test/${id}`,
      documentation: `https://docs.example.test/${id}`
    },
    route: {
      pattern: "^(.*)$",
      baseUrl: "http://127.0.0.1:4000/v1",
      healthUrl: "http://127.0.0.1:4000/health/liveliness"
    },
    credential: { envKey: null, configured: true },
    disabled: false,
    roles,
    agentLimits: null,
    models: [],
    priorities: [],
    orchestratorReasoningEffort: null,
    health,
    reconciliation: {
      status: {
        convergence: "converged",
        desiredGeneration: `${id}:1`,
        observedGeneration: `${id}:1`,
        lastApplyAt: "2026-10-26T09:00:00.000Z",
        lastObservationAt: "2026-10-26T09:00:05.000Z",
        lastError: null,
        explanation: "Converged."
      },
      history: []
    }
  } as ControlApiProviderRecord;
}

/** One role's assignment: the row control reads the priority and the model. */
function roleAssignment(): {
  readonly priority: 1;
  readonly model: string | null;
  readonly mutable: boolean;
  readonly convergence: {
    readonly convergence: "converged";
    readonly desiredGeneration: string;
    readonly observedGeneration: string;
    readonly lastApplyAt: string;
    readonly lastObservationAt: string;
    readonly lastError: null;
    readonly explanation: string;
  };
} {
  return {
    priority: 1,
    model: null,
    mutable: true,
    convergence: {
      convergence: "converged",
      desiredGeneration: "default:1/sonnet",
      observedGeneration: "default:1/sonnet",
      lastApplyAt: "2026-10-26T09:00:00.000Z",
      lastObservationAt: "2026-10-26T09:00:05.000Z",
      lastError: null,
      explanation: "Converged."
    }
  };
}

function providersResponse(
  records: readonly ControlApiProviderRecord[]
): ControlApiProvidersResponse {
  return {
    schema: "autodev-control-providers-v3",
    orchestratorTier: "orchestrator",
    tiers: [{ tier: "default", groups: [[]] }],
    providers: records
  };
}

function renderProviders(records: readonly ControlApiProviderRecord[]): string {
  return renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: providersResponse(records),
      models: { status: "unavailable", message: "not read" },
      modelDiscovery: { status: "unavailable", message: "not read" }
    })
  );
}

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

/** An approval that was granted and never revoked. */
function activeApproval(workspaceId: string): WorkspacePlaytestApproval {
  return {
    schema: "autodev-workspace-playtest-approval-v2",
    workspaceId,
    revision: 1,
    approvalId: "11111111-1111-1111-1111-111111111111",
    checkoutRoot: "/home/operator/games/fixture",
    adapterImageDigest: `fixture/adapter@sha256:${"f".repeat(64)}`,
    workingDirectory: "server",
    adapterCommand: ["node", "server.js"],
    allowedScenarios: ["tutorial"],
    allowedPolicies: ["random"],
    limits: {
      cpuCores: 1,
      memoryBytes: 134_217_728,
      processCount: 2,
      wallTimeMs: 60_000,
      artifactBytes: 1_048_576,
      workerCount: 1,
      episodeCount: 10,
      maxStepsPerEpisode: 500,
      critiqueCount: 5
    },
    retentionDays: 30,
    issueReporting: "disabled",
    humanStudyAllowed: false,
    approvedAt: "2026-01-01T00:00:00.000Z",
    approvedBy: "operator",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
}

function renderWorkspaces(
  workspaces: readonly ControlApiWorkspaceRecord[],
  approvals: WorkspaceApprovalLookup
): string {
  return renderToStaticMarkup(
    React.createElement(WorkspacesView, {
      workspaces,
      approvals,
      requests: new Map(),
      revision: "a".repeat(64),
      catalogStatus: "valid"
    })
  );
}

/**
 * One stat card's own markup, so an assertion about a card's value cannot be
 * satisfied by a number somewhere else on the page.
 */
function statCard(markup: string, title: string): string {
  const start = markup.indexOf(`>${title}</dt>`);
  assert.notEqual(start, -1, `the ${title} card must be rendered`);
  const end = markup.indexOf("</dl>", start);
  assert.notEqual(end, -1, `the ${title} card must be closed`);
  return markup.slice(start, end);
}

function listScope(): MemoryListScope {
  return {
    tab: "cohorts",
    workspaceId: "SimulatorLife/AutoDev",
    offset: 0,
    limit: 25
  } as MemoryListScope;
}

function renderCohorts(sessionCohorts: unknown, useCohorts: unknown): string {
  return renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts,
      useCohorts,
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "simulatorlife/autodev",
      occurredFrom: "2026-10-01T00:00:00.000Z",
      occurredUntil: "2026-10-08T00:00:00.000Z",
      listScope: listScope()
    } as never)
  );
}

test("a count over a scope that was not fully observed is not a number", () => {
  const scope = [
    { observed: true, ready: true },
    { observed: false, ready: false },
    { observed: true, ready: false }
  ];

  const count = scopedCount(
    scope,
    (item) => item.observed,
    (item) => item.ready
  );

  assert.equal(count.value, 1, "the observed element that matches is counted");
  assert.equal(
    count.unobserved,
    1,
    "the unreadable element is counted as missing"
  );
  assert.equal(count.observed, false, "the scope was not observed in full");
  assert.equal(
    countValue(count),
    NOT_OBSERVED_LABEL,
    "an incomplete count must not be shown as the scope's count"
  );
});

test("a fully observed scope counts as a number, including a measured zero", () => {
  const count = scopedCount(
    [
      { observed: true, ready: false },
      { observed: true, ready: false }
    ],
    (item) => item.observed,
    (item) => item.ready
  );

  assert.equal(count.value, 0);
  assert.equal(count.observed, true);
  assert.equal(
    countValue(count),
    0,
    "a measured zero is a measurement and stays a number"
  );
});

test("a measurement that was never taken is not a zero", () => {
  assert.equal(observedTotal(null).observed, false);
  assert.equal(observedTotal(undefined).observed, false);
  assert.equal(observedTotal(null).value, null);

  const measured = observedTotal(0);
  assert.equal(measured.observed, true);
  assert.equal(measured.value, 0);
});

test("a provider whose health was never observed does not make the Ready count a zero", () => {
  const markup = renderProviders([
    provider("ready", readyHealth()),
    provider("unobserved", unobservedHealth())
  ]);

  // The row badge is honest about it...
  assert.match(
    markup,
    /data-status="not-observed"/u,
    "the provider whose health was never observed must read as not observed"
  );
  // ...so the count above the table may not claim the other one is unready.
  const card = statCard(markup, "Ready");
  assert.match(
    card,
    /Not observed/u,
    "the Ready card must say its scope was not observed"
  );
  assert.doesNotMatch(
    card,
    />1</u,
    "the Ready card must not count an unobserved provider as unready"
  );
  assert.match(card, /Provider readiness was not observed/u);
});

test("a provider set whose readiness was all observed still counts as a number", () => {
  const markup = renderProviders([
    provider("ready", readyHealth()),
    provider("also-ready", readyHealth())
  ]);

  const card = statCard(markup, "Ready");
  assert.match(card, />2</u, "a fully observed scope keeps its count");
  assert.match(card, /of 2 providers/u);
  assert.doesNotMatch(
    card,
    /Not observed/u,
    "a fully observed scope must keep its count"
  );
});

test("an unreadable workspace approval does not make the approved count a zero", () => {
  const markup = renderWorkspaces(
    [workspace("SimulatorLife/FixtureGame")],
    new Map([["SimulatorLife/FixtureGame", "unavailable"]])
  );

  assert.match(
    markup,
    /data-status="unavailable"/u,
    "the row badge must say the approval could not be read"
  );
  assert.doesNotMatch(
    markup,
    /Active checkout approvals/u,
    "the card must not claim an approval count it could not read"
  );
  assert.match(markup, /Approval state was not observed/u);
});

test("a readable workspace approval still counts as a number", () => {
  const markup = renderWorkspaces(
    [workspace("SimulatorLife/FixtureGame")],
    new Map([
      ["SimulatorLife/FixtureGame", activeApproval("SimulatorLife/FixtureGame")]
    ])
  );

  assert.match(markup, /Active checkout approvals/u);
  assert.doesNotMatch(
    markup,
    /Approval state was not observed/u,
    "a fully observed scope must keep its count"
  );
});

test("a failed cohort read does not make the cell count a zero", () => {
  const markup = renderCohorts(null, null);

  assert.doesNotMatch(
    markup,
    /0 cohort cells/u,
    "a failed read must not be rendered as an empty matrix"
  );
  assert.match(markup, /Cohort cells unavailable/u);
});

test("an observed but empty cohort matrix is still a measured zero", () => {
  const emptySessionCohorts = {
    schema: "autodev-memory-session-outcome-cohorts-v1",
    workspaceId: "SimulatorLife/AutoDev",
    repositoryId: "simulatorlife/autodev",
    occurredFrom: "2026-10-01T00:00:00.000Z",
    occurredUntil: "2026-10-08T00:00:00.000Z",
    cells: [],
    sessionCount: 0,
    reportedSessionCount: 0,
    unreportedSessionCount: 0,
    conflictingOutcomeSessionCount: 0,
    mixedModeSessionCount: 0
  };
  const emptyUseCohorts = {
    schema: "autodev-memory-injection-use-cohorts-v1",
    workspaceId: "SimulatorLife/AutoDev",
    repositoryId: "simulatorlife/autodev",
    occurredFrom: "2026-10-01T00:00:00.000Z",
    occurredUntil: "2026-10-08T00:00:00.000Z",
    cells: [],
    exposureCount: 0,
    assessedExposureCount: 0,
    unassessedExposureCount: 0
  };

  const markup = renderCohorts(emptySessionCohorts, emptyUseCohorts);

  assert.match(
    markup,
    /0 cohort cells/u,
    "a measured empty matrix is a measurement and stays a number"
  );
  assert.doesNotMatch(markup, /Cohort cells unavailable/u);
});

test("the shared not-observed label is the word the Console already uses", () => {
  // The count's fallback is the product's own vocabulary, not a new one.
  assert.equal(NOT_OBSERVED_LABEL, "Not observed");
  assert.match(
    renderToStaticMarkup(
      React.createElement(StatusBadge, {
        status: "not-observed",
        label: NOT_OBSERVED_LABEL
      })
    ),
    /Not observed/u
  );
});
