import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePlaytestingScope,
  playtestingEpisodeHref,
  playtestingFilterHref,
  playtestingFindingCloseHref,
  playtestingFindingHref,
  playtestingInspectorBackHref,
  playtestingListHref,
  playtestingPageHref,
  playtestingViewHref
} from "../src/features/playtesting/playtesting-url.ts";

const WORKSPACE = "owner/game";
const buildSha = "a".repeat(40);

test("Playtesting view navigation preserves workspace and destination-compatible filters", () => {
  const scope = parsePlaytestingScope({
    view: "sessions",
    workspaceId: "owner/game",
    buildSha,
    scenario: "hard",
    cursor: "opaque-page-2"
  });
  const href = playtestingViewHref(scope, "findings");
  const url = new URL(href, "http://console.test");
  assert.equal(url.searchParams.get("view"), "findings");
  assert.equal(url.searchParams.get("workspaceId"), "owner/game");
  assert.equal(url.searchParams.has("buildSha"), false);
  assert.equal(url.searchParams.has("scenario"), false);
  assert.equal(url.searchParams.has("cursor"), false);
});

test("session layout is shareable, defaults to List, and survives view navigation", () => {
  const initial = parsePlaytestingScope({
    view: "sessions",
    workspaceId: WORKSPACE
  });
  assert.equal(initial.layout, "list");
  assert.equal(
    new URL(
      playtestingListHref(initial),
      "http://console.test"
    ).searchParams.has("layout"),
    false
  );

  const grid = parsePlaytestingScope({
    view: "sessions",
    workspaceId: WORKSPACE,
    layout: "grid"
  });
  assert.equal(grid.layout, "grid");
  assert.equal(grid.invalidQuery, false);
  const gridUrl = new URL(playtestingListHref(grid), "http://console.test");
  assert.equal(gridUrl.searchParams.get("layout"), "grid");

  const nextView = new URL(
    playtestingViewHref(grid, "findings"),
    "http://console.test"
  );
  assert.equal(nextView.searchParams.get("layout"), "grid");
  assert.equal(
    parsePlaytestingScope({ view: "sessions", layout: "cards" }).invalidQuery,
    true
  );
  assert.equal(
    parsePlaytestingScope({ view: "sessions", layout: ["grid", "list"] })
      .invalidQuery,
    true
  );
});

test("finding replay links preserve exact episode step and filtered cursor-page Back state", () => {
  const scope = parsePlaytestingScope({
    view: "findings",
    workspaceId: "owner/game",
    severity: "major",
    status: "open",
    cursor: "page-3"
  });
  const findingId = "finding-" + "7".repeat(64);
  const href = playtestingEpisodeHref(scope, "episode:17", 23, findingId);
  const url = new URL(href, "http://console.test");
  assert.equal(url.pathname, "/playtesting/sessions/episode%3A17");
  assert.equal(url.searchParams.get("view"), "findings");
  assert.equal(url.searchParams.get("workspaceId"), "owner/game");
  assert.equal(url.searchParams.get("severity"), "major");
  assert.equal(url.searchParams.get("status"), "open");
  assert.equal(url.searchParams.get("returnFinding"), findingId);
  assert.equal(url.searchParams.get("cursor"), "page-3");
  assert.equal(url.searchParams.get("step"), "23");

  const detailScope = parsePlaytestingScope(
    Object.fromEntries(url.searchParams.entries())
  );
  const back = playtestingInspectorBackHref(detailScope);
  const backUrl = new URL(back, "http://console.test");
  assert.equal(backUrl.pathname, "/playtesting");
  assert.equal(backUrl.searchParams.get("view"), "findings");
  assert.equal(backUrl.searchParams.get("cursor"), "page-3");
  assert.equal(backUrl.searchParams.get("severity"), "major");
  assert.equal(backUrl.searchParams.get("status"), "open");
  assert.equal(backUrl.hash, "#finding-" + encodeURIComponent(findingId));
  assert.equal(backUrl.searchParams.has("step"), false);
});

