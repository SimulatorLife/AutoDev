import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearWholePageRequestsForTests,
  isLocalWholePageDestination,
  navigateToWholePage,
  warmUpWholePage
} from "../src/components/navigation/whole-page-navigation.ts";
import {
  clearBrowserAddress,
  deliverWholePageAnswer,
  installWholePageAnswerObserver,
  setBrowserAddress
} from "./support/whole-page-answer.ts";

installWholePageAnswerObserver();

interface RecordedRouter {
  readonly prefetches: string[];
  readonly pushes: { href: string; scroll: boolean | undefined }[];
  readonly replacements: { href: string; scroll: boolean | undefined }[];
}

function createRouter(): RecordedRouter & {
  readonly router: {
    readonly prefetch: (href: string) => void;
    readonly push: (
      href: string,
      options?: { readonly scroll?: boolean }
    ) => void;
    readonly replace: (
      href: string,
      options?: { readonly scroll?: boolean }
    ) => void;
  };
} {
  const prefetches: string[] = [];
  const pushes: { href: string; scroll: boolean | undefined }[] = [];
  const replacements: { href: string; scroll: boolean | undefined }[] = [];
  return {
    prefetches,
    pushes,
    replacements,
    router: {
      prefetch: (href) => {
        prefetches.push(href);
      },
      push: (href, options) => {
        pushes.push({ href, scroll: options?.scroll });
      },
      replace: (href, options) => {
        replacements.push({ href, scroll: options?.scroll });
      }
    }
  };
}

