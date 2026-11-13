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

import {
  OpencliBrowser,
  OpencliBrowserUnavailableError,
  resolveOpencliBrowserExecutable
} from "../../runtime/src/providers/opencli-browser.ts";
import { OpencliCommandError } from "../../runtime/src/providers/opencli-turn.ts";

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
    readonly setListStatus: (status: number) => void;
    readonly setNewFailures: (count: number) => void;
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "opencli-browser-test-"));
  const profile = join(root, "private-profile");
  const targets: Target[] = [];
  const args: string[][] = [];
  const children: FakeChild[] = [];
  let listStatus = 200;
  let newFailures = 0;
  let nextId = 0;
  const port = 9333;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/json/version")
      return Response.json({}, { status: 200 });
    if (url.pathname === "/json/list") {
      return Response.json(targets, { status: listStatus });
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
    return new Response(null, { status: 404 });
  };
  let child = fakeChild();
  const browser = new OpencliBrowser({
    executable: "/dedicated/chromium",
    siteTabs: { chatgpt: 2, gemini: 1 },
    profileDirectory: profile,
    readinessTimeoutMs: 200,
    fetch: fetcher,
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
      setListStatus: (status) => {
        listStatus = status;
      },
      setNewFailures: (count) => {
        newFailures = count;
      }
    });
  } finally {
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

test("turning the dedicated browser off waits for leased commands, and turning it on starts it again", async () => {
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
