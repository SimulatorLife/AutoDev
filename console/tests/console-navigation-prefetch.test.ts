import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  clearPendingWarmUpForTests,
  clearPrefetchCacheForTests,
  PREFETCH_INTENT_DELAY_MS,
  scheduleWholePageWarmUp
} from "../src/components/navigation/NavigationLink.ts";
import type { WholePageRouter } from "../src/components/navigation/whole-page-navigation.ts";

/**
 * A router that records what it was asked to warm.
 */
function recordingRouter(): {
  readonly router: WholePageRouter;
  readonly warmed: string[];
} {
  const warmed: string[] = [];
  return {
    warmed,
    router: {
      prefetch: (href: string) => {
        warmed.push(href);
      },
      push: () => undefined,
      replace: () => undefined
    }
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("a pointer that crosses the rail warms only the destination it settled on", async () => {
  clearPendingWarmUpForTests();
  clearPrefetchCacheForTests();
  const { router, warmed } = recordingRouter();

  // A sweep: the pointer crosses four links in a row.
  scheduleWholePageWarmUp(router, "/agents", 0);
  scheduleWholePageWarmUp(router, "/providers", 0);
  scheduleWholePageWarmUp(router, "/skills", 0);
  scheduleWholePageWarmUp(router, "/workspaces", 0);

  await wait(PREFETCH_INTENT_DELAY_MS + 40);

  assert.deepEqual(
    warmed,
    ["/workspaces"],
    "a pointer that was only passing through warms the destination it came to rest on, not every destination it passed"
  );
});

test("a warm-up that was never replaced still happens", async () => {
  clearPendingWarmUpForTests();
  clearPrefetchCacheForTests();
  const { router, warmed } = recordingRouter();

  scheduleWholePageWarmUp(router, "/memory", 0);
  await wait(PREFETCH_INTENT_DELAY_MS + 40);

  assert.deepEqual(warmed, ["/memory"]);
});

test("the same destination is not warmed twice inside the router's reuse window", async () => {
  clearPendingWarmUpForTests();
  clearPrefetchCacheForTests();
  const { router, warmed } = recordingRouter();

  scheduleWholePageWarmUp(router, "/hooks", 0);
  await wait(PREFETCH_INTENT_DELAY_MS + 40);
  scheduleWholePageWarmUp(router, "/hooks", 0);
  await wait(PREFETCH_INTENT_DELAY_MS + 40);

  assert.deepEqual(
    warmed,
    ["/hooks"],
    "the router would throw the second answer away: it may only reuse a page it fetched inside its own window"
  );
});

test("the playtesting poll loop is not re-created when the watch state flips", () => {
  const source = readFileSync(
    new URL(
      "../src/features/playtesting/use-playtesting-active-runs.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /\}, \[nonce, paused, watching, workspaceId\]\)/u,
    "the watch state flips whenever a poll changes it, and re-running the effect on that flip tore the loop down and built a new one"
  );
  assert.match(
    source,
    /shouldContinue: \(\) =>\s*\n?\s*!pausedRef\.current && isWatching\(runsRef\.current\)/u,
    "the loop reads the watch state from the runs it just merged, which are current the moment they exist"
  );
});
