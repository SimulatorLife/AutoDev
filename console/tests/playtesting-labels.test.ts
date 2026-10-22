import assert from "node:assert/strict";
import test from "node:test";

import type { ControlApiPlaytestingReview } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  cohortLabel,
  executionStateExplanation,
  executionStateLabel,
  gameOutcomeLabel,
  limitTerminationReason,
  missingReasonLabel,
  playtestingSessionFailureHint,
  playtestingSessionFailureTitle,
  policyLabel
} from "../src/features/playtesting/playtesting-labels.ts";
import { parsePlaytestingScope } from "../src/features/playtesting/playtesting-url.ts";
import { PlaytestingView } from "../src/features/playtesting/PlaytestingView.ts";

const WORKSPACE = "owner/game";

function scope(view: "findings" | "overview" | "sessions") {
  return parsePlaytestingScope({ view, workspaceId: WORKSPACE });
}

function review(
  overrides: Partial<ControlApiPlaytestingReview> = {}
): ControlApiPlaytestingReview {
  return {
    reviewId: "review-1",
    episodeId: "episode-17",
    workspaceId: WORKSPACE,
    kind: "discovery",
    status: "hypothesis",
    createdAt: "2026-10-21T12:00:00.000Z",
    observationCount: 4,
    interpretationCount: 2,
    findingCount: 0,
    headline: "The fast-forward label moves from 1x to 2x across the captures.",
    summary: "Four frames were reviewed against the recorded player intent.",
    hypotheses: [
      {
        hypothesisId: "int-speed-toggle",
        text: "The fast-forward button may have no visible effect before the race starts.",
        status: "hypothesis"
      }
    ],
    findings: [],
    evidenceRefs: [{ kind: "episode", id: "episode-17" }],
    ...overrides
  };
}

test("a truncated episode says which limit cut it short", () => {
  assert.equal(
    executionStateLabel("budget-truncated", "usage-budget"),
    "Budget exhausted"
  );
  assert.equal(
    executionStateLabel("budget-truncated", "step-limit"),
    "Step limit reached"
  );
  assert.equal(executionStateLabel("budget-truncated", null), "Limit reached");
  assert.equal(
    executionStateExplanation("budget-truncated", "usage-budget"),
    "The approved per-episode usage budget ran out before the step cap was reached."
  );
  assert.equal(executionStateExplanation("completed", "usage-budget"), null);
  assert.equal(limitTerminationReason("not-a-limit"), null);
});

test("a game outcome reads as a word, not a token", () => {
  assert.equal(gameOutcomeLabel("win"), "Win");
  assert.equal(gameOutcomeLabel("loss"), "Loss");
  assert.equal(gameOutcomeLabel("dnf"), "Did not finish");
  assert.equal(gameOutcomeLabel("unknown"), "Not observed");
});

test("the decision backend is named the way an operator names it", () => {
  assert.equal(policyLabel("smart-direct"), "Smart-directed");
  assert.equal(policyLabel("onejev-local"), "OneJev (local)");
  assert.equal(policyLabel("weak-bot"), "weak-bot");
});

test("an unassigned cohort says so instead of implying a persona", () => {
  assert.equal(cohortLabel(null), "No cohort assigned");
  assert.equal(cohortLabel(""), "No cohort assigned");
  assert.equal(cohortLabel("novice"), "novice");
});

test("a missing reason reads as a reason", () => {
  assert.equal(
    missingReasonLabel("budget-truncated"),
    "A limit cut the episode short"
  );
  assert.equal(
    missingReasonLabel("infrastructure-failed"),
    "Infrastructure failure"
  );
  assert.equal(missingReasonLabel("unobserved"), "Not observed");
});

test("the Findings view shows the analyst's hypotheses, not only verified findings", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: scope("findings"),
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ],
      list: {
        resource: "findings",
        rows: [],
        total: 0,
        nextCursor: null,
        reviews: [review()],
        reviewTotal: 1
      }
    })
  );
  assert.match(html, /Analyst Hypotheses/u);
  assert.match(html, /Verified Findings/u);
  assert.match(
    html,
    /The fast-forward label moves from 1x to 2x across the captures\./u
  );
  // A hypothesis is a hypothesis: the view must not present it as a defect.
  assert.match(html, /These are hypotheses, not defects/u);
  assert.match(html, /1 shown · 1 matching analyst reviews/u);
  // The link goes to the session the analyst looked at.
  assert.match(html, /data-review-session="review-1"/u);
  assert.match(html, /\/playtesting\/sessions\/episode-17/u);
});

test("the Findings view says plainly when nothing has been analysed", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: scope("findings"),
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ],
      list: {
        resource: "findings",
        rows: [],
        total: 0,
        nextCursor: null,
        reviews: [],
        reviewTotal: 0
      }
    })
  );
  assert.match(html, /No analysis has been recorded for this workspace yet/u);
  assert.match(html, /No finding has been verified for this workspace/u);
});

