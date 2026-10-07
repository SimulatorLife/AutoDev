import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";
import { MemorySessionOutcome } from "../src/features/memory/MemorySessionOutcome.ts";

/**
 * The session-outcome panel, which the Console had no version of at all.
 *
 * `docs/memory-target-state.md` asks the Console to combine observed packet
 * injection evidence with "reporter-supplied task/session outcomes". The packet
 * side was built — injections, outcomes and use assessments all rendered — and
 * the session side was missing entirely: the Runtime stored session outcomes,
 * served them, and aggregated them into cohorts, while the operator surface had
 * no read and no write for them. A cohort view aggregating a report the product
 * cannot file is a view that is empty for a reason the operator cannot see.
 *
 * The property that matters most here is the one the panel has to keep apart:
 * "no outcome exists" and "we could not read" look identical if you collapse
 * them, and collapsing them is how a memory system starts asserting that nobody
 * reported a failure when in fact nobody could look.
 */

const LIST_SCOPE: MemoryListScope = {
  workspaceId: "SimulatorLife/AutoDev",
  offset: 0,
  limit: 25,
  tab: "experiences"
} as MemoryListScope;

const REPORT = {
  outcomeKind: "success",
  reportKind: "task",
  reporterId: "operator@example",
  reportedAt: "2026-10-07T09:00:00.000Z",
  reasonCode: "reporter_supplied",
  evidence: [{ kind: "trajectory", uri: "codex://session/exp-1" }]
} as const;

function render(
  report: Parameters<typeof MemorySessionOutcome>[0]["report"]
): string {
  return renderToStaticMarkup(
    React.createElement(MemorySessionOutcome, {
      report,
      listScope: LIST_SCOPE,
      experienceId: "exp-1"
    })
  );
}

test("a session with no outcome is offered the form", () => {
  // The positive case, and the reason the panel exists: with a read that
  // succeeded and the Runtime saying none exists, an operator can now file the
  // session-level claim the target state asks for.
  const markup = render(null);

  assert.match(markup, /data-session-outcome="exp-1"/u);
  assert.match(markup, /Report session outcome/u);
  assert.match(
    markup,
    /name="action" value="report-session-outcome"/u,
    "the form must name the action the route implements"
  );
});

test("an unread session outcome offers no form at all", () => {
  // The distinction this whole panel turns on. A read that failed must not be
  // drawn as "no outcome exists", and offering a form here would invite a second
  // report into a session the Runtime may already have one for — which comes
  // back a conflict, against a panel that said there was nothing there.
  const markup = render(undefined);

  assert.match(markup, /data-status="unavailable"/u);
  assert.match(markup, /was not read/u);
  assert.doesNotMatch(
    markup,
    /Report session outcome/u,
    "a failed read must not offer a report form"
  );
});

test("an existing session outcome is shown and not offered again", () => {
  // The Runtime binds one report per session and treats a second, different one
  // as a conflict rather than a replacement, so a second form would be a
  // submission guaranteed to fail.
  const markup = render(REPORT);

  assert.match(markup, /Success/u);
  assert.match(markup, /operator@example/u);
  assert.match(markup, /codex:\/\/session\/exp-1/u);
  assert.doesNotMatch(
    markup,
    /Report session outcome/u,
    "a session that already has an outcome must not be offered a second form"
  );
});

test("a reported outcome is never rendered as a wire code", () => {
  // Single-word codes are exactly where a "readable fallback" silently returns
  // the wire value: `task` would read as text while meaning something else, and
  // `pull_request` is unambiguous proof the raw token is being shown. Every code
  // on screen — outcome kind, report kind and evidence kind — is replaced by the
  // same label the packet-level outcomes use.
  const markup = render({
    ...REPORT,
    reportKind: "pull_request",
    evidence: [{ kind: "pull_request", uri: "https://example.test/pr/1" }]
  });

  assert.doesNotMatch(markup, /reasonCode|reporter_supplied|outcomeKind/u);
  assert.doesNotMatch(
    markup,
    /pull_request/u,
    "a report kind or evidence kind was rendered as its wire code"
  );
  assert.match(markup, /Pull request/u);
  assert.match(markup, /Success/u);
});

