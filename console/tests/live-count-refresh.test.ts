import assert from "node:assert/strict";
import test from "node:test";

import { shouldRefreshLiveCounts } from "../src/components/navigation/live-count-refresh.ts";
import {
  clearWholePageNavigationForTests,
  navigateToWholePage
} from "../src/components/navigation/whole-page-navigation.ts";
import {
  clearBrowserAddress,
  setBrowserAddress
} from "./support/whole-page-answer.ts";

/**
 * The live counts wait for a navigation that is still on its way.
 *
 * A refresh that lands while a navigation is in flight takes the navigation's
 * place in the router, and the navigation never applies its page: the address
 * bar does not move and the page the operator asked for does not arrive. The
 * refresh runs every five seconds, and the navigation to the densest page in
 * the Console takes longer than that to issue its request, so the two landed on
 * top of each other every time.
 */
function createRouter(): {
  readonly prefetch: (href: string) => void;
  readonly push: (href: string) => void;
  readonly replace: (href: string) => void;
} {
  return {
    prefetch: () => {},
    push: () => {},
    replace: () => {}
  };
}

test("the live counts wait for a navigation that is still on its way", () => {
  clearWholePageNavigationForTests();
  clearBrowserAddress();
  assert.equal(
    shouldRefreshLiveCounts(),
    true,
    "a Console that is not navigating refreshes its counts"
  );

  navigateToWholePage(createRouter(), "/providers/claude", "push");
  assert.equal(
    shouldRefreshLiveCounts(),
    false,
    "a navigation the owner has started and the address bar has not moved is still on its way"
  );

  setBrowserAddress("/providers/claude");
  assert.equal(
    shouldRefreshLiveCounts(),
    true,
    "the address bar moved, so the navigation committed and the counts can refresh"
  );
});