test("the Overview counts analyst reviews and never claims an absence of anomalies", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: scope("overview"),
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ],
      overview: {
        batches: [],
        batchCount: 3,
        episodeCount: 46,
        findingCount: 0,
        reviewCount: 14,
        latestEpisodes: []
      }
    })
  );
  assert.match(html, /Analyst Reviews/u);
  assert.match(html, /Verified Findings/u);
  assert.match(html, /14/u);
  // "No anomalies detected" was a claim that a search had run and found
  // nothing, which was false whenever hypotheses existed.
  assert.doesNotMatch(html, /No anomalies detected/u);
  assert.doesNotMatch(html, /AI CRITIC FINDINGS/u);
});

test("a session id the workspace never recorded is not described as a server fault", () => {
  const notFound = {
    code: "autodev_control_playtesting_episode_not_found",
    message: "The requested episode was not found.",
    notFound: true
  };
  assert.equal(playtestingSessionFailureTitle(notFound), "Session not found");
  assert.equal(
    playtestingSessionFailureHint(notFound),
    "This workspace has no playtest session with this id. Open a session from the Playtesting list for this workspace."
  );

  // Any other failure keeps the shared shell's own hint, which is about a
  // missing server-side integration and is true for that case.
  const other = {
    code: "autodev_control_api_unreachable",
    message: "The Control API did not answer.",
    notFound: false
  };
  assert.equal(
    playtestingSessionFailureTitle(other),
    "Playtesting episode could not be loaded"
  );
  assert.equal(playtestingSessionFailureHint(other), null);
});

test("an analyst review opens as an addressable detail under the Findings list", () => {
  const selected = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    review: "review-1"
  });
  assert.equal(selected.selectedReviewId, "review-1");

  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: selected,
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ],
      list: {
        resource: "findings",
        rows: [],
        total: 0,
        nextCursor: null,
        reviews: [review()],
        reviewTotal: 1
      }
    })
  );

  // The drawer carries the review the operator asked for, with the whole
  // conclusion readable rather than clamped into a table cell.
  assert.match(html, /data-review-detail="review-1"/u);
  assert.match(
    html,
    /Four frames were reviewed against the recorded player intent\./u
  );
  assert.match(html, /Close review detail/u);
  // The session it came from stays one click away.
  assert.match(html, /Open the session this review came from/u);
  // The list row is the way in, and it is a plain link.
  assert.match(html, /data-review-open="review-1"/u);
});

test("a review selection for a review this page does not show opens nothing", () => {
  const selected = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    review: "review-not-on-this-page"
  });
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: selected,
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ],
      list: {
        resource: "findings",
        rows: [],
        total: 0,
        nextCursor: null,
        reviews: [review()],
        reviewTotal: 1
      }
    })
  );
  assert.doesNotMatch(html, /data-review-detail=/u);
});

test("the review detail reads the analyst's claims, not only how many there are", () => {
  const selected = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    review: "review-1"
  });
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: selected,
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ],
      list: {
        resource: "findings",
        rows: [],
        total: 0,
        nextCursor: null,
        reviews: [
          review({
            hypotheses: [
              {
                hypothesisId: "int-1",
                text: "The fast-forward button may have no visible effect.",
                status: "hypothesis"
              },
              {
                hypothesisId: "int-2",
                text: "The run button gating was not observed.",
                status: "not observed"
              }
            ],
            findings: [
              {
                findingId: "finding-1",
                title: "The speed toggle does not advance the race.",
                evidenceStatus: "hypothesis"
              }
            ]
          })
        ],
        reviewTotal: 1
      }
    })
  );

  // The claims themselves are readable, each one addressed by its own id.
  assert.match(html, /data-review-claim="int-1"/u);
  assert.match(html, /The fast-forward button may have no visible effect\./u);
  assert.match(html, /data-review-claim="int-2"/u);
  assert.match(html, /The run button gating was not observed\./u);
  // A claim the analyst could not confirm says so rather than reading as a
  // conclusion.
  assert.match(html, /Not observed/u);
  // A finding the review raised carries its evidence status.
  assert.match(html, /The speed toggle does not advance the race\./u);
});

test("the review detail is titled with the conclusion, not with the review id", () => {
  const selected = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    review: "review-1"
  });
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: selected,
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ],
      list: {
        resource: "findings",
        rows: [],
        total: 0,
        nextCursor: null,
        reviews: [review()],
        reviewTotal: 1
      }
    })
  );

  // The title is the analyst's conclusion...
  assert.match(
    html,
    /<h2[^>]*>The fast-forward label moves from 1x to 2x across the captures\.<\/h2>/u
  );
  // ...and it is a sentence, so it is not set in the fixed pitch that marks
  // an identifier.
  const titleTag =
    html.match(/<h2[^>]*>The fast-forward label moves/u)?.[0] ?? "";
  assert.doesNotMatch(titleTag, /font-mono/u);
  // The review id is still on the panel, as the machine-readable subtitle.
  assert.match(html, /review-1/u);
  assert.doesNotMatch(html, /<h2[^>]*>review-1<\/h2>/u);
});
