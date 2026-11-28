/**
The workspace lease, and the recovery from a lease nobody released.

A lease keeps two sessions from running commands against one workspace at the
same time. It is taken when a command starts and released when it finishes,
so a server that dies in between leaves the lease behind and the workspace
closed. The lease records who held it and which command it protected, so
that an abandoned lease can be told from a live one instead of blocking the
workspace forever.
*/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runApprovedCommand } from "../src/mcp/commands-execution.ts";
import {
  createWorkspaceLease,
  inspectCommandLeases,
  releaseCommandLease
} from "../src/mcp/commands-main.ts";

const WORKSPACE_KEY = "workspace-key";
const PRINTF = realpathSync("/usr/bin/printf");

/**
A process id that is certainly not running.

`execFileSync` waits for the process it started to exit, so the id it
reports belongs to a process the operating system has already reaped, and
macOS does not reuse a process id until it wraps around.
*/
function exitedProcessId(): number {
  const output = execFileSync("/bin/sh", ["-c", "echo $$; exit 0"], {
    encoding: "utf8"
  });
  const pid = Number(output.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "the shell reported no pid");
  return pid;
}

test("a workspace lease is exclusive across sessions and released on completion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    const held = lease.tryAcquire();
    assert.ok(held);
    assert.equal(lease.tryAcquire(), null);
    held.release();
    const second = lease.tryAcquire();
    assert.ok(second);
    second.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old lease is not proof that its command stopped", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    const held = lease.tryAcquire();
    assert.ok(held);
    const lock = path.join(root, `command-${WORKSPACE_KEY}.lock`);
    const old = new Date(0);
    utimesSync(lock, old, old);
    assert.equal(lease.tryAcquire(), null);
    // Even an operator-replaced lock is not ours to release.
    rmSync(lock);
    writeFileSync(lock, "replacement");
    held.release();
    assert.equal(readFileSync(lock, "utf8"), "replacement");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lease never acquires or removes a lock in a replacement run directory", () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "autodev-command-replaced-run-")
  );
  try {
    const run = path.join(root, "run");
    const retired = path.join(root, "retired");
    const lease = createWorkspaceLease(run, WORKSPACE_KEY);
    const held = lease.tryAcquire();
    assert.ok(held);
    renameSync(run, retired);
    mkdirSync(run, { mode: 0o700 });
    const lock = path.join(run, `command-${WORKSPACE_KEY}.lock`);
    writeFileSync(lock, "replacement");
    assert.equal(lease.tryAcquire(), null);
    held.release();
    assert.equal(readFileSync(lock, "utf8"), "replacement");
    rmSync(lock);
    assert.equal(lease.tryAcquire(), null);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a settled lease whose holder and command are both gone is taken over", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    const held = lease.tryAcquire();
    assert.ok(held);
    // The executor proved cleanup before the server died, but the lock
    // survived. Dead root and holder PIDs alone would not prove this.
    held.noteCommand(exitedProcessId());
    writeLeaseRecord(root, {
      holder: exitedProcessId(),
      command: exitedProcessId(),
      settled: true
    });
    const taken = lease.tryAcquire();
    assert.ok(taken, "an abandoned lease kept the workspace closed");
    taken.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsettled leases remain closed even after the holder and root exit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    const held = lease.tryAcquire();
    assert.ok(held);
    const command = exitedProcessId();
    held.noteCommand(command);
    held.release(false);
    const lock = path.join(root, `command-${WORKSPACE_KEY}.lock`);
    assert.equal(
      readFileSync(lock, "utf8"),
      `holder=${process.pid}\ncommand=${command}\n`
    );
    assert.equal(lease.tryAcquire(), null);
    // Simulate the broker later exiting. Its root also exited, but the
    // unverified descendants may still be running.
    writeLeaseRecord(root, { holder: exitedProcessId(), command });
    assert.equal(inspectCommandLeases(root)[0]!.state, "unverifiable");
    assert.equal(lease.tryAcquire(), null);
    assert.equal(
      releaseCommandLease(root, WORKSPACE_KEY, { force: false }).released,
      false
    );
    assert.equal(
      releaseCommandLease(root, WORKSPACE_KEY, { force: true }).released,
      true
    );
    const next = lease.tryAcquire();
    assert.ok(next);
    next.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lease whose holder is still running is never taken over, even when its command has finished", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    // The holder is this very process and the command it protected has
    // finished: the holder is still there to release the lease itself.
    writeLeaseRecord(root, {
      holder: process.pid,
      command: exitedProcessId()
    });
    assert.equal(lease.tryAcquire(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lease whose command is still running is never taken over", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    // The holder is gone, but the command it protected is this very
    // process, so the workspace is not idle.
    writeLeaseRecord(root, {
      holder: exitedProcessId(),
      command: process.pid,
      settled: true
    });
    assert.equal(lease.tryAcquire(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lease whose command was never recorded is never taken over", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    // The holder is gone and no command was ever recorded, so the lease
    // cannot say whether a command is still running.
    writeLeaseRecord(root, { holder: exitedProcessId() });
    assert.equal(lease.tryAcquire(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lease with an unreadable record is never taken over", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    writeFileSync(
      path.join(root, `command-${WORKSPACE_KEY}.lock`),
      "holder=not-a-pid\n",
      { mode: 0o600 }
    );
    assert.equal(lease.tryAcquire(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the operator sees what each lease is, and releases only what is provable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    const held = lease.tryAcquire();
    assert.ok(held);
    held.noteCommand(process.pid);

    const reports = inspectCommandLeases(root);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.workspaceKey, WORKSPACE_KEY);
    assert.equal(reports[0]!.state, "held");
    assert.equal(reports[0]!.holder, process.pid);
    assert.equal(reports[0]!.isHolderAlive, true);
    assert.equal(reports[0]!.command, process.pid);
    assert.equal(reports[0]!.isCommandAlive, true);

    // A lease that is held is never released, however it is asked for.
    const refused = releaseCommandLease(root, WORKSPACE_KEY, { force: true });
    assert.equal(refused.released, false);
    assert.match(refused.reason, /running server/u);

    // The lease is released on recorded settlement and dead processes.
    writeLeaseRecord(root, {
      holder: exitedProcessId(),
      command: exitedProcessId(),
      settled: true
    });
    const released = releaseCommandLease(root, WORKSPACE_KEY, { force: false });
    assert.equal(released.released, true);
    assert.equal(
      existsSync(path.join(root, `command-${WORKSPACE_KEY}.lock`)),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the operator releases a lease that cannot be verified only by force", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    writeLeaseRecord(root, { holder: exitedProcessId() });
    const reports = inspectCommandLeases(root);
    assert.equal(reports[0]!.state, "unverifiable");

    const refused = releaseCommandLease(root, WORKSPACE_KEY, { force: false });
    assert.equal(refused.released, false);
    assert.match(refused.reason, /cannot be verified/u);
    assert.equal(
      existsSync(path.join(root, `command-${WORKSPACE_KEY}.lock`)),
      true
    );

    const forced = releaseCommandLease(root, WORKSPACE_KEY, { force: true });
    assert.equal(forced.released, true);
    assert.equal(
      existsSync(path.join(root, `command-${WORKSPACE_KEY}.lock`)),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("there is no lease to release for a workspace that holds none", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const outcome = releaseCommandLease(root, WORKSPACE_KEY, { force: true });
    assert.equal(outcome.released, false);
    assert.match(outcome.reason, /no readable lease/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lease records the command that ran, and the operating system agrees it ran", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, WORKSPACE_KEY);
    const held = lease.tryAcquire();
    assert.ok(held);
    const workspace = path.join(root, "workspace");
    const scratch = path.join(root, "scratch");
    const cache = path.join(root, "cache");
    for (const directory of [workspace, scratch, cache]) {
      mkdirSync(directory, { mode: 0o700 });
    }
    const result = await runApprovedCommand(
      "fixture",
      {
        description: "Print a literal",
        executable: "printf",
        args: ["%s", "literal"],
        parameters: {},
        timeoutMs: 3000,
        executionClass: "validation",
        concurrency: "exclusive"
      },
      ["%s", "literal"],
      {
        workspace,
        scratch,
        cache,
        toolchainRoots: [path.dirname(PRINTF)],
        executables: { printf: PRINTF }
      },
      AbortSignal.timeout(30_000),
      (pid) => held.noteCommand(pid)
    );
    assert.equal(result.status, "succeeded", result.stderr);
    const reports = inspectCommandLeases(root);
    assert.equal(reports.length, 1);
    // The holder is the server that took the lease; the command is the
    // separate process it started, and that process has finished.
    assert.equal(reports[0]!.holder, process.pid);
    assert.equal(reports[0]!.isHolderAlive, true);
    assert.ok(
      reports[0]!.command !== null && reports[0]!.command !== process.pid,
      "the lease did not record the command it started"
    );
    assert.equal(reports[0]!.isCommandAlive, false);
    held.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
Write the record a lease file holds, as the server that took it would have.
*/
function writeLeaseRecord(
  run: string,
  record: {
    readonly holder: number;
    readonly command?: number;
    readonly settled?: boolean;
  }
): void {
  const lines = [`holder=${record.holder}`];
  if (record.command !== undefined) lines.push(`command=${record.command}`);
  if (record.settled) lines.push("settled=1");
  writeFileSync(
    path.join(run, `command-${WORKSPACE_KEY}.lock`),
    lines.join("\n") + "\n",
    { mode: 0o600 }
  );
}
