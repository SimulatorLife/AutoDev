/**
Descendant termination for a confined command.

A process group is not a command's whole tree. The executor runs the command
in its own group, so a group signal reaches the ordinary tree -- but a
descendant that detached into its own session left that group behind and
survived it. These tests drive the real executor under the real macOS
Seatbelt profile and prove that a cancelled, an expired and a still-running
command leave nothing of their own behind.
*/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CommandDefinition } from "../src/mcp/commands-catalogue.ts";
import {
  type ApprovedCommandScope,
  runApprovedCommand
} from "../src/mcp/commands-execution.ts";

const SHELL = realpathSync("/bin/sh");
const NODE = realpathSync(process.execPath);
const SANDBOX = "/usr/bin/sandbox-exec";

const fixture = {
  description: "Harmless fixture",
  executable: "printf",
  args: ["%s", "literal; $HOME"],
  parameters: {},
  timeoutMs: 3000,
  executionClass: "validation",
  concurrency: "exclusive"
} satisfies CommandDefinition;

/**
A private workspace, scratch and cache, with the system binaries and the
running Node binary trusted -- the same toolchain roots the Runtime admits
for a real command.
*/
function scopeFixture(root: string): ApprovedCommandScope {
  const base = mkdtempSync(path.join(root, "scope-"));
  const workspace = path.join(base, "workspace");
  const scratch = path.join(base, "scratch");
  const cache = path.join(base, "cache");
  for (const directory of [workspace, scratch, cache]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const nodeDirectory = path.dirname(NODE);
  return {
    workspace,
    scratch,
    cache,
    toolchainRoots: [
      path.dirname(SHELL),
      nodeDirectory,
      path.dirname(nodeDirectory)
    ],
    executables: { sh: SHELL, node: NODE }
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /*
already gone
*/
  }
}

/**
The script a confined command runs: it starts one descendant in the command's
own process group and one that detaches into a session of its own, it records
both process ids in the workspace, and it then stays alive so the command's
tree is intact while the test observes it.
*/
function spawnScript(pidFile: string): string {
  return [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const group = spawn("/bin/sleep", ["120"], { stdio: "ignore" });',
    'const detached = spawn("/bin/sleep", ["120"], { detached: true, stdio: "ignore" });',
    "detached.unref();",
    `writeFileSync(${JSON.stringify(pidFile)}, group.pid + " " + detached.pid);`,
    "setInterval(() => {}, 1000);"
  ].join(" ");
}

function readPids(pidFile: string): { group: number; detached: number } {
  const [group, detached] = readFileSync(pidFile, "utf8")
    .trim()
    .split(/\s+/u, 2);
  return { group: Number(group), detached: Number(detached) };
}

/**
The process groups the operating system reports, recorded continuously.

A detached descendant does not stay alive: the executor terminates it on its
own sweep, a few hundred milliseconds after the command started. Sampling the
listing once, after the fixture has reported its process ids, can therefore
miss it entirely on a loaded runner. Recording the listing continuously keeps
the sighting the assertion is about.

Every group a process was ever seen in is kept, because a process that
detaches is briefly visible in its parent's group before it has called
setsid().
*/
function startProcessGroupRecorder(): {
  readonly groupsByPid: Map<string, Set<string>>;
  stop(): void;
} {
  const groupsByPid = new Map<string, Set<string>>();
  let isRecording = true;
  const record = (): void => {
    if (!isRecording) return;
    let listing: string;
    try {
      listing = execFileSync("/bin/ps", ["-A", "-o", "pid=", "-o", "pgid="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return;
    }
    for (const line of listing.split("\n")) {
      const [pid, group] = line.trim().split(/\s+/u, 2);
      if (!pid || !group) continue;
      let seen = groupsByPid.get(pid);
      if (!seen) {
        seen = new Set<string>();
        groupsByPid.set(pid, seen);
      }
      seen.add(group);
    }
  };
  record();
  const timer = setInterval(record, 50);
  timer.unref();
  return {
    groupsByPid,
    stop() {
      isRecording = false;
      clearInterval(timer);
    }
  };
}

/**
Wait until the operating system has reported both descendants.

The recording is sampled, so a descendant the fixture has just spawned may
not be in it yet.
*/
async function waitForRecorded(
  recorder: { readonly groupsByPid: Map<string, Set<string>> },
  pids: { group: number; detached: number }
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      recorder.groupsByPid.has(String(pids.group)) &&
      recorder.groupsByPid.has(String(pids.detached))
    )
      return;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

async function waitForPids(
  pidFile: string
): Promise<{ group: number; detached: number }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pids = readPids(pidFile);
      if (
        Number.isSafeInteger(pids.group) &&
        Number.isSafeInteger(pids.detached)
      ) {
        return pids;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("The confined command never recorded its descendants.");
}

test(
  "a cancelled command leaves no descendant running, not even a detached one",
  {
    skip: process.platform !== "darwin" || !existsSync(SANDBOX)
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-tree-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const pidFile = path.join(scope.workspace, "descendants.pid");
    const definition = {
      ...fixture,
      executable: "sh",
      args: [
        "-c",
        `${JSON.stringify(NODE)} -e ${JSON.stringify(spawnScript(pidFile))}`
      ],
      timeoutMs: 60_000
    } satisfies CommandDefinition;
    const controller = new AbortController();
    const pending = runApprovedCommand(
      "cancelled",
      definition,
      definition.args,
      scope,
      controller.signal
    );
    const pids = await waitForPids(pidFile);
    t.after(() => {
      killIfAlive(pids.group);
      killIfAlive(pids.detached);
    });
    assert.equal(
      isAlive(pids.detached),
      true,
      "the detached descendant started"
    );
    controller.abort();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    // The descendant that stayed in the command's group is gone with it.
    assert.equal(isAlive(pids.group), false);
    // The descendant that detached into its own session is gone too.
    assert.equal(isAlive(pids.detached), false);
  }
);

test(
  "an expired command leaves no descendant running, not even a detached one",
  {
    skip: process.platform !== "darwin" || !existsSync(SANDBOX)
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-timeout-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const pidFile = path.join(scope.workspace, "descendants.pid");
    const definition = {
      ...fixture,
      executable: "sh",
      args: [
        "-c",
        `${JSON.stringify(NODE)} -e ${JSON.stringify(spawnScript(pidFile))}`
      ],
      timeoutMs: 2000
    } satisfies CommandDefinition;
    const pending = runApprovedCommand(
      "expired",
      definition,
      definition.args,
      scope,
      AbortSignal.timeout(30_000)
    );
    const pids = await waitForPids(pidFile);
    t.after(() => {
      killIfAlive(pids.group);
      killIfAlive(pids.detached);
    });
    const result = await pending;
    assert.equal(result.status, "timed_out");
    assert.equal(isAlive(pids.group), false);
    assert.equal(isAlive(pids.detached), false);
  }
);

test(
  "a descendant that detached is terminated while its command is still running",
  {
    skip: process.platform !== "darwin" || !existsSync(SANDBOX)
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-stray-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const pidFile = path.join(scope.workspace, "descendants.pid");
    const definition = {
      ...fixture,
      executable: "sh",
      args: [
        "-c",
        `${JSON.stringify(NODE)} -e ${JSON.stringify(spawnScript(pidFile))}`
      ],
      timeoutMs: 60_000
    } satisfies CommandDefinition;
    const controller = new AbortController();
    const pending = runApprovedCommand(
      "stray",
      definition,
      definition.args,
      scope,
      controller.signal
    );
    const pids = await waitForPids(pidFile);
    t.after(() => {
      killIfAlive(pids.group);
      killIfAlive(pids.detached);
    });
    // The command is still running, so the descendant that left its process
    // group is terminated on its own rather than left behind.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && isAlive(pids.detached)) {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    assert.equal(isAlive(pids.detached), false);
    // The descendant that stayed in the command's group is the command's own
    // business and is still running.
    assert.equal(isAlive(pids.group), true);
    controller.abort();
    await pending;
  }
);

test(
  "the process tree is read from the operating system, not from the command",
  {
    skip: process.platform !== "darwin" || !existsSync(SANDBOX)
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-tree-read-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const pidFile = path.join(scope.workspace, "descendants.pid");
    const definition = {
      ...fixture,
      executable: "sh",
      args: [
        "-c",
        `${JSON.stringify(NODE)} -e ${JSON.stringify(spawnScript(pidFile))}`
      ],
      timeoutMs: 60_000
    } satisfies CommandDefinition;
    const controller = new AbortController();
    // The listing is recorded from before the command starts, so the
    // detached descendant is seen even though the executor terminates it on
    // its own sweep moments later.
    const recorder = startProcessGroupRecorder();
    t.after(() => recorder.stop());
    const pending = runApprovedCommand(
      "tree",
      definition,
      definition.args,
      scope,
      controller.signal
    );
    const pids = await waitForPids(pidFile);
    t.after(() => {
      killIfAlive(pids.group);
      killIfAlive(pids.detached);
    });
    // The operating system reports both descendants of the command, and it
    // reports the detached one in a process group of its own.
    await waitForRecorded(recorder, pids);
    const groupChild = recorder.groupsByPid.get(String(pids.group));
    const detachedChild = recorder.groupsByPid.get(String(pids.detached));
    assert.ok(groupChild, "the operating system never reported the descendant");
    assert.ok(
      detachedChild,
      "the operating system never reported the detached descendant"
    );
    assert.ok(
      [...detachedChild].some((group) => !groupChild.has(group)),
      "the detached descendant left the command's process group"
    );
    controller.abort();
    await pending;
  }
);
