import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePlaytestingScope,
  playtestingEpisodeHref,
  playtestingFilterHref,
  playtestingInspectorBackHref,
  playtestingPageHref,
  playtestingViewHref
} from "../src/features/playtesting/playtesting-url.ts";

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
  const href = playtestingEpisodeHref(scope, "episode:17", 23, "finding-7");
  const url = new URL(href, "http://console.test");
  assert.equal(url.pathname, "/playtesting/sessions/episode%3A17");
  assert.equal(url.searchParams.get("view"), "findings");
  assert.equal(url.searchParams.get("workspaceId"), "owner/game");
  assert.equal(url.searchParams.get("severity"), "major");
  assert.equal(url.searchParams.get("status"), "open");
  assert.equal(url.searchParams.get("returnFinding"), "finding-7");
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
  assert.equal(backUrl.hash, "#finding-finding-7");
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
