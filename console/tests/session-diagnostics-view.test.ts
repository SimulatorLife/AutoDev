import assert from "node:assert/strict";
import test from "node:test";

import {
  isSessionDiagnosticsReport,
  isSessionFleetScanResponse
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DIAGNOSTICS_SESSION_ID,
  fleetScanResponse,
  sessionDiagnosticsReport
} from "../e2e/session-diagnostics-fixture.ts";
import {
  InlineDisplayToggle,
  nextRepresentationIndex
} from "../src/components/ui/InlineDisplayToggle.ts";
import {
  measureRepresentations,
  measureText
} from "../src/components/ui/measure.ts";
import {
  SessionDiagnosticsView,
  type SessionDiagnosticsViewState
} from "../src/features/usage/SessionDiagnosticsView.ts";
import { UsageFleetDiagnosticsView } from "../src/features/usage/UsageFleetDiagnosticsView.ts";

function render(
  tab: string,
  threadId?: string,
  report = sessionDiagnosticsReport()
): string {
  assert.ok(isSessionDiagnosticsReport(report));
  const state: SessionDiagnosticsViewState = {
    sessionId: DIAGNOSTICS_SESSION_ID,
    range: "24H",
    tab,
    spanOffset: 0,
    spanLimit: 50,
    spanSort: "desc",
    eventsOffset: 0,
    eventsLimit: 50,
    itemsOffset: 0,
    itemsLimit: 50,
    threadId,
    failureCategory: undefined
  };
  return renderToStaticMarkup(
    SessionDiagnosticsView({
      state,
      report,
      diagnosticsFailure: null,
      spans: null,
      spansFailure: null,
      spanHrefFor: () => "/usage"
    })
  );
}

test("the threads table shows authoritative per-thread routed providers", () => {
  const report = sessionDiagnosticsReport();
  assert.ok(isSessionDiagnosticsReport(report));
  const summary = report.router[0];
  assert.ok(summary);
  const markup = render("overview");
  for (const header of ["Role", "Routed provider(s)", "Model"]) {
    assert.ok(markup.includes(`>${header}<`));
  }
  assert.match(markup, />orchestrator</);
  // A thread the router saw shows the upstream models it was served by...
  assert.match(markup, />gemini → sonnet</);
  // ...and one it did not see falls back to the model Codex requested.
  assert.match(markup, />autodev\/orchestrator</);
  assert.match(markup, />antigravity → claude</);
  assert.doesNotMatch(markup, />local_model_router</);
});

test("the session token card separates new input from cache re-reads", () => {
  const markup = render("overview");
  assert.match(markup, />Total tokens</);
  assert.match(markup, /6,000 new \+ 4,000 cached in \/ 2,000 out/);
});

test("model-window router matches are explicitly identified instead of called partial evidence", () => {
  const report = sessionDiagnosticsReport();
  assert.ok(isSessionDiagnosticsReport(report));
  const summary = report.router[0];
  assert.ok(summary);
  const markup = renderToStaticMarkup(
    SessionDiagnosticsView({
      state: {
        sessionId: DIAGNOSTICS_SESSION_ID,
        range: "24H",
        tab: "overview",
        spanOffset: 0,
        spanLimit: 50,
        spanSort: "desc",
        eventsOffset: 0,
        eventsLimit: 50,
        itemsOffset: 0,
        itemsLimit: 50,
        threadId: undefined,
        failureCategory: undefined
      },
      report: {
        ...report,
        router: [{ ...summary, matchedBy: "model-window" }]
      },
      diagnosticsFailure: null,
      spans: null,
      spansFailure: null,
      spanHrefFor: () => "/usage"
    })
  );
  assert.match(markup, /matched by model\/time window/);
  assert.doesNotMatch(markup, /partial evidence/);
});

test("an unknown provider remains visible as a gap in the routed sequence", () => {
  const report = sessionDiagnosticsReport();
  assert.ok(isSessionDiagnosticsReport(report));
  const summary = report.router[0];
  assert.ok(summary);
  const markup = render("overview", undefined, {
    ...report,
    router: [{ ...summary, providerSequence: ["claude", "?", "openai"] }]
  });
  assert.match(markup, />claude → Unknown provider → openai</);
  const requestMarkup = render("requests", undefined, {
    ...report,
    router: [{ ...summary, providerSequence: ["claude", "?", "openai"] }]
  });
  assert.match(requestMarkup, />claude → Unknown provider → openai</);
});

