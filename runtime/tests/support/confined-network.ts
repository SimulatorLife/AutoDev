/**
The confined network fixtures the Commands MCP boundary tests share.

A confined command runs under the Runtime's own Seatbelt profile. These
helpers build the private workspace, scratch and cache such a command runs in,
and run a small program inside it that reports what the operating system
answered when it opened a connection. The operating system's own answer is
the only evidence a boundary exists; a profile that merely says so is a claim.
*/
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";

import type { CommandDefinition } from "../../src/mcp/commands-catalogue.ts";
import {
  type ApprovedCommandScope,
  runApprovedCommand
} from "../../src/mcp/commands-execution.ts";

const SHELL = realpathSync("/bin/sh");
const NODE = realpathSync(process.execPath);
const SANDBOX = "/usr/bin/sandbox-exec";

/**
Whether this machine can confine a command at all.
*/
export const hasSandbox: boolean =
  process.platform === "darwin" && existsSync(SANDBOX);

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
export function scopeFixture(root: string): ApprovedCommandScope {
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

/**
The script a confined command runs to open a connection to a loopback port.

It reports what happened rather than what it meant to happen.
*/
function connectScript(port: number): string {
  return [
    'const net = require("node:net");',
    `const socket = net.connect({ host: "127.0.0.1", port: ${port} });`,
    "socket.setTimeout(4000);",
    'socket.on("connect", () => { console.log("connected"); socket.destroy(); process.exit(0); });',
    'socket.on("error", (error) => { console.log("refused:" + error.code); process.exit(0); });',
    'socket.on("timeout", () => { console.log("timeout"); process.exit(0); });'
  ].join(" ");
}

/**
Open the same connection without any confinement, as the control a confined
refusal is measured against: a peer that answers here is reachable in
principle, so a refusal inside the sandbox is the boundary at work rather
than a peer that was never listening.
*/
export async function connectWithoutSandbox(port: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(4000);
    socket.on("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      resolve(`refused:${error.code}`)
    );
    socket.on("timeout", () => {
      socket.destroy();
      resolve("timeout");
    });
  });
}

/**
Open a connection to a loopback port from inside the sandbox, and report what
the operating system answered.
*/
export async function connectThroughSandbox(
  scope: ApprovedCommandScope,
  port: number,
  executionClass: CommandDefinition["executionClass"]
): Promise<string> {
  const definition = {
    ...fixture,
    executable: "sh",
    args: [
      "-c",
      `${JSON.stringify(NODE)} -e ${JSON.stringify(connectScript(port))}`
    ],
    timeoutMs: 30_000,
    executionClass
  } satisfies CommandDefinition;
  const result = await runApprovedCommand(
    "connect",
    definition,
    definition.args,
    scope,
    AbortSignal.timeout(60_000)
  );
  return result.stdout.trim();
}
