import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import test from "node:test";

import { MemoryView } from "../src/features/memory/MemoryView.ts";
import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";

/**
 * The memory page has to say when a governed action did not happen.
 *
 * Every mutation on this surface — verify, revise, invalidate, supersede,
 * promote, purge — ends in a redirect back to `/memory` carrying the shared
 * could-not-confirm flag. If that banner does not render, a refused action is
 * indistinguishable from one that silently did nothing, and the operator's
 * next move is to believe the change landed.
 *
 * The Providers views have this covered; the Memory view did not. The banner
 * branch was never rendered by a test, so dropping it, or gating it behind the
 * records tab, would have gone green.
 *
 * It also has to render on *every* tab. The redirect returns to whichever tab
 * the operator was on, so a refusal raised from a cohort filter or an open
 * experience drawer must not land on a page that renders nothing.
 */

function listScope(tab: "records" | "experiences" | "cohorts"): MemoryListScope {
  return {
    tab,
    workspaceId: "SimulatorLife/AutoDev",
    offset: 0,
    limit: 25
  } as MemoryListScope;
}

function render(
  overrides: {
    readonly tab?: "records" | "experiences" | "cohorts";
    readonly controlFailed?: boolean;
    readonly controlRefusal?: "request_invalid" | "runtime_refused";
  } = {}
): string {
  return renderToStaticMarkup(
    React.createElement(MemoryView, {
      listScope: listScope(overrides.tab ?? "records"),
      records: [],
      totalRecords: 0,
      experiences: [],
      totalExperiences: 0,
      sessionCohorts: null,
      useCohorts: null,
      repositoryId: "SimulatorLife/AutoDev",
      workspaces: [],
      unapplied: [],
      ...(overrides.controlFailed === undefined
        ? {}
        : { controlFailed: overrides.controlFailed }),
      ...(overrides.controlRefusal === undefined
        ? {}
        : { controlRefusal: overrides.controlRefusal })
    })
  );
}

test("a refused memory action is reported on the tab it returns to", () => {
  for (const tab of ["records", "experiences", "cohorts"] as const) {
    const markup = render({ tab, controlFailed: true });

    assert.match(
      markup,
      /data-control-outcome="failed"/u,
      `a refusal returning to the ${tab} tab rendered no notice at all`
    );
    assert.match(
      markup,
      /could not be confirmed/u,
      `the ${tab} tab did not say the change was unconfirmed`
    );
  }
});

test("the memory page reports the reason the route observed", () => {
  // The reason rides in the redirect as a code the route chose, so the sentence
  // on screen is the route's claim rather than the Console's guess. This is the
  // end of that chain: route, redirect, page, sentence.
  const markup = render({ controlFailed: true, controlRefusal: "request_invalid" });

  assert.match(
    markup,
    /rejected this request as invalid/u,
    "the page must show the reason the route stated, not a generic failure"
  );
  assert.doesNotMatch(
    markup,
    /did not say why/u,
    "the route stated a reason, so the notice must not claim it did not"
  );
});

test("an ordinary page load carries no unconfirmed-change banner", () => {
  // `control=failed` is a one-shot flag on a redirect. If the notice rendered
  // unconditionally, every visit to the Memory page would claim the last action
  // failed, which trains the operator to read past the one place it matters.
  const markup = render({ controlFailed: false });

  assert.equal(markup.includes("data-control-outcome"), false);
  assert.equal(markup.includes("could not be confirmed"), false);
});