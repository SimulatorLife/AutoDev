import assert from "node:assert/strict";
import test from "node:test";

// console-ensure runs as a script entrypoint (scripts/ensure-codex-console.sh
// dispatches to it), so it is deliberately absent from the platform barrel.
import {
  type ConsoleEnsureDeps,
  type ConsoleEnsureOptions,
  ensureConsole,
  resolveConsoleEnsureOptions
} from "../../runtime/src/platform/console-ensure.ts";

function options(
  overrides: Partial<ConsoleEnsureOptions> = {}
): ConsoleEnsureOptions {
  return {
    host: "127.0.0.1",
    port: 3300,
    label: "com.codex.autodev-console",
    plist: "/tmp/console.plist",
    launcher: "/tmp/console.sh",
    nodeBin: "/usr/bin/node",
    readyTimeoutMs: 20,
    logPath: "/tmp/console.log",
    ...overrides
  };
}

function deps(overrides: Partial<ConsoleEnsureDeps> = {}): ConsoleEnsureDeps {
  let loaded = false;
  return {
    launchd: {
      isLoaded: () => loaded,
      kickstart: () => {
        loaded = true;
      },
      bootstrap: () => {
        loaded = true;
      }
    },
    launchdAvailable: () => true,
    probe: async () => false,
    sleep: async () => {},
    plistExists: () => false,
    launcherExists: () => true,
    startFallback: () => {},
    ...overrides
  };
}

test("resolver derives the Console LaunchAgent and runtime paths", () => {
  const result = resolveConsoleEnsureOptions({
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    AUTODEV_CONSOLE_PORT: "4400"
  });
  assert.equal(result.port, 4400);
  assert.equal(result.plist, "/home/test/Library/LaunchAgents/com.codex.autodev-console.plist");
  assert.equal(result.launcher, "/home/test/.codex/hooks/run-codex-console.sh");
  assert.equal(result.logPath, "/home/test/.codex/run/autodev-console.fallback.log");
});

test("a healthy Console is left untouched", async () => {
  let started = false;
  const status = await ensureConsole(
    options(),
    deps({
      probe: async () => true,
      startFallback: () => {
        started = true;
      }
    })
  );
  assert.equal(status, 0);
  assert.equal(started, false);
});

test("the fallback launcher is awaited through the shared readiness wait", async () => {
  // Console now shares waitForProbe, which takes a timeout rather than a
  // pre-computed deadline. Passing a deadline where a timeout is expected would
  // place the deadline in the past and fail every Console start instantly, so
  // a launcher that becomes ready must still be observed.
  const calls: string[] = [];
  const status = await ensureConsole(
    options({ readyTimeoutMs: 1000 }),
    deps({
      launchdAvailable: () => false,
      probe: (() => {
        let count = 0;
        return async () => ++count > 1;
      })(),
      startFallback: (launcher, logPath) => {
        calls.push(`${launcher}:${logPath}`);
      }
    })
  );
  assert.equal(status, 0);
  assert.deepEqual(calls, ["/tmp/console.sh:/tmp/console.log"]);
});

test("a Console that never becomes ready fails only after its timeout", async () => {
  const started = Date.now();
  const status = await ensureConsole(
    options({ readyTimeoutMs: 40 }),
    deps({ launchdAvailable: () => false, probe: async () => false })
  );
  assert.equal(status, 1);
  assert.ok(
    Date.now() - started >= 35,
    "the readiness wait must consume its timeout before reporting failure"
  );
});