test("Playtesting filters reset the keyset cursor while preserving the selected view", () => {
  const scope = parsePlaytestingScope({
    view: "sessions",
    workspaceId: "owner/game",
    cursor: "page-9",
    cohort: "expert"
  });
  const href = playtestingFilterHref(scope, {
    scenario: "tutorial",
    cohort: null
  });
  const url = new URL(href, "http://console.test");
  assert.equal(url.searchParams.get("view"), "sessions");
  assert.equal(url.searchParams.get("scenario"), "tutorial");
  assert.equal(url.searchParams.has("cohort"), false);
  assert.equal(url.searchParams.has("cursor"), false);
});

test("cursor pagination retains filters and view", () => {
  const scope = parsePlaytestingScope({
    view: "sessions",
    workspaceId: "owner/game",
    buildSha,
    limit: "25"
  });
  const url = new URL(
    playtestingPageHref(scope, "next"),
    "http://console.test"
  );
  assert.equal(url.searchParams.get("cursor"), "next");
  assert.equal(url.searchParams.get("view"), "sessions");
  assert.equal(url.searchParams.get("buildSha"), buildSha);
  assert.equal(url.searchParams.get("limit"), "25");
});

test("URL parsing rejects duplicate/invalid selections without fabricating filter values", () => {
  const scope = parsePlaytestingScope({
    view: ["sessions", "findings"],
    workspaceId: "owner/game",
    buildSha: "not-a-sha",
    limit: "1000",
    step: "-1"
  });
  assert.equal(scope.invalidQuery, true);
  assert.equal(scope.view, "overview");
  assert.equal(scope.filters.buildSha, undefined);
  assert.equal(scope.limit, 50);
  assert.equal(scope.step, null);
});

test("the focused live batch is bounded, shareable address state", () => {
  const focused = parsePlaytestingScope({
    workspaceId: WORKSPACE,
    liveBatch: "batch-42"
  });
  assert.equal(focused.liveBatchId, "batch-42");
  assert.equal(focused.invalidQuery, false);
  // Refresh and Back both re-derive the focused batch from the URL.
  assert.match(playtestingListHref(focused), /liveBatch=batch-42/);

  // An unbounded or malformed value is rejected rather than trusted.
  for (const value of ["a".repeat(129), "batch 42", "batch/42", "%00"]) {
    const parsed = parsePlaytestingScope({
      workspaceId: WORKSPACE,
      liveBatch: value
    });
    assert.equal(parsed.liveBatchId, null, value);
    assert.equal(parsed.invalidQuery, true, value);
  }
  // Repeating the key is ambiguous, so it is refused rather than guessed.
  assert.equal(
    parsePlaytestingScope({ liveBatch: ["a", "b"] }).invalidQuery,
    true
  );
  assert.equal(parsePlaytestingScope({}).liveBatchId, null);
});

test("the analysis selection is explicit, bounded and shareable", () => {
  const scope = parsePlaytestingScope({
    workspaceId: WORKSPACE,
    view: "sessions",
    sessions: "episode-1,episode-2,episode-3"
  });
  assert.deepEqual(scope.selectedEpisodeIds, [
    "episode-1",
    "episode-2",
    "episode-3"
  ]);
  assert.equal(scope.invalidQuery, false);
  assert.equal(scope.invalidSelection, false);
  // A shared link reproduces exactly the operator's selection.
  assert.match(
    playtestingListHref(scope),
    /sessions=episode-1%2Cepisode-2%2Cepisode-3/u
  );

  // Duplicates name one session, so the selection is not silently doubled.
  assert.deepEqual(
    parsePlaytestingScope({ sessions: "episode-1,episode-1" })
      .selectedEpisodeIds,
    ["episode-1"]
  );

  const forty = Array.from(
    { length: 40 },
    (_, index) => `episode-${index}`
  ).join(",");
  const atLimit = parsePlaytestingScope({ sessions: forty });
  assert.equal(atLimit.selectedEpisodeIds.length, 40);
  assert.equal(atLimit.invalidSelection, false);
  assert.match(playtestingListHref(atLimit), /sessions=/u);

  // Beyond the batch review ceiling, a malformed id, an empty entry and a
  // repeated key are refused rather than trimmed to something valid.
  const fortyOne = Array.from(
    { length: 41 },
    (_, index) => `episode-${index}`
  ).join(",");
  for (const value of [
    fortyOne,
    "episode-1,",
    "episode 1",
    "a".repeat(257),
    "",
    "episode-1/../other"
  ]) {
    const parsed = parsePlaytestingScope({ sessions: value });
    assert.deepEqual(parsed.selectedEpisodeIds, [], value);
    assert.equal(parsed.invalidSelection, true, value);
    assert.equal(parsed.invalidQuery, true, value);
  }
  assert.equal(
    parsePlaytestingScope({ sessions: ["a", "b"] }).invalidQuery,
    true
  );
  assert.deepEqual(parsePlaytestingScope({}).selectedEpisodeIds, []);
});

