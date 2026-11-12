import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  captureCliVersion,
  parseCliVersion,
  providerCliCommand,
  providerCliName,
  ProviderCliVersionService} from "../src/providers/cli-versions.ts";

/**
 * A child process that prints `output` and exits, without starting anything.
 *
 * The version read is the only place the Runtime starts a provider's CLI, so
 * the tests start a fake one: the real CLIs are not installed on every
 * machine that runs the suite, and a test that depended on one would fail
 * for a reason that has nothing to do with the code under test.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly killed: string[] = [];

  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }
}

function fakeSpawn(
  output: string,
  exitCode = 0
): {
  spawnProcess: typeof import("node:child_process").spawn;
  child: FakeChild;
} {
  const child = new FakeChild();
  const spawnProcess = (() => {
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(output, "utf8"));
      child.emit("close", exitCode);
    });
    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnProcess, child };
}

test("the version is read from the output shapes the CLIs actually print", () => {
  // `claude --version` prints the number and then the product name.
  assert.equal(parseCliVersion("2.1.280 (Claude Code)"), "2.1.280");
  // `codex --version` names the program first.
  assert.equal(parseCliVersion("codex-cli 0.154.0"), "0.154.0");
  // `agy --version` prints the number on its own.
  assert.equal(parseCliVersion("1.5.3"), "1.5.3");
  // A pre-release keeps its suffix, because that is the version.
  assert.equal(parseCliVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  // Output with no version in it is not a version.
  assert.equal(parseCliVersion("command not found"), null);
  assert.equal(parseCliVersion(""), null);
});

test("a provider's CLI is named by the command an operator would type", () => {
  // The resolver only reports a CLI that is there to be run, so the paths
  // point at an executable that exists rather than at one that does not.
  const env = {
    CLAUDE_BIN: process.execPath,
    AGY_CLI_PATH: process.execPath
  } as NodeJS.ProcessEnv;
  assert.equal(providerCliCommand("claude", env)?.command, "claude");
  assert.equal(providerCliCommand("claude", env)?.program, process.execPath);
  // Every Antigravity provider is served by the one agy CLI.
  for (const provider of [
    "antigravity-gemini",
    "antigravity-argon",
    "antigravity-claude-gpt"
  ]) {
    assert.equal(providerCliCommand(provider, env)?.command, "agy");
    assert.equal(providerCliCommand(provider, env)?.program, process.execPath);
  }
  // The name of each provider's CLI is known whether or not the CLI is
  // installed, so a provider whose CLI is missing is still named.
  assert.equal(providerCliName("codex"), "codex");
  assert.equal(providerCliName("minimax"), "mmx");
  assert.equal(providerCliName("copilot"), "copilot");
  assert.equal(providerCliName("opencli-chatgpt"), "opencli");
  assert.equal(providerCliName("opencli-gemini"), "opencli");
  // A provider that is not served by a local CLI has none.
  assert.equal(providerCliName("not-a-provider"), null);
  assert.equal(providerCliCommand("not-a-provider", env), null);
});

test("a CLI that is not installed has no command to run", () => {
  // An empty PATH and a home with no install: the CLI is not on this machine.
  const env = { PATH: "", HOME: "/nonexistent-home" } as NodeJS.ProcessEnv;
  assert.equal(providerCliCommand("claude", env), null);
  assert.equal(providerCliCommand("antigravity-gemini", env), null);
  assert.equal(providerCliCommand("minimax", env), null);
  assert.equal(providerCliCommand("copilot", env), null);
});

test("the version read is the version the CLI printed", async () => {
  const { spawnProcess } = fakeSpawn("2.1.280 (Claude Code)\n");
  const capture = await captureCliVersion(
    { command: "claude", program: "/opt/bin/claude", args: [] },
    { spawnProcess }
  );
  assert.deepEqual(capture, { ok: true, version: "2.1.280" });
});

test("a CLI that prints no version is not read as one", async () => {
  const { spawnProcess } = fakeSpawn("command not found\n", 127);
  const capture = await captureCliVersion(
    { command: "mmx", program: "/opt/bin/mmx", args: [] },
    { spawnProcess }
  );
  assert.equal(capture.ok, false);
  assert.equal(
    capture.ok ? "" : capture.reason,
    "The mmx CLI exited with status 127 without reporting a version."
  );
});

test("a CLI that hangs is stopped rather than waited for", async () => {
  const child = new FakeChild();
  const spawnProcess = (() =>
    child) as unknown as typeof import("node:child_process").spawn;
  const capture = await captureCliVersion(
    { command: "codex", program: "/opt/bin/codex", args: [] },
    { spawnProcess },
    20
  );
  assert.equal(capture.ok, false);
  assert.equal(
    capture.ok ? "" : capture.reason,
    "Reading the codex CLI's version timed out."
  );
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("the service reports the version it read and the reason for the one it could not", async () => {
  const service = new ProviderCliVersionService({
    providerIds: () => ["claude", "codex"],
    env: { PATH: "", HOME: "/nonexistent-home" } as NodeJS.ProcessEnv,
    now: () => new Date("2026-11-09T12:00:00.000Z"),
    locate: (provider) => ({
      command: provider,
      program: `/opt/bin/${provider}`,
      args: []
    }),
    capture: (command) =>
      command.command === "codex"
        ? Promise.resolve({ ok: true, version: "0.154.0" })
        : Promise.resolve({
            ok: false,
            reason: "The claude CLI did not report a version."
          })
  });
  await service.refresh();
  const snapshot = service.snapshot();
  assert.equal(snapshot.schema, "autodev-control-provider-versions-v1");
  assert.equal(snapshot.source, "runtime-provider-cli-versions");
  const claude = snapshot.providers.find(
    (entry) => entry.provider === "claude"
  );
  const codex = snapshot.providers.find((entry) => entry.provider === "codex");
  // The Codex CLI answered, so its version is the one it reported.
  assert.deepEqual(codex?.cli, {
    status: "observed",
    command: "codex",
    version: "0.154.0",
    observedAt: "2026-11-09T12:00:00.000Z"
  });
  // The Claude CLI is installed but would not answer, which is a different
  // fact from "it is not installed".
  assert.equal(claude?.cli.status, "unavailable");
  assert.equal(
    claude?.cli.status === "unavailable" ? claude.cli.kind : "",
    "not-readable"
  );
  assert.equal(
    claude?.cli.status === "unavailable" ? claude.cli.command : "",
    "claude"
  );
});

test("providers served by the same CLI share one version read per refresh", async () => {
  const reads: string[] = [];
  const service = new ProviderCliVersionService({
    providerIds: () => [
      "antigravity-gemini",
      "antigravity-argon",
      "antigravity-claude-gpt"
    ],
    env: { PATH: "", HOME: "/nonexistent-home" } as NodeJS.ProcessEnv,
    now: () => new Date("2026-11-09T12:00:00.000Z"),
    locate: () => ({ command: "agy", program: "/opt/bin/agy", args: [] }),
    capture: (command) => {
      reads.push(command.program);
      return Promise.resolve({ ok: true, version: "1.5.3" });
    }
  });
  await service.refresh();
  assert.deepEqual(reads, ["/opt/bin/agy"]);
  assert.deepEqual(
    service.snapshot().providers.map((entry) => entry.cli.status),
    ["observed", "observed", "observed"]
  );
});

test("a CLI that is not installed is reported as not installed", async () => {
  const service = new ProviderCliVersionService({
    providerIds: () => ["claude"],
    env: { PATH: "", HOME: "/nonexistent-home" } as NodeJS.ProcessEnv,
    now: () => new Date("2026-11-09T12:00:00.000Z"),
    locate: () => null
  });
  await service.refresh();
  const entry = service
    .snapshot()
    .providers.find((candidate) => candidate.provider === "claude");
  assert.equal(entry?.cli.status, "unavailable");
  assert.equal(
    entry?.cli.status === "unavailable" ? entry.cli.kind : "",
    "not-installed"
  );
  assert.equal(
    entry?.cli.status === "unavailable" ? entry.cli.command : "",
    "claude"
  );
});

test("a version nobody has read yet is not a version of zero", () => {
  const service = new ProviderCliVersionService({
    providerIds: () => ["claude"]
  });
  const entry = service
    .snapshot()
    .providers.find((candidate) => candidate.provider === "claude");
  assert.equal(entry?.cli.status, "unavailable");
  assert.equal(
    entry?.cli.status === "unavailable" ? entry.cli.lastAttemptAt : "",
    null
  );
});

test("every provider gets an entry, including the ones with no CLI", async () => {
  const service = new ProviderCliVersionService({
    providerIds: () => ["claude", "not-a-provider"],
    env: { PATH: "", HOME: "/nonexistent-home" } as NodeJS.ProcessEnv,
    locate: (provider) =>
      provider === "claude"
        ? { command: "claude", program: "/opt/bin/claude", args: [] }
        : null
  });
  await service.refresh();
  const providers = service.snapshot().providers.map((entry) => entry.provider);
  assert.deepEqual(providers, ["claude", "not-a-provider"]);
  const unknown = service
    .snapshot()
    .providers.find((entry) => entry.provider === "not-a-provider");
  assert.equal(
    unknown?.cli.status === "unavailable" ? unknown.cli.reason : "",
    "This provider is not served by a local CLI."
  );
});
