import assert from "node:assert/strict";
import test from "node:test";

import { isSessionDiagnosticsReport } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DIAGNOSTICS_SESSION_ID,
  sessionDiagnosticsReport
} from "../e2e/session-diagnostics-fixture.ts";
import {
  InlineDisplayToggle,
  inlineUnitText,
  nextUnitIndex
} from "../src/components/ui/InlineDisplayToggle.ts";
import {
  SessionDiagnosticsView,
  type SessionDiagnosticsViewState
} from "../src/features/usage/SessionDiagnosticsView.ts";

function render(tab: string, threadId?: string): string {
  const report = sessionDiagnosticsReport();
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

test("the threads table shows role, model provider and model as distinct columns", () => {
  const markup = render("overview");
  for (const header of ["Role", "Model provider", "Model"]) {
    assert.match(markup, new RegExp(">" + header + "<"));
  }
  assert.match(markup, />orchestrator</);
  assert.match(markup, />autodev\/orchestrator</);
  assert.match(markup, />claude</);
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
        threads: [{ ...first, modelProvider: null, model: null }, ...rest]
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
  assert.match(markup, /data-unit="bytes"[^>]*>1,200 bytes</);
  assert.match(markup, /Activate to show characters\./);
});

test("the inline toggle cycles bytes, characters, tokens and never invents a missing count", () => {
  assert.equal(nextUnitIndex(0, 3), 1);
  assert.equal(nextUnitIndex(1, 3), 2);
  assert.equal(nextUnitIndex(2, 3), 0);
  const bytes = { id: "bytes", singular: "byte", plural: "bytes", value: 1200 };
  const chars = {
    id: "characters",
    singular: "character",
    plural: "characters",
    value: null
  };
  assert.equal(inlineUnitText(bytes), "1,200 bytes");
  assert.equal(inlineUnitText({ ...bytes, value: 1 }), "1 byte");
  assert.equal(inlineUnitText(chars), "Not observed (characters)");
  const markup = renderToStaticMarkup(
    React.createElement(InlineDisplayToggle, {
      label: "Size",
      units: [bytes, chars]
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