test("view changes and replay selection stay fast on a saturated filter set", () => {
  // The Console's cross-cutting acceptance names performance on view changes and
  // replay selection. These are the pure address-state helpers behind both, so
  // the assertion lives here where it runs: a browser timing assertion would be
  // the same measurement, unable to run in every environment.
  //
  // What it guards is linearity, which is what the acceptance names and what
  // this environment can actually measure. It deliberately does NOT assert a
  // wall-clock ceiling or a cost relative to a calibration workload: both were
  // built and both flaked, because the navigation path allocates several times
  // more than a tight calibration loop and so absorbs memory pressure
  // differently under a loaded runner. A guard that fails on contention trains
  // people to ignore it, so only the measurement that survived three
  // consecutive parallel runs is kept. Detecting a uniformly slower path is
  // therefore not covered here; it needs the browser-side timing assertion.
  //
  // The statistic is the median cost of one iteration rather than the mean.
  // This path costs microseconds per iteration, so the whole 2000-iteration
  // run is a window of roughly ten milliseconds; a single scheduler stall of
  // a few milliseconds inside that window is large enough to decide a mean,
  // and the measured growth then reports the runner rather than the code. The
  // stall is not the implementation's cost, so the guard measures the
  // implementation's typical cost instead.
  //
  // A median does not weaken what the guard detects. When an iteration costs
  // more the longer the run has been going -- a quadratic implementation --
  // the median iteration of a run of n costs about n/2 times the median
  // iteration of a run of n/4, so it reads the same ~4x growth a mean reads.
  const scope = parsePlaytestingScope({
    view: "findings",
    workspaceId: "owner/game",
    severity: "major",
    status: "open",
    cohort: "novice",
    policy: "random",
    cursor: "page-3"
  });

  const roundTrips = (iterations: number): number[] => {
    const samples: number[] = [];
    let previous = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const href = playtestingEpisodeHref(scope, "episode:17", index % 200);
      // Round-tripping through the parser is what a Back navigation costs.
      const parsed = parsePlaytestingScope(
        Object.fromEntries(new URL(href, "http://console.test").searchParams)
      );
      playtestingInspectorBackHref(parsed);
      playtestingViewHref(scope, "sessions");
      playtestingFilterHref(scope, { severity: "minor" });
      const now = performance.now();
      samples.push(now - previous);
      previous = now;
    }
    return samples;
  };

  const median = (samples: number[]): number => {
    const sorted = [...samples].sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  };

  // Warm up first: no sample should pay for JIT tiering.
  roundTrips(500);
  // Best of three per size, so one scheduler hiccup cannot decide the result.
  const cheapest = (n: number): number => {
    let best = Infinity;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cost = median(roundTrips(n));
      if (cost < best) best = cost;
    }
    return best;
  };

  const perIterationSmall = cheapest(500);
  const perIterationLarge = cheapest(2000);
  const growth = perIterationLarge / perIterationSmall;
  assert.ok(
    growth < 2.5,
    `Per-iteration cost grew ${growth.toFixed(2)}x when the run grew 4x; linear is ~1x and quadratic ~4x.`
  );
});

test("an open analyst review is address state, and it belongs to the Findings view", () => {
  const scope = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    review: "discovery-review-abc123"
  });
  assert.equal(scope.selectedReviewId, "discovery-review-abc123");

  // The Findings view keeps the open review in its own address.
  const findings = playtestingViewHref(scope, "findings");
  assert.match(findings, /review=discovery-review-abc123/u);

  // Another view cannot show a review, so it must not carry the selection.
  const sessions = playtestingViewHref(scope, "sessions");
  assert.doesNotMatch(sessions, /review=/u);
  assert.equal(
    parsePlaytestingScope({
      view: "sessions",
      workspaceId: WORKSPACE
    }).selectedReviewId,
    null
  );
});

