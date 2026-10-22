import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearWholePageRequestsForTests,
  navigateToWholePage,
  warmUpWholePage
} from "../src/components/navigation/whole-page-navigation.ts";
import {
  deliverWholePageAnswer,
  installWholePageAnswerObserver
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

test("a navigation waits for the answer before it leaves", async () => {
  clearWholePageRequestsForTests();
  const { router, prefetches, pushes } = createRouter();
  const navigation = navigateToWholePage(router, "/providers/claude", "push", {
    scroll: false
  });
  await settle();
  assert.deepEqual(
    pushes,
    [],
    "the navigation must not leave before the answer is in hand"
  );
  deliverWholePageAnswer("/providers/claude");
  await navigation;
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
  assert.deepEqual(prefetches, ["/providers/claude"]);
});

test("a newer navigation replaces the one that is waiting", async () => {
  clearWholePageRequestsForTests();
  const { router, pushes, replacements } = createRouter();
  const first = navigateToWholePage(router, "/providers/claude", "push");
  const second = navigateToWholePage(router, "/agents/default", "replace");
  deliverWholePageAnswer("/providers/claude");
  deliverWholePageAnswer("/agents/default");
  await Promise.all([first, second]);
  assert.deepEqual(pushes, [], "the replaced navigation must not leave");
  assert.deepEqual(
    replacements,
    [{ href: "/agents/default", scroll: false }],
    "the newer navigation is the one that leaves"
  );
});

test("an answer that arrived while the operator was on the link is in hand", async () => {
  clearWholePageRequestsForTests();
  const { router, pushes } = createRouter();
  // The warm-up asked while the operator's pointer was on the link, and the
  // answer arrived before the click. The click must not wait for a second
  // answer that will never come.
  warmUpWholePage(router, "/providers/claude");
  deliverWholePageAnswer("/providers/claude");
  const navigation = navigateToWholePage(router, "/providers/claude", "push");
  await navigation;
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
});

test("an answer left over from an earlier visit is not the answer", async () => {
  clearWholePageRequestsForTests();
  const { router, pushes } = createRouter();
  // The owner has to be watching before an answer can arrive.
  warmUpWholePage(router, "/providers");
  deliverWholePageAnswer("/providers/claude");
  const navigation = navigateToWholePage(router, "/providers/claude", "push");
  await settle();
  assert.deepEqual(
    pushes,
    [],
    "an answer from before the ask is not the answer this navigation waits for"
  );
  deliverWholePageAnswer("/providers/claude");
  await navigation;
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
});

test("another destination's answer does not satisfy the navigation", async () => {
  clearWholePageRequestsForTests();
  const { router, pushes } = createRouter();
  const navigation = navigateToWholePage(router, "/providers/claude", "push");
  deliverWholePageAnswer("/agents/default");
  await settle();
  assert.deepEqual(pushes, [], "another destination's answer is not this one");
  deliverWholePageAnswer("/providers/claude");
  await navigation;
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
});

test("a search parameter is part of the answer's identity", async () => {
  clearWholePageRequestsForTests();
  const { router, pushes } = createRouter();
  const navigation = navigateToWholePage(router, "/tools?source=mcp", "push");
  deliverWholePageAnswer("/tools");
  await settle();
  assert.deepEqual(
    pushes,
    [],
    "the unfiltered answer is not the filtered answer"
  );
  deliverWholePageAnswer("/tools?source=mcp");
  await navigation;
  assert.deepEqual(pushes, [{ href: "/tools?source=mcp", scroll: false }]);
});

test("the answer still arrives when the page's clock and timers are held still", async () => {
  clearWholePageRequestsForTests();
  const { router, pushes } = createRouter();
  // The browser acceptance holds the page's clock still on purpose: a feedback
  // that dismisses itself after five seconds has to be told apart from one the
  // operator closed. A navigation that waited on the page's clock would stop
  // with it, and the page would never be rebuilt around the write.
  const realClock = {
    dateNow: Date.now,
    performanceNow: performance.now,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval
  };
  Date.now = () => 1_700_000_000_000;
  performance.now = () => 1_000;
  globalThis.setTimeout = (() => 0) as unknown as typeof globalThis.setTimeout;
  globalThis.setInterval = (() =>
    0) as unknown as typeof globalThis.setInterval;
  try {
    const navigation = navigateToWholePage(router, "/providers/claude", "push");
    await settle();
    assert.deepEqual(pushes, [], "the navigation waits for the answer");
    deliverWholePageAnswer("/providers/claude");
    await navigation;
    assert.deepEqual(
      pushes,
      [{ href: "/providers/claude", scroll: false }],
      "the answer arrives as an event, so a still clock cannot hold it back"
    );
  } finally {
    Date.now = realClock.dateNow;
    performance.now = realClock.performanceNow;
    globalThis.setTimeout = realClock.setTimeout;
    globalThis.setInterval = realClock.setInterval;
  }
});
