import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearWholePageRequestsForTests,
  navigateToWholePage,
  setWholePageAnswerProbeForTests,
  warmUpWholePage,
  wholePageAnswerArrived
} from "../src/components/navigation/whole-page-navigation.ts";

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

test("the warm-up asks for the destination's page and remembers when it asked", () => {
  clearWholePageRequestsForTests();
  const { router, prefetches } = createRouter();
  warmUpWholePage(router, "/providers/claude");
  assert.deepEqual(prefetches, ["/providers/claude"]);
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
  let answerArrived = false;
  setWholePageAnswerProbeForTests(() => answerArrived);
  const navigation = navigateToWholePage(router, "/providers/claude", "push", {
    scroll: false
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
  assert.deepEqual(
    pushes,
    [],
    "the navigation must not leave before the answer is in hand"
  );
  answerArrived = true;
  await navigation;
  assert.deepEqual(pushes, [{ href: "/providers/claude", scroll: false }]);
  assert.deepEqual(prefetches, ["/providers/claude"]);
  setWholePageAnswerProbeForTests(null);
});

test("a newer navigation replaces the one that is waiting", async () => {
  clearWholePageRequestsForTests();
  const { router, pushes, replacements } = createRouter();
  let answerArrived = false;
  setWholePageAnswerProbeForTests(() => answerArrived);
  const first = navigateToWholePage(router, "/providers/claude", "push");
  const second = navigateToWholePage(router, "/agents/default", "replace");
  answerArrived = true;
  await Promise.all([first, second]);
  assert.deepEqual(
    pushes,
    [],
    "the replaced navigation must not leave"
  );
  assert.deepEqual(
    replacements,
    [{ href: "/agents/default", scroll: false }],
    "the newer navigation is the one that leaves"
  );
  setWholePageAnswerProbeForTests(null);
});

test("an answer is recognised by its destination, not by any request", () => {
  const entries = [
    {
      name: "http://console.test/providers?_rsc=abc",
      startTime: 100,
      responseEnd: 120
    },
    {
      name: "http://console.test/providers/claude?_rsc=abc",
      startTime: 200,
      responseEnd: 220
    },
    {
      name: "http://console.test/providers/claude?_rsc=abc",
      startTime: 50,
      responseEnd: 70
    }
  ] as unknown as PerformanceEntryList;
  assert.equal(
    wholePageAnswerArrived("/providers/claude", 150, entries),
    true,
    "the answer for the destination counts"
  );
  assert.equal(
    wholePageAnswerArrived("/providers/claude", 250, entries),
    false,
    "an answer that arrived before the ask does not count"
  );
  assert.equal(
    wholePageAnswerArrived("/agents/default", 0, entries),
    false,
    "another destination's answer does not count"
  );
});

test("a search parameter is part of the answer's identity", () => {
  const entries = [
    {
      name: "http://console.test/tools?_rsc=abc",
      startTime: 100,
      responseEnd: 120
    },
    {
      name: "http://console.test/tools?source=mcp&_rsc=abc",
      startTime: 200,
      responseEnd: 220
    }
  ] as unknown as PerformanceEntryList;
  assert.equal(
    wholePageAnswerArrived("/tools?source=mcp", 0, entries),
    true,
    "the filtered answer counts"
  );
  assert.equal(
    wholePageAnswerArrived("/tools", 0, entries),
    true,
    "the unfiltered answer counts for its own destination"
  );
});