test("a session outcome recorded as not observed says so", () => {
  // `unknown` is a real, recorded answer meaning nobody stated an outcome. It
  // must not be rendered as a failure or as a success — the difference between
  // "nobody said" and "it went badly" is the whole point of the reason code.
  const markup = render({
    ...REPORT,
    outcomeKind: "unknown",
    reasonCode: "reporter_unknown"
  });

  assert.match(markup, /No reporter stated an outcome/u);
  assert.doesNotMatch(
    markup,
    /Failed|Partial|Cancelled/u,
    "a session nobody reported on must not be rendered as a negative result"
  );
});

test("the form offers exactly the Runtime's evidence and outcome vocabularies", () => {
  // The form must not be able to compose a body the Runtime refuses. Every
  // select is Core's own list, because that is what the Runtime checks against.
  const markup = render(null);

  for (const code of [
    "success",
    "partial",
    "failure",
    "cancelled",
    "unknown"
  ]) {
    assert.match(markup, new RegExp(`value="${code}"`, "u"), `missing ${code}`);
  }
  for (const code of ["task", "pull_request", "issue", "other"]) {
    assert.match(markup, new RegExp(`value="${code}"`, "u"), `missing ${code}`);
  }
});

test("the form sends no field the Runtime does not read", () => {
  // The Runtime takes `exactKeys` on `{outcomeKind, reportKind, evidence}`. A
  // field carried here would be refused outright, which is how the earlier
  // lifecycle actions became unreachable.
  const markup = render(null);
  const names = Array.from(
    markup.matchAll(/name="([^"]+)"/gu),
    (m) => m[1] ?? ""
  );

  for (const carried of names) {
    assert.ok(
      [
        "action",
        "experienceId",
        "workspaceId",
        "returned",
        "outcomeKind",
        "reportKind",
        "evidenceKind",
        "evidenceUri"
      ].includes(carried),
      `the form carries ${carried}, which the Runtime does not read`
    );
  }
  // No correlation token: the session outcome binds to the session, not to one
  // injected packet, so the injection's token is not one of its keys.
  assert.doesNotMatch(markup, /correlationToken|injectionEventId/u);
});

test("a vocabulary word this Console has no label for is shown verbatim", () => {
  // The Runtime can add an outcome, a report kind, or an evidence kind after
  // this Console is built. Every label lookup falls back to the wire word, and
  // that fallback is the only thing standing between a report the Runtime
  // legitimately sent and a panel that renders `undefined` beside a real
  // outcome — which reads as a rendering bug rather than as a word we do not
  // have a name for yet.
  const markup = render({
    ...REPORT,
    outcomeKind: "partially_succeeded" as never,
    reportKind: "incident_review" as never,
    evidence: [{ kind: "video" as never, uri: "artifact://run/42" }]
  });

  assert.match(markup, /partially_succeeded/u, "the outcome word is shown");
  assert.match(markup, /incident_review/u, "the report kind word is shown");
  assert.match(markup, /video: /u, "the evidence kind word is shown");
  assert.match(markup, /artifact:\/\/run\/42/u, "beside its uri");
  assert.doesNotMatch(
    markup,
    /undefined/u,
    "an unlabelled word must never render as undefined"
  );
});

test("a labelled vocabulary word is not shown as its wire form", () => {
  // The counterpart to the fallback above, so it cannot be satisfied by simply
  // printing every code it is given: a word we do have a name for shows the name.
  const markup = render(REPORT);

  assert.doesNotMatch(markup, />success</u);
  assert.doesNotMatch(markup, />task by/u);
  assert.match(markup, /Trajectory/u);
  assert.doesNotMatch(markup, /trajectory: /u);
});
