import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { OpencliCommandError } from "@simulatorlife/autodev-runtime/providers/opencli-turn";

import {
  OpencliBrowser,
  OpencliBrowserUnavailableError,
  type OpencliCdpCommand,
  resolveOpencliBrowserExecutable
} from "../src/providers/opencli-browser.ts";

type Target = { id: string; webSocketDebuggerUrl: string };
type FakeChild = ChildProcess &
  EventEmitter & { exitCode: number | null; killed: boolean };

function fakeChild(): FakeChild {
  // A ChildProcess is an EventEmitter; this minimal fake preserves its events.
  // eslint-disable-next-line unicorn/prefer-event-target -- Node child processes expose EventEmitter events.
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals) => {
    child.killed = true;
    child.exitCode = signal === "SIGKILL" ? 137 : 0;
    queueMicrotask(() => child.emit("close", child.exitCode, signal));
    return true;
  }) as ChildProcess["kill"];
  return child;
}

async function fixture(
  body: (context: {
    readonly browser: OpencliBrowser;
    readonly targets: Target[];
    readonly args: string[][];
    readonly profile: string;
    readonly children: FakeChild[];
    readonly activatedTargets: string[];
    readonly setListStatus: (status: number) => void;
    readonly setVersionStatus: (status: number) => void;
    readonly setNewFailures: (count: number) => void;
    readonly pauseNextRequest: (pathname: string) => {
      entered: Promise<void>;
      release(): void;
    };
  }) => Promise<void>,
  fixtureOptions: { readonly cdpCommand?: OpencliCdpCommand } = {}
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "opencli-browser-test-"));
  const profile = join(root, "private-profile");
  const targets: Target[] = [];
  const args: string[][] = [];
  const children: FakeChild[] = [];
  const activatedTargets: string[] = [];
  let listStatus = 200;
  let versionStatus = 200;
  let newFailures = 0;
  let nextId = 0;
  const port = 9333;
  const pauses = new Map<string, () => Promise<void>>();
  const releases = new Set<() => void>();
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    // Capture the inventory at request time, not when a delayed response
    // is released, so fixtures can reproduce stale CDP snapshots.
    const snapshot = [...targets];
    const pause = pauses.get(url.pathname);
    if (pause) {
      pauses.delete(url.pathname);
      await pause();
    }
    if (url.pathname === "/json/version")
      return Response.json({}, { status: versionStatus });
    if (url.pathname === "/json/list") {
      return Response.json(snapshot, { status: listStatus });
    }
    if (url.pathname === "/json/new") {
      if (newFailures > 0) {
        newFailures -= 1;
        return new Response(null, { status: 503 });
      }
      const target = {
        id: String(++nextId),
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${nextId}`
      };
      targets.push(target);
      return Response.json(target, { status: 200 });
    }
    if (url.pathname.startsWith("/json/activate/")) {
      const id = url.pathname.slice("/json/activate/".length);
      if (!targets.some((target) => target.id === id)) {
        return new Response(null, { status: 404 });
      }
      activatedTargets.push(id);
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  let child = fakeChild();
  const browser = new OpencliBrowser({
    executable: "/dedicated/chromium",
    siteTabs: { chatgpt: 2, gemini: 1 },
    profileDirectory: profile,
    readinessTimeoutMs: 200,
    fetch: fetcher,
    ...(fixtureOptions.cdpCommand && {
      cdpCommand: fixtureOptions.cdpCommand
    }),
    spawnBrowser: ((
      command: string,
      commandArgs: readonly string[],
      options: unknown
    ) => {
      args.push([command, ...commandArgs]);
      assert.equal((options as { detached: boolean }).detached, false);
      child = fakeChild();
      children.push(child);
      writeFileSync(
        join(profile, "DevToolsActivePort"),
        `${port}\n/devtools/browser/fake`
      );
      return child;
    }) as never
  });
  try {
    await body({
      browser,
      targets,
      args,
      profile,
      children,
      activatedTargets,
      setListStatus: (status) => {
        listStatus = status;
      },
      setVersionStatus: (status) => {
        versionStatus = status;
      },
      setNewFailures: (count) => {
        newFailures = count;
      },
      pauseNextRequest(pathname) {
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const release = (): void => {
          releases.delete(release);
          resume.resolve();
        };
        releases.add(release);
        pauses.set(pathname, () => {
          entered.resolve();
          return resume.promise;
        });
        return { entered: entered.promise, release };
      }
    });
  } finally {
    for (const release of releases) release();
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("starts visible Chromium with a private profile, ephemeral loopback CDP, and sized site pool", async () => {
  await fixture(async ({ browser, args, profile }) => {
    const assigned: string[] = [];
    await browser.run(
      "chatgpt",
      AbortSignal.timeout(1000),
      async (endpoint) => {
        assigned.push(endpoint);
      }
    );
    assert.equal(args[0]?.[0], "/dedicated/chromium");
    assert.ok(args[0]?.includes("--remote-debugging-port=0"));
    assert.ok(args[0]?.includes("--remote-debugging-address=127.0.0.1"));
    assert.ok(args[0]?.includes(`--user-data-dir=${profile}`));
    assert.equal(statSync(profile).mode & 0o777, 0o700);
    assert.equal(
      readFileSync(join(profile, "DevToolsActivePort"), "utf8").slice(
        0,
        readFileSync(join(profile, "DevToolsActivePort"), "utf8").indexOf("\n")
      ),
      new URL(assigned[0]!).port
    );
  });
});

test("concurrent startup does not expose a partially created target pool", async () => {
  await fixture(async ({ browser, pauseNextRequest, children, targets }) => {
    const firstTarget = pauseNextRequest("/json/new");
    const initializing = browser.initialize();
    await firstTarget.entered;
    const turn = browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async (endpoint) => {
        assert.equal(targets.length, 3);
        return endpoint;
      }
    );
    try {
      assert.equal(browser.isReady, false);
    } finally {
      firstTarget.release();
    }
    await initializing;
    assert.ok(await turn);
    assert.equal(children.length, 1);
    assert.equal(browser.isReady, true);
  });
});

test("a failed health probe does not restart Chromium during an active turn", async () => {
  await fixture(async ({ browser, children, setVersionStatus }) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = browser.run(
      "chatgpt",
      AbortSignal.timeout(1000),
      async () => {
        entered.resolve();
        await release.promise;
        return "completed";
      }
    );
    await entered.promise;
    try {
      setVersionStatus(503);
      await assert.rejects(
        browser.run(
          "gemini",
          AbortSignal.timeout(1000),
          async () => "unexpected"
        ),
        /health probe failed while commands are active/u
      );
      assert.equal(children.length, 1);
      assert.equal(children[0]?.killed, false);
      setVersionStatus(200);
      assert.equal(
        await browser.run(
          "gemini",
          AbortSignal.timeout(1000),
          async () => "ok"
        ),
        "ok"
      );
    } finally {
      setVersionStatus(200);
      release.resolve();
    }
    assert.equal(await active, "completed");
    assert.equal(children.length, 1);
  });
});

test("a stale target inventory cannot replace a concurrently recovered slot", async () => {
  await fixture(async ({ browser, pauseNextRequest, targets }) => {
    const original = await browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async (endpoint) => endpoint
    );
    targets.splice(
      targets.findIndex((target) => target.webSocketDebuggerUrl === original),
      1
    );
    const staleList = pauseNextRequest("/json/list");
    const first = browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async (endpoint) => endpoint
    );
    await staleList.entered;
    const entered = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const second = browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async (endpoint) => {
        entered.resolve(endpoint);
        await release.promise;
        return endpoint;
      }
    );
    const replacement = await entered.promise;
    try {
      staleList.release();
      // Let the stale response resume while the replacement is leased.
      await delay(0);
      assert.equal(targets.length, 3);
    } finally {
      staleList.release();
      release.resolve();
    }
    assert.equal(await second, replacement);
    assert.equal(await first, replacement);
    assert.equal(targets.length, 3);
  });
});

test("leases distinct ChatGPT targets concurrently and isolates the Gemini pool", async () => {
  await fixture(async ({ browser }) => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = browser.run(
      "chatgpt",
      AbortSignal.timeout(1000),
      async (url) => {
        await blocked;
        return url;
      }
    );
    await delay(5);
    const second = browser.run(
      "chatgpt",
      AbortSignal.timeout(1000),
      async (url) => url
    );
    const gemini = browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async (url) => url
    );
    const secondTarget = await second;
    const geminiTarget = await gemini;
    assert.notEqual(geminiTarget, secondTarget);
    release();
    assert.notEqual(await first, secondTarget);
  });
});

test("foreground lease activates the exact target and excludes competing native turns", async () => {
  await fixture(async ({ browser, activatedTargets }) => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = browser.run(
      "chatgpt",
      AbortSignal.timeout(2000),
      async (endpoint) => {
        assert.equal(
          activatedTargets.at(-1),
          new URL(endpoint).pathname.split("/").pop()
        );
        entered();
        await hold;
      },
      true
    );
    await started;
    const waiting = new AbortController();
    const second = browser.run(
      "gemini",
      waiting.signal,
      async () => {
        assert.fail("A competing turn must not steal foreground");
      },
      true
    );
    waiting.abort();
    await assert.rejects(second, /cancelled/u);
    assert.equal(activatedTargets.length, 1);
    release();
    await first;
    const target = await browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async (endpoint) => endpoint,
      true
    );
    assert.equal(
      activatedTargets.at(-1),
      new URL(target).pathname.split("/").pop()
    );
  });
});

test("replaces a closed target before the next command", async () => {
  await fixture(async ({ browser, targets }) => {
    const original = await browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async (endpoint) => endpoint
    );
    const index = targets.findIndex(
      (target) => target.webSocketDebuggerUrl === original
    );
    targets.splice(index, 1);
    const replacement = await browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async (endpoint) => endpoint
    );
    assert.notEqual(replacement, original);
  });
});

test("cancels while waiting for a leased site tab", async () => {
  await fixture(async ({ browser }) => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async () => blocker
    );
    await delay(5);
    const controller = new AbortController();
    const waiting = browser.run(
      "gemini",
      controller.signal,
      async () => "unexpected"
    );
    controller.abort();
    await assert.rejects(waiting, /cancelled/u);
    release();
    await first;
  });
});

test("eager initialization makes the browser ready before any provider command", async () => {
  await fixture(async ({ browser }) => {
    assert.equal(browser.isReady, false);
    await browser.initialize();
    assert.equal(browser.isReady, true);
    await browser.run("gemini", AbortSignal.timeout(1000), async () => "ready");
  });
});

test("site command errors propagate unchanged and do not mark the browser unavailable", async () => {
  await fixture(async ({ browser }) => {
    await browser.initialize();
    const siteError = new OpencliCommandError(
      "ChatGPT requires an authenticated session",
      "AUTH_REQUIRED",
      1
    );
    await assert.rejects(
      browser.run("chatgpt", AbortSignal.timeout(1000), async () => {
        throw siteError;
      }),
      (error) => error === siteError
    );
    assert.equal(browser.isReady, true);
    assert.equal(browser.unavailableReason, null);
  });
});

test("does not leave Chromium running after shutdown", async () => {
  await fixture(async ({ browser, args, children }) => {
    assert.equal(args.length, 0);
    await browser.run(
      "chatgpt",
      AbortSignal.timeout(1000),
      async () => "started"
    );
    assert.equal(browser.isReady, true);
    await browser.close();
    assert.equal(browser.isReady, false);
    assert.equal(children[0]?.killed, true);
  });
});

test("stopping the dedicated browser waits for leased commands, and the next run starts it again", async () => {
  await fixture(async ({ browser, args, children }) => {
    let release: () => void = () => undefined;
    const held = browser.run(
      "chatgpt",
      AbortSignal.timeout(1000),
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("done");
        })
    );
    // Let the command take its lease before the setting changes.
    while (args.length === 0) await delay(5);
    await delay(20);
    await browser.stop();
    assert.equal(children[0]?.killed, false, "a leased command was cut off");
    release();
    assert.equal(await held, "done");
    await delay(20);
    assert.equal(children[0]?.killed, true);
    assert.equal(browser.isReady, false);
    assert.equal(browser.unavailableReason, null);
    // Unlike shutdown, the owner stays usable.
    await browser.run("gemini", AbortSignal.timeout(1000), async () => "again");
    assert.equal(args.length, 2);
    assert.equal(browser.isReady, true);
  });
});

test("cleans up and retries after partial tab-pool startup", async () => {
  await fixture(async ({ browser, args, children, setNewFailures }) => {
    setNewFailures(1);
    await assert.rejects(
      browser.run("chatgpt", AbortSignal.timeout(1000), async () => "bad"),
      OpencliBrowserUnavailableError
    );
    assert.equal(browser.isReady, false);
    assert.equal(children[0]?.killed, true);
    assert.equal(
      await browser.run(
        "chatgpt",
        AbortSignal.timeout(1000),
        async () => "recovered"
      ),
      "recovered"
    );
    assert.equal(args.length, 2);
  });
});

test("browser process startup failure is returned as unavailable without escaping", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencli-browser-failure-"));
  const child = fakeChild();
  child.exitCode = 1;
  const browser = new OpencliBrowser({
    executable: "/dedicated/chromium",
    siteTabs: { chatgpt: 1, gemini: 1 },
    profileDirectory: join(root, "profile"),
    readinessTimeoutMs: 20,
    spawnBrowser: (() => child) as never
  });
  try {
    await browser.initialize();
    assert.equal(browser.isReady, false);
    assert.match(
      browser.unavailableReason ?? "",
      /exited before CDP became ready/u
    );
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when CDP target listing is unavailable", async () => {
  await fixture(async ({ browser, setListStatus }) => {
    setListStatus(503);
    await assert.rejects(
      browser.run("chatgpt", AbortSignal.timeout(1000), async () => "bad"),
      OpencliBrowserUnavailableError
    );
  });
});

test("reports CDP transport loss as unavailable and recovers on the next lease", async () => {
  await fixture(async ({ browser, setListStatus }) => {
    await browser.initialize();
    setListStatus(503);
    await assert.rejects(
      browser.run("chatgpt", AbortSignal.timeout(1000), async () => "bad"),
      OpencliBrowserUnavailableError
    );
    assert.equal(browser.isReady, false);
    assert.equal(
      browser.unavailableReason,
      "dedicated opencli browser target list unavailable"
    );

    setListStatus(200);
    await browser.run("chatgpt", AbortSignal.timeout(1000), async () => "ok");
    assert.equal(browser.isReady, true);
    assert.equal(browser.unavailableReason, null);
  });
});

test("resolver rejects cache paths outside AutoDev's dedicated provider runtime", () => {
  const home = join(tmpdir(), "opencli-executable-test");
  const expected = join(home, "provider-runtime", "opencli", "browsers");
  const executable = resolveOpencliBrowserExecutable({
    CODEX_HOME: home,
    PLAYWRIGHT_BROWSERS_PATH: expected
  });
  assert.ok(executable === null || executable.startsWith(`${expected}/`));
  assert.equal(
    resolveOpencliBrowserExecutable({
      CODEX_HOME: home,
      PLAYWRIGHT_BROWSERS_PATH: join(home, "other")
    }),
    null
  );
});

test("creates new-window CDP targets and restores minimized windows before activation", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencli-browser-cdp-"));
  const profile = join(root, "private-profile");
  const targets: Target[] = [];
  const cdpCalls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  let nextId = 0;
  const port = 9444;
  const browser = new OpencliBrowser({
    executable: "/dedicated/chromium",
    siteTabs: { chatgpt: 1, gemini: 1 },
    profileDirectory: profile,
    readinessTimeoutMs: 200,
    fetch: (async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/json/version") {
        return Response.json(
          {
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/root`
          },
          { status: 200 }
        );
      }
      if (url.pathname === "/json/list") {
        return Response.json(targets, { status: 200 });
      }
      if (url.pathname.startsWith("/json/activate/")) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch,
    cdpCommand: async (_wsUrl, method, params = {}) => {
      cdpCalls.push({ method, params });
      if (method === "Target.createTarget") {
        const id = `win-${++nextId}`;
        targets.push({
          id,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}`
        });
        return { targetId: id };
      }
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 77, bounds: { windowState: "minimized" } };
      }
      return {};
    },
    spawnBrowser: (() => {
      const child = fakeChild();
      writeFileSync(
        join(profile, "DevToolsActivePort"),
        `${port}\n/devtools/browser/root`
      );
      return child;
    }) as never
  });
  try {
    await browser.run(
      "chatgpt",
      AbortSignal.timeout(1000),
      async () => "ok",
      true
    );
    const created = cdpCalls.filter((c) => c.method === "Target.createTarget");
    assert.equal(created.length, 2);
    assert.equal(created[0]?.params.newWindow, true);
    assert.ok(
      cdpCalls.some(
        (c) =>
          c.method === "Browser.setWindowBounds" &&
          c.params.windowId === 77 &&
          (c.params.bounds as { windowState?: string })?.windowState ===
            "normal"
      )
    );
    assert.ok(cdpCalls.some((c) => c.method === "Target.activateTarget"));
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("releasing foreground after submission allows concurrent visible turns across sites", async () => {
  await fixture(async ({ browser }) => {
    let finishFirst!: () => void;
    let firstSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => {
      firstSubmitted = resolve;
    });
    const first = browser.run(
      "chatgpt",
      AbortSignal.timeout(1000),
      async (endpoint, releaseForeground) => {
        releaseForeground();
        firstSubmitted();
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        return endpoint;
      },
      true
    );
    await submitted;
    const secondEndpoint = await browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async (endpoint) => endpoint,
      true
    );
    assert.ok(secondEndpoint.includes("/devtools/page/"));
    finishFirst();
    const firstEndpoint = await first;
    assert.notEqual(firstEndpoint, secondEndpoint);
  });
});

test("unexpected Chromium exit clears stale leases and recovers on the next run", async () => {
  await fixture(async ({ browser, children }) => {
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const inFirst = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const first = browser.run(
      "chatgpt",
      AbortSignal.timeout(1000),
      async () => {
        enteredFirst();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return "stale";
      },
      true
    );
    await inFirst;
    children[0]!.exitCode = 1;
    children[0]!.emit("close", 1, null);
    assert.equal(browser.isReady, false);

    // Next turn restarts Chromium and takes foreground without being blocked by
    // the crashed generation's lease, even before the stale callback resolves.
    const second = await browser.run(
      "gemini",
      AbortSignal.timeout(1000),
      async () => "recovered",
      true
    );
    assert.equal(second, "recovered");
    assert.equal(browser.isReady, true);
    releaseFirst();
    assert.equal(await first, "stale");
    // Late completion of crashed-generation callback does not drop ready state.
    assert.equal(browser.isReady, true);
  });
});

test("a foreground lease raises the leased page so native input is dispatched", async () => {
  const cdpCalls: Array<{ wsUrl: string; method: string }> = [];
  await fixture(
    async ({ browser }) => {
      const leased = await browser.run(
        "chatgpt",
        AbortSignal.timeout(2000),
        async (endpoint) => endpoint,
        true
      );
      const raised = cdpCalls.find(
        (call) => call.method === "Page.bringToFront"
      );
      assert.ok(raised, "the leased page must be raised before native input");
      assert.equal(raised.wsUrl, leased);
    },
    {
      cdpCommand: async (wsUrl, method) => {
        cdpCalls.push({ wsUrl, method });
        if (method === "Runtime.evaluate") {
          return { result: { value: "visible" } };
        }
        return {};
      }
    }
  );
});

test("a foreground lease reports a page that stayed hidden", async () => {
  await fixture(
    async ({ browser }) => {
      await assert.rejects(
        browser.run(
          "chatgpt",
          AbortSignal.timeout(2000),
          async () => "ok",
          true
        ),
        (error: unknown) => {
          assert.ok(error instanceof OpencliBrowserUnavailableError);
          assert.match(error.message, /not visible/u);
          assert.match(error.message, /visibilityState is "hidden"/u);
          return true;
        }
      );
    },
    {
      cdpCommand: async (_wsUrl, method) =>
        method === "Runtime.evaluate" ? { result: { value: "hidden" } } : {}
    }
  );
});

test("a foreground lease continues when the page visibility cannot be observed", async () => {
  await fixture(
    async ({ browser }) => {
      const result = await browser.run(
        "chatgpt",
        AbortSignal.timeout(2000),
        async () => "ok",
        true
      );
      assert.equal(result, "ok");
    },
    {
      cdpCommand: async (_wsUrl, method) => {
        if (method === "Runtime.evaluate") {
          throw new Error("CDP transport closed");
        }
        return {};
      }
    }
  );
});
