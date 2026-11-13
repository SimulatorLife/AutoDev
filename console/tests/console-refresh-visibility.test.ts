import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LIVE_COUNT_REFRESH_INTERVAL_MS,
  startLiveCountRefresh
} from "../src/components/navigation/live-count-refresh.ts";
import {
  browserVisibilitySource,
  type VisibilitySource
} from "../src/components/navigation/visibility.ts";

/**
 * A visibility source the test controls.
 *
 * The rule the refresh follows is a rule about the operator's window, and a
 * rule that can only be proved in a browser is a rule that is never proved.
 */
function fakeVisibility(visible: boolean): VisibilitySource & {
  readonly becomeVisible: () => void;
} {
  let listeners: (() => void)[] = [];
  return {
    isVisible: () => visible,
    onVisible: (listener: () => void) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
    becomeVisible: () => {
      visible = true;
      for (const listener of listeners) listener();
    }
  };
}

function fakeScheduler(): {
  readonly scheduler: Pick<typeof globalThis, "setInterval" | "clearInterval">;
  readonly tick: () => void;
} {
  let scheduled: (() => void) | null = null;
  return {
    scheduler: {
      setInterval: (callback: () => void) => {
        scheduled = callback;
        return "handle";
      },
      clearInterval: () => undefined
    } as unknown as Pick<typeof globalThis, "setInterval" | "clearInterval">,
    tick: () => {
      scheduled?.();
    }
  };
}

test("the live counts do not refresh a page the operator is not looking at", () => {
  const { scheduler, tick } = fakeScheduler();
  const visibility = fakeVisibility(false);
  let refreshes = 0;

  const cleanup = startLiveCountRefresh(
    () => {
      refreshes += 1;
    },
    scheduler,
    visibility
  );

  tick();
  assert.equal(
    refreshes,
    0,
    "a hidden page refreshes nothing: nobody is reading the counts it would refresh"
  );

  cleanup();
});

test("the live counts refresh as soon as the page is shown again", () => {
  const { scheduler, tick } = fakeScheduler();
  const visibility = fakeVisibility(false);
  let refreshes = 0;

  const cleanup = startLiveCountRefresh(
    () => {
      refreshes += 1;
    },
    scheduler,
    visibility
  );

  tick();
  assert.equal(refreshes, 0, "the page was hidden and refreshed nothing");

  visibility.becomeVisible();
  assert.equal(
    refreshes,
    1,
    "the counts the operator comes back to are as old as the moment they left, so the page refreshes when it is shown"
  );

  tick();
  assert.equal(refreshes, 2, "a visible page refreshes on the interval");

  cleanup();
});

test("the refresh interval is the Console's live-count cadence", () => {
  const { scheduler } = fakeScheduler();
  let interval: number | null = null;
  const handle = {
    setInterval: (callback: () => void, delay: number) => {
      interval = delay;
      return "handle";
    },
    clearInterval: () => undefined
  } as unknown as Pick<typeof globalThis, "setInterval" | "clearInterval">;

  const cleanup = startLiveCountRefresh(
    () => undefined,
    handle,
    fakeVisibility(true)
  );
  assert.equal(interval, LIVE_COUNT_REFRESH_INTERVAL_MS);
  cleanup();
  assert.notEqual(scheduler, undefined);
});

test("the visibility source reads the browser's own answer", () => {
  const listeners = new Map<string, () => void>();
  let state = "hidden";
  const documentRef = {
    get visibilityState(): string {
      return state;
    },
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, listener);
    },
    removeEventListener: (type: string) => {
      listeners.delete(type);
    }
  };

  const source = browserVisibilitySource(documentRef);
  assert.equal(source.isVisible(), false, "a hidden page is not visible");

  state = "visible";
  assert.equal(source.isVisible(), true, "a visible page is visible");

  let notified = 0;
  const unsubscribe = source.onVisible(() => {
    notified += 1;
  });
  state = "hidden";
  listeners.get("visibilitychange")?.();
  assert.equal(notified, 0, "a page that is still hidden notifies nobody");

  state = "visible";
  listeners.get("visibilitychange")?.();
  assert.equal(notified, 1, "becoming visible notifies the listener");

  unsubscribe();
  listeners.get("visibilitychange")?.();
  assert.equal(notified, 1, "an unsubscribed listener is not notified");
});

test("a page with no document is visible", () => {
  const source = browserVisibilitySource(undefined);
  assert.equal(
    source.isVisible(),
    true,
    "the server renders a page for an operator who asked for it; there is nothing hidden about that"
  );
});

test("the playtesting watch stops refreshing a session the operator cannot see", () => {
  const source = readFileSync(
    new URL(
      "../src/features/playtesting/PlaytestingSessionLiveWatch.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(
    source,
    /visibilitySource\.isVisible\(\)/u,
    "the watch asks whether the page is visible before it re-reads the session"
  );
  assert.match(
    source,
    /visibilitySource\.onVisible\(/u,
    "the watch refreshes the session as soon as the page is shown again"
  );
});
