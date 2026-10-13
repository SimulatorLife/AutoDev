import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePlaytestingScope,
  playtestingEpisodeHref,
  playtestingFilterHref,
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
    const parsed = parsePlaytestingScope({ workspaceId: WORKSPACE, liveBatch: value });
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

  // Over the bound Runtime enforces, a malformed id, an empty entry and a
  // repeated key are refused rather than trimmed to something that looks valid.
  const seventeen = Array.from(
    { length: 17 },
    (_, index) => `episode-${index}`
  ).join(",");
  for (const value of [
    seventeen,
    "episode-1,",
    "episode 1",
    "a".repeat(257),
    "",
    "episode-1/../other"
  ]) {
    const parsed = parsePlaytestingScope({ sessions: value });
    assert.deepEqual(parsed.selectedEpisodeIds, [], value);
    assert.equal(parsed.invalidQuery, true, value);
  }
  assert.equal(
    parsePlaytestingScope({ sessions: ["a", "b"] }).invalidQuery,
    true
  );
  assert.deepEqual(parsePlaytestingScope({}).selectedEpisodeIds, []);
});
