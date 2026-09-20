import assert from "node:assert/strict";
import test from "node:test";

import { createMacosServiceLifecycle } from "../../src/hooks/lifecycle.ts";
import {
  type CommandResult,
  LaunchdClient,
  LaunchdError
} from "../../src/platform/macos/launchd.ts";

test("macOS lifecycle uses typed launchd operations without shell interpolation", () => {
  const calls: string[][] = [];
  // launchd's bootout is asynchronous: the label stays printable for one more
  // poll after the command returns.
  let loaded = true;
  let unloadPolls = 0;
  const runner = (_command: string, args: string[]): CommandResult => {
    calls.push(args);
    if (args[0] === "bootout") {
      unloadPolls = 1;
      return { stdout: "", stderr: "", status: 0 };
    }
    if (args[0] === "bootstrap") {
      loaded = true;
      return { stdout: "", stderr: "", status: 0 };
    }
    if (args[0] === "print") {
      if (unloadPolls > 0) {
        unloadPolls -= 1;
        if (unloadPolls === 0) loaded = false;
        return { stdout: "gui/501/com.autodev.router", stderr: "", status: 0 };
      }
      return loaded
        ? { stdout: "gui/501/com.autodev.router", stderr: "", status: 0 }
        : { stdout: "", stderr: "not loaded", status: 1 };
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  const sleeps: number[] = [];
  const client = new LaunchdClient({
    runner,
    uid: 501,
    sleep: (ms) => sleeps.push(ms)
  });
  const lifecycle = createMacosServiceLifecycle(client);
  const service = { label: "com.autodev.router", plist: "/tmp/router.plist" };
  lifecycle.bootstrap(service);
  lifecycle.restart(service);
  assert.equal(lifecycle.isHealthy(service), true);
  assert.deepEqual(calls, [
    ["print", "gui/501/com.autodev.router"],
    ["bootout", "gui/501/com.autodev.router"],
    ["print", "gui/501/com.autodev.router"],
    ["print", "gui/501/com.autodev.router"],
    ["bootstrap", "gui/501", "/tmp/router.plist"],
    ["print", "gui/501/com.autodev.router"],
    ["kickstart", "-k", "gui/501/com.autodev.router"],
    ["print", "gui/501/com.autodev.router"],
    ["print", "gui/501/com.autodev.router"]
  ]);
  assert.deepEqual(sleeps, [100]);
});

test("bootout waits for launchd to finish unloading before the caller rebootstraps", () => {
  const calls: string[][] = [];
  const runner = (_command: string, args: string[]): CommandResult => {
    calls.push(args);
    return args[0] === "print"
      ? { stdout: "gui/501/com.autodev.router", stderr: "", status: 0 }
      : { stdout: "", stderr: "", status: 0 };
  };
  const sleeps: number[] = [];
  const client = new LaunchdClient({
    runner,
    uid: 501,
    unloadAttempts: 3,
    unloadDelayMs: 25,
    sleep: (ms) => sleeps.push(ms)
  });
  client.bootout("com.autodev.router");
  assert.equal(client.waitUntilUnloaded("com.autodev.router"), false);
  assert.deepEqual(sleeps, [25, 25, 25, 25, 25, 25]);
  assert.equal(
    calls.filter((args) => args[0] === "bootout").length,
    1,
    "bootout is issued once and then polled for completion"
  );
});

test("launchd failures preserve structured command evidence", () => {
  const client = new LaunchdClient({
    runner: () => ({ stdout: "", stderr: "denied", status: 1 }),
    uid: 501
  });
  assert.throws(
    () => client.bootstrap("/tmp/router.plist"),
    (error: unknown) => {
      assert.equal(error instanceof LaunchdError, true);
      assert.equal((error as LaunchdError).result?.stderr, "denied");
      return true;
    }
  );
});