/** Let every promise that is already waiting settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

test("the warm-up asks for the destination's whole page", () => {
  clearWholePageRequestsForTests();
  const { router, prefetches } = createRouter();
  warmUpWholePage(router, "/providers/claude");
  assert.deepEqual(
    prefetches,
    ["/providers/claude"],
    "the warm-up has to ask for the page, not for the route's loading state"
  );
});

test("the warm-up leaves an external destination to the browser", () => {
  clearWholePageRequestsForTests();
  const { router, prefetches } = createRouter();
  warmUpWholePage(router, "https://example.test/docs");
  assert.deepEqual(prefetches, []);
});

test("a destination outside the Console is not the Console's to navigate", () => {
  assert.equal(isLocalWholePageDestination("/providers/claude"), true);
  assert.equal(isLocalWholePageDestination("https://example.test/docs"), false);
  assert.equal(isLocalWholePageDestination("//example.test/docs"), false);
});

test("a navigation asks for the destination's whole page before it leaves", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, prefetches, pushes } = createRouter();
  navigateToWholePage(router, "/providers/claude", "push", { scroll: false });
  assert.deepEqual(
    prefetches,
    ["/providers/claude"],
    "the router has to be asked for the page before the navigation leaves"
  );
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
});

test("a navigation leaves in the same turn, without waiting for an answer", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes } = createRouter();
  // The answer to the destination's page is carried by a request, and a
  // destination the router already holds needs no request at all. A navigation
  // that waits for a request waits for one that is never going to be made, and
  // the operator's click does nothing at all: the URL stays where it was and
  // the page does not move.
  //
  // The browser acceptance measured it. Of thirteen navigations between the
  // Console's own pages, five never committed: every one of them a
  // destination the router already held, so every one of them a destination
  // with no request to wait for.
  navigateToWholePage(router, "/providers/claude", "push");
  assert.deepEqual(
    pushes,
    [{ href: "/providers/claude", scroll: false }],
    "the navigation must not wait for a request that may never be made"
  );
});

test("a destination the router already holds still navigates", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes } = createRouter();
  // The router answers such a destination from its cache, and the browser
  // records no request for it. The navigation is the same navigation.
  warmUpWholePage(router, "/providers/claude");
  navigateToWholePage(router, "/providers/claude", "push");
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
});

test("the navigation leaves again when the answer arrives", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes } = createRouter();
  // A navigation that leaves before the router holds the destination's page
  // does not commit: the reducer applies the destination, React renders it,
  // and the commit that moves the address bar never runs. The answer arriving
  // is the signal to leave again, this time with the page in hand.
  navigateToWholePage(router, "/providers/claude", "push");
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
  deliverWholePageAnswer("/providers/claude");
  assert.deepEqual(pushes, [
    { href: "/providers/claude", scroll: false },
    { href: "/providers/claude", scroll: false }
  ]);
});

test("the navigation keeps leaving until the address bar has moved", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes } = createRouter();
  // The router does not always commit a navigation that answers for itself,
  // and the answer that comes back is the signal to leave again. The owner
  // leaves for every answer the destination produces, and stops as soon as
  // the address bar has moved.
  navigateToWholePage(router, "/providers/claude", "push");
  deliverWholePageAnswer("/providers/claude");
  deliverWholePageAnswer("/providers/claude");
  assert.deepEqual(pushes, [
    { href: "/providers/claude", scroll: false },
    { href: "/providers/claude", scroll: false },
    { href: "/providers/claude", scroll: false }
  ]);
});

test("the navigation stops leaving once it has left often enough", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes } = createRouter();
  // The number of leaves is bounded: a navigation that never commits must not
  // ask the server for the same page for ever.
  navigateToWholePage(router, "/providers/claude", "push");
  for (let answer = 0; answer < 6; answer += 1) {
    deliverWholePageAnswer("/providers/claude");
  }
  assert.deepEqual(pushes, [
    { href: "/providers/claude", scroll: false },
    { href: "/providers/claude", scroll: false },
    { href: "/providers/claude", scroll: false }
  ]);
});

test("a navigation that already committed is not left a second time", () => {
  clearWholePageRequestsForTests();
  setBrowserAddress("/providers/claude");
  const { router, pushes } = createRouter();
  navigateToWholePage(router, "/providers/claude", "push");
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
  deliverWholePageAnswer("/providers/claude");
  assert.deepEqual(
    pushes,
    [{ href: "/providers/claude", scroll: false }],
    "the address bar already moved, so the navigation committed"
  );
});

test("another destination's answer does not move this navigation", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes } = createRouter();
  navigateToWholePage(router, "/providers/claude", "push");
  deliverWholePageAnswer("/agents/default");
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
});

test("a newer navigation replaces the one that is waiting", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes, replacements } = createRouter();
  navigateToWholePage(router, "/providers/claude", "push");
  navigateToWholePage(router, "/agents/default", "replace");
  deliverWholePageAnswer("/providers/claude");
  deliverWholePageAnswer("/agents/default");
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
  assert.deepEqual(replacements, [
    { href: "/agents/default", scroll: false },
    { href: "/agents/default", scroll: false }
  ]);
});

test("a navigation leaves an external destination to the browser", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, prefetches, pushes } = createRouter();
  navigateToWholePage(router, "https://example.test/docs", "push");
  assert.deepEqual(prefetches, []);
  assert.deepEqual(pushes, []);
});

test("a navigation can replace the destination instead of pushing it", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes, replacements } = createRouter();
  navigateToWholePage(router, "/agents/default", "replace");
  assert.deepEqual(pushes, []);
  assert.deepEqual(replacements, [{ href: "/agents/default", scroll: false }]);
});

test("a navigation carries the scroll it was given", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes } = createRouter();
  navigateToWholePage(router, "/providers/claude", "push", { scroll: true });
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: true }]);
});

test("a search parameter is part of the destination's identity", () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, prefetches, pushes } = createRouter();
  navigateToWholePage(router, "/tools?source=mcp", "push");
  assert.deepEqual(prefetches, ["/tools?source=mcp"]);
  assert.deepEqual(pushes, [{ href: "/tools?source=mcp", scroll: false }]);
});

test("the navigation does not run on the page's clock", async () => {
  clearWholePageRequestsForTests();
  clearBrowserAddress();
  const { router, pushes } = createRouter();
  // The browser acceptance holds the page's clock still on purpose: a feedback
  // that dismisses itself after five seconds has to be told apart from one the
  // operator closed. A navigation that ran on the page's clock would stop with
  // it, and the page would never be rebuilt around the write.
  const realClock = {
    dateNow: Date.now,
    performanceNow: performance.now,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval
  };
  Date.now = () => 1_700_000_000_000;
  performance.now = () => 1000;
  globalThis.setTimeout = (() => 0) as unknown as typeof globalThis.setTimeout;
  globalThis.setInterval = (() =>
    0) as unknown as typeof globalThis.setInterval;
  try {
    navigateToWholePage(router, "/providers/claude", "push");
    deliverWholePageAnswer("/providers/claude");
    await settle();
    assert.deepEqual(pushes, [
      { href: "/providers/claude", scroll: false },
      { href: "/providers/claude", scroll: false }
    ]);
  } finally {
    Date.now = realClock.dateNow;
    performance.now = realClock.performanceNow;
    globalThis.setTimeout = realClock.setTimeout;
    globalThis.setInterval = realClock.setInterval;
  }
});
