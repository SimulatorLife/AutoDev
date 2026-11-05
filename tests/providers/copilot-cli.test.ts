import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runCopilot } from "@simulatorlife/autodev-runtime/providers/copilot";
import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";

/**
 * A Copilot CLI installed by npm under nvm -- where the GitHub installer puts
 * it, and where no launchd PATH names it. The launcher is a `#!/usr/bin/env
 * node` script, so the Node that runs it is whichever `node` its PATH names
 * first.
 */
function versionManagedCli(home: string, capture: string): string {
  const directory = join(home, ".nvm", "versions", "node", "v25.0.0", "bin");
  mkdirSync(directory, { recursive: true });
  const binary = join(directory, "copilot");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  started: true,
  path: process.env.PATH
}));
console.log(JSON.stringify({
  type: "assistant.message_start",
  data: { messageId: "message-1", phase: "final_answer" }
}));
console.log(JSON.stringify({
  type: "assistant.message_delta",
  data: {
    messageId: "message-1",
    phase: "final_answer",
    deltaContent: "copilot answer"
  }
}));
console.log(JSON.stringify({ type: "result", data: { exitCode: 0 } }));
`,
    { mode: 0o755 }
  );
  chmodSync(binary, 0o755);
  return binary;
}

/**
 * The environment the managed runtime runs the bridge in: launchd's PATH,
 * which names no version manager's bin directory and no Node of its own on
 * Apple Silicon.
 */
function launchdEnvironment(
  home: string,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  // The bridge fails closed without its MCP catalogue, so the fixture home
  // carries one holding every server the default role is granted.
  const catalogue = join(home, ".codex", "provider-runtime");
  mkdirSync(catalogue, { recursive: true });
  const servers: Record<string, unknown> = {};
  for (const name of roleContract(null).mcp)
    servers[name] = { command: "/usr/bin/true", args: [] };
  writeFileSync(join(catalogue, "mcp-servers.json"), JSON.stringify(servers));
  return {
    HOME: home,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    ...overrides
  };
}

function withEnvironment(
  env: NodeJS.ProcessEnv,
  run: () => Promise<void>
): Promise<void> {
  const previous = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    COPILOT_BIN: process.env.COPILOT_BIN
  };
  Object.assign(process.env, env);
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("the Copilot bridge runs a CLI that no PATH names", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "autodev-copilot-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const capture = join(home, "capture.json");
  versionManagedCli(home, capture);

  let answer = "";
  await withEnvironment(launchdEnvironment(home), async () => {
    const result = await runCopilot("task", "copilot", home);
    answer = result.text;
  });

  assert.equal(answer, "copilot answer");
  const observed = JSON.parse(readFileSync(capture, "utf8")) as {
    started: boolean;
    path: string;
  };
  assert.equal(observed.started, true);
  // The CLI's own launcher is a `#!/usr/bin/env node` script, so the Node
  // that runs it comes from its PATH. The bridge runs under the native Node
  // the installer resolved, and that one has to come first: launchd's PATH
  // names an Intel build on Apple Silicon.
  const separator = observed.path.indexOf(":");
  assert.equal(
    separator === -1 ? observed.path : observed.path.slice(0, separator),
    dirname(process.execPath),
    "the CLI runs under the bridge's own Node"
  );
});

test("the Copilot bridge reports a CLI it cannot find", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "autodev-copilot-missing-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  await assert.rejects(
    withEnvironment(launchdEnvironment(home), async () => {
      await runCopilot("task", "copilot", home);
    }),
    /Copilot CLI not found/
  );
});