test("a malformed review id is rejected rather than carried into the address", () => {
  const scope = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    review: "not a valid id"
  });
  assert.equal(scope.selectedReviewId, null);
  assert.equal(scope.invalidQuery, true);
  assert.doesNotMatch(playtestingListHref(scope), /review=/u);
});

test("an open finding is address state, and it belongs to the Findings view", () => {
  const findingId = `finding-${"a".repeat(64)}`;
  const scope = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    finding: findingId
  });
  assert.equal(scope.selectedFindingId, findingId);

  // The Findings view keeps the open finding in its own address.
  const findings = playtestingViewHref(scope, "findings");
  assert.match(findings, new RegExp(`finding=${findingId}`, "u"));

  // Another view cannot show a finding, so it must not carry the selection.
  const sessions = playtestingViewHref(scope, "sessions");
  assert.doesNotMatch(sessions, /finding=/u);
  assert.equal(
    parsePlaytestingScope({
      view: "sessions",
      workspaceId: WORKSPACE
    }).selectedFindingId,
    null
  );
});

test("a malformed finding id is rejected rather than carried into the address", () => {
  const scope = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    finding: "not a valid id"
  });
  assert.equal(scope.selectedFindingId, null);
  assert.equal(scope.invalidQuery, true);
  assert.doesNotMatch(playtestingListHref(scope), /finding=/u);
});

test("opening a finding from a review closes that review, so one detail is open at a time", () => {
  const findingId = `finding-${"b".repeat(64)}`;
  const scope = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    review: "discovery-review-abc123"
  });
  const href = playtestingFindingHref(scope, findingId);
  const url = new URL(href, "http://console.test");
  assert.equal(url.searchParams.get("finding"), findingId);
  assert.equal(url.searchParams.has("review"), false);
  // The link lands on the open panel rather than at the top of the list.
  assert.match(href, /#playtesting-finding-detail$/u);
});

test("closing a finding keeps the reader's filters and the rest of the address", () => {
  const findingId = `finding-${"c".repeat(64)}`;
  const scope = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE,
    severity: "major",
    finding: findingId
  });
  const url = new URL(
    playtestingFindingCloseHref(scope),
    "http://console.test"
  );
  assert.equal(url.searchParams.has("finding"), false);
  assert.equal(url.searchParams.get("severity"), "major");
  assert.equal(url.searchParams.get("workspaceId"), WORKSPACE);
});

test("a finding id that is not a finding is not opened as one", () => {
  const scope = parsePlaytestingScope({
    view: "findings",
    workspaceId: WORKSPACE
  });
  const href = playtestingFindingHref(scope, "not-a-finding-id");
  assert.doesNotMatch(href, /finding=/u);
});

test("a session search is part of the addressable scope and survives paging", () => {
  const scope = parsePlaytestingScope({
    view: "sessions",
    workspaceId: WORKSPACE,
    q: "ep-b141d962"
  });
  assert.equal(scope.filters.q, "ep-b141d962");

  // The search is in the URL the operator shares and in the link to the
  // next page, so paging does not silently drop it.
  const paged = new URL(
    playtestingPageHref(scope, "opaque-page-2"),
    "http://console.test"
  );
  assert.equal(paged.searchParams.get("q"), "ep-b141d962");
  assert.equal(paged.searchParams.get("cursor"), "opaque-page-2");

  // It belongs to the session list alone.
  const findings = new URL(
    playtestingViewHref(scope, "findings"),
    "http://console.test"
  );
  assert.equal(findings.searchParams.has("q"), false);
});

test("a session search that the server cannot honour is reported, not applied", () => {
  const scope = parsePlaytestingScope({
    view: "sessions",
    workspaceId: WORKSPACE,
    q: "x".repeat(257)
  });
  assert.equal(scope.filters.q, undefined);
  assert.equal(scope.invalidQuery, true);
});
