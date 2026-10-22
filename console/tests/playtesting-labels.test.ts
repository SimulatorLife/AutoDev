import assert from "node:assert/strict";
import test from "node:test";

import type { ControlApiPlaytestingReview } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NOT_OBSERVED_LABEL } from "../src/components/status/StatusBadge.ts";
import {
  cohortLabel,
  executionStateExplanation,
  executionStateLabel,
  gameOutcomeBadgeLabel,
  gameOutcomeLabel,
  limitTerminationReason,
  missingReasonLabel,
  playtestingSessionFailureHint,
  playtestingSessionFailureTitle,
  policyLabel
} from "../src/features/playtesting/playtesting-labels.ts";
import { reviewRecordedDay } from "../src/features/playtesting/playtesting-review-presentation.ts";
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

test("an outcome badge names what it did not observe", () => {
  // A badge stands on its own: "Not observed" beside an execution-status
  // badge says which of the two was not observed only to a reader who
  // already knows.
  assert.equal(gameOutcomeBadgeLabel("unknown"), "No game outcome");
  assert.equal(gameOutcomeBadgeLabel("win"), "Win");
  assert.equal(gameOutcomeBadgeLabel("dnf"), "Did not finish");
});

test("a recorded day that cannot be read does not take the page with it", () => {
  assert.equal(reviewRecordedDay("2026-10-21T22:07:57.293Z"), "2026-10-21");
  // A page that throws because one row's timestamp is malformed has lost
  // every row that was readable.
  assert.equal(reviewRecordedDay("not a date"), NOT_OBSERVED_LABEL);
  assert.equal(reviewRecordedDay(""), NOT_OBSERVED_LABEL);
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
        latestReviews: [],
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

test("the Overview shows the analyst's conclusions, not only how many there are", () => {
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
        latestReviews: [review()],
        latestEpisodes: []
      }
    })
  );
  // The conclusion is on the page, not only the count of conclusions.
  assert.match(html, /Latest analyst conclusions/u);
  assert.match(
    html,
    /The fast-forward label moves from 1x to 2x across the captures/u
  );
  assert.match(html, /Discovery review · 2 hypotheses · 4 observations/u);
  // The way into it is a link that opens the review's own detail.
  assert.match(html, /data-overview-conclusion="review-1"/u);
  assert.match(html, /view=findings[^"]*review=review-1/u);
  // The rest of the list is one click away, and says how much is in it.
  assert.match(html, /See all 14 analyst reviews/u);
});

test("the Overview says when the analyst has concluded nothing yet", () => {
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
        reviewCount: 0,
        latestReviews: [],
        latestEpisodes: []
      }
    })
  );
  assert.match(html, /No analysis has been recorded for this workspace yet/u);
  assert.doesNotMatch(html, /See all 0 analyst reviews/u);
});

test("a conclusion that fills its lines does not take the counts with it", () => {
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
        reviews: [
          review({
            headline:
              "Because the car labels stay at Lap 1 while playback went 1x to 2x to 4x, the fast-forward button may have no visible effect on race progress in this pre-race state."
          })
        ],
        reviewTotal: 1
      }
    })
  );
  // The clamp is on the conclusion alone.
  assert.match(html, /line-clamp-3/u);
  const clampStart = html.indexOf("line-clamp-3");
  const clampEnd = html.indexOf("</div>", clampStart);
  const counts = html.indexOf(
    "Discovery review · 2 hypotheses · 4 observations"
  );
  assert.ok(counts > clampEnd, "the counts are written outside the clamp");
  // The way into the review is stated, not implied by a paragraph of body
  // text that only happens to be a link.
  assert.match(html, /data-review-read="review-1"/u);
  assert.match(html, /Open review/u);
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
