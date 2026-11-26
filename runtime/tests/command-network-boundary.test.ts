/**
The network boundary of a confined command, proved against the real operating
system.

The Seatbelt profile names the one network peer a dependency install may
reach: the registry proxy's own loopback port. A profile that only says so
is a claim, not a boundary. These tests drive the real executor under the
real profile and show that an unapproved peer is refused by the operating
system, and that the approved one is not.
*/
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CommandDefinition } from "../src/mcp/commands-catalogue.ts";
import {
  type ApprovedCommandScope,
  runApprovedCommand
} from "../src/mcp/commands-execution.ts";
import { startRegistryProxy } from "../src/mcp/commands-registry-proxy.ts";

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

/**
The script a confined command runs to open a connection to a loopback port.

It reports what happened rather than what it meant to happen: the operating
system's own answer is the only evidence that matters here.
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

async function connectThroughSandbox(
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

test(
  "a confined command reaches the registry proxy's port and nothing else",
  {
    skip: process.platform !== "darwin" || !existsSync(SANDBOX)
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-network-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // An unapproved peer on loopback: the kind of service a compromised
    // package's install script would try to reach.
    const unapproved = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    unapproved.listen(0, "127.0.0.1");
    await once(unapproved, "listening");
    const unapprovedPort = (unapproved.address() as AddressInfo).port;
    const registry = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ dist: { tarball: "http://127.0.0.1/x.tgz" } })
      );
    });
    registry.listen(0, "127.0.0.1");
    await once(registry, "listening");
    const registryOrigin = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
    const proxy = await startRegistryProxy({ registry: registryOrigin });
    try {
      // A command that is not a dependency install has no network at all.
      const withoutRegistry = await connectThroughSandbox(
        scopeFixture(root),
        unapprovedPort,
        "validation"
      );
      assert.notEqual(withoutRegistry, "connected");
      assert.match(withoutRegistry, /refused/u);

      // A dependency install reaches the registry proxy and nothing else.
      const withRegistry = {
        ...scopeFixture(root),
        registryEndpoint: proxy.endpoint
      };
      const toProxy = await connectThroughSandbox(
        withRegistry,
        proxy.port,
        "dependency_install"
      );
      assert.equal(toProxy, "connected");
      const toUnapproved = await connectThroughSandbox(
        withRegistry,
        unapprovedPort,
        "dependency_install"
      );
      assert.notEqual(toUnapproved, "connected");
      assert.match(toUnapproved, /refused/u);
    } finally {
      await proxy.close();
      unapproved.closeAllConnections();
      registry.closeAllConnections();
      await new Promise<void>((resolve) => unapproved.close(() => resolve()));
      await new Promise<void>((resolve) => registry.close(() => resolve()));
    }
  }
);