test("a thread with no observed provider reads Not observed", () => {
  const report = sessionDiagnosticsReport();
  assert.ok(isSessionDiagnosticsReport(report));
  const state = {
    sessionId: DIAGNOSTICS_SESSION_ID,
    range: "24H",
    tab: "overview",
    spanOffset: 0,
    spanLimit: 50,
    spanSort: "desc",
    eventsOffset: 0,
    eventsLimit: 50,
    itemsOffset: 0,
    itemsLimit: 50,
    threadId: undefined,
    failureCategory: undefined
  } as const satisfies SessionDiagnosticsViewState;
  const [first, ...rest] = report.threads;
  assert.ok(first);
  const markup = renderToStaticMarkup(
    SessionDiagnosticsView({
      state,
      report: {
        ...report,
        threads: [{ ...first, modelProvider: null, model: null }, ...rest],
        router: []
      },
      diagnosticsFailure: null,
      spans: null,
      spansFailure: null,
      spanHrefFor: () => "/usage"
    })
  );
  assert.ok((markup.match(/Not observed/g) ?? []).length >= 2);
});

test("the initial developer prompt is a keyboard-operable inline toggle starting in bytes", () => {
  const markup = render("threads", "01a0ba16-d54c-78f2-9367-3f80e9a8f75f");
  assert.match(
    markup,
    /<button[^>]*data-inline-display-toggle="initial-developer-prompt"/
  );
  assert.match(markup, /type="button"/);
  assert.match(markup, /decoration-dotted/);
  assert.match(markup, /cursor-pointer/);
  assert.match(markup, /data-representation="bytes"[^>]*>1,200 bytes</);
  assert.match(markup, /Activate to show characters\./);
});

test("the inline toggle cycles bytes, characters, tokens and never invents a missing count", () => {
  assert.equal(nextRepresentationIndex(0, 3), 1);
  assert.equal(nextRepresentationIndex(1, 3), 2);
  assert.equal(nextRepresentationIndex(2, 3), 0);
  const bytes = { id: "bytes", value: 1200 } as const;
  const chars = { id: "characters", value: null } as const;
  assert.equal(measureText(bytes), "1,200 bytes");
  assert.equal(measureText({ ...bytes, value: 1 }), "1 byte");
  assert.equal(measureText(chars), "Not observed (characters)");
  const markup = renderToStaticMarkup(
    React.createElement(InlineDisplayToggle, {
      label: "Size",
      representations: measureRepresentations([bytes, chars])
    })
  );
  assert.doesNotMatch(markup, /characters<\//);
});

test("each thread lists the skills it read and the session lists which threads used each skill", () => {
  const overview = render("overview");
  assert.match(overview, />Skill usage</);
  assert.match(overview, /autodev-session-diagnostics/);
  assert.match(overview, /1 read/);
  assert.match(overview, /ImplementationCoder/);
  const detail = render("threads", "01a0ba16-d54c-78f2-9367-3f80e9a8f75f");
  assert.match(detail, /Skills loaded by root/);
  assert.match(detail, /\/repo\/\.agents\/skills: 2/);
});

test("SessionDiagnosticsView renders the observed client surface and falls back to Not observed", () => {
  const observed = render("overview");
  assert.match(observed, />CLI version<\/dt><dd[^>]*>0\.169\.0</);
  assert.match(observed, />Client<\/dt><dd[^>]*>Codex app</);

  const base = sessionDiagnosticsReport();
  assert.ok(isSessionDiagnosticsReport(base));
  const unobserved = render("overview", undefined, {
    ...base,
    clientSurface: null
  });
  assert.match(unobserved, />Client<\/dt><dd[^>]*>Not observed</);
});

test("UsageFleetDiagnosticsView recent sessions table renders a Client column", () => {
  const scan = fleetScanResponse();
  assert.ok(isSessionFleetScanResponse(scan));
  const unobservedRow = {
    ...scan.sessions[0]!,
    id: "01a0ba20-d54c-78f2-9367-3f80e9a8f75f",
    clientSurface: null
  };
  const markup = renderToStaticMarkup(
    UsageFleetDiagnosticsView({
      view: "sessions",
      range: "24H",
      scan: { ...scan, sessions: [scan.sessions[0]!, unobservedRow] },
      scanFailure: null,
      hooks: null,
      hooksFailure: null,
      hooksSinceDays: 7
    })
  );
  assert.match(markup, />Client</);
  assert.match(markup, />Codex app</);
  assert.match(markup, />Not observed</);
});
