import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { z } from "zod";

import {
  CommandCatalogueError,
  type CommandDefinition,
  type CommandResult,
  commandInputSchema,
  parseCommandCatalogue,
  resolveCommandArguments
} from "../src/mcp/commands-catalogue.ts";
import {
  type ApprovedCommandScope,
  commandSandboxProfile,
  commandWorkspaceKey,
  prepareCommand,
  resolveTrustedExecutables,
  runApprovedCommand
} from "../src/mcp/commands-execution.ts";
import {
  approvedCataloguePath,
  catalogueDigest,
  commandCacheRoot,
  commandScratchRoot,
  createApprovedCatalogueGrant,
  createWorkspaceLease,
  resolveCommandsScope
} from "../src/mcp/commands-main.ts";
import {
  classifyRegistryPath,
  rewriteRegistryUrls,
  startRegistryProxy
} from "../src/mcp/commands-registry-proxy.ts";
import {
  CommandTaskStore,
  isCommandEligibleInWorkspace,
  createCommandsMcpServer,
  effectiveCommands
} from "../src/mcp/commands-server.ts";
import {
  configureCommandExecutionTelemetry,
  recordCommandExecutionSpan,
  setTestExporter,
  shutdownTelemetryForTest
} from "../src/mcp/mcp-telemetry.ts";

const PRINTF = realpathSync("/usr/bin/printf");
const SHELL = realpathSync("/bin/sh");

const fixture = {
  description: "Harmless fixture",
  executable: "printf",
  args: ["%s", "literal; $HOME"],
  parameters: {},
  timeoutMs: 3000,
  executionClass: "validation",
  concurrency: "exclusive"
} satisfies CommandDefinition;

const catalogue = { version: 1, commands: { fixture } };

/**
A private workspace, scratch and cache, with the system binaries trusted.
*/
function scopeFixture(root: string): ApprovedCommandScope {
  const base = mkdtempSync(path.join(root, "scope-"));
  const workspace = path.join(base, "workspace");
  const scratch = path.join(base, "scratch");
  const cache = path.join(base, "cache");
  for (const directory of [workspace, scratch, cache]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  return {
    workspace,
    scratch,
    cache,
    toolchainRoots: [path.dirname(PRINTF), path.dirname(SHELL)],
    executables: { printf: PRINTF, sh: SHELL }
  };
}

test("command execution spans reuse the MCP tracer without double-counting or leaking command content", async () => {
  const exporter = new InMemorySpanExporter();
  configureCommandExecutionTelemetry("worker", "owner/repository");
  setTestExporter(exporter);
  try {
    const outcome: CommandResult = {
      commandId: "test",
      status: "failed",
      exitCode: 3,
      durationMs: 42,
      stdout: "private-command-output",
      stderr: "private-error-output",
      outputTruncated: false
    };
    let calls = 0;
    const result = await recordCommandExecutionSpan("test", "validation", async () => {
      calls += 1;
      return outcome;
    }, { sessionId: "private-session-id" });
    assert.equal(result, outcome);
    const failure = new Error("private-exception-message");
    await assert.rejects(
      recordCommandExecutionSpan("typecheck", "validation", async () => {
        calls += 1;
        throw failure;
      }),
      (error: unknown) => error === failure
    );
    assert.equal(calls, 2);
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    for (const span of spans) {
      assert.equal(span.name, "command.execute");
      assert.equal(span.attributes["mcp.method.name"], undefined);
      assert.equal(span.attributes["gen_ai.operation.name"], undefined);
      assert.equal(span.resource.attributes["service.name"], "autodev-commands-mcp");
      assert.equal(span.resource.attributes["autodev.agent.role"], "worker");
      assert.equal(span.resource.attributes["autodev.workspace"], "owner/repository");
      assert.doesNotMatch(JSON.stringify(span.attributes), /private-/u);
      assert.equal(span.events.length, 0);
    }
    assert.equal(spans[0]?.attributes["autodev.command.outcome"], "failed");
    assert.equal(spans[0]?.attributes["autodev.command.exit_code"], 3);
    assert.equal(spans[0]?.attributes["autodev.command.duration_ms"], 42);
    assert.equal(spans[1]?.attributes["autodev.command.outcome"], "infrastructure_error");
    assert.equal(spans[1]?.attributes["autodev.command.exit_code"], undefined);
  } finally {
    await shutdownTelemetryForTest();
    setTestExporter(null);
  }
});

test("the catalogue is strict, and a parameter is only ever a whole argument", () => {
  assert.deepEqual(parseCommandCatalogue(catalogue).commands.fixture, fixture);
  assert.throws(() => parseCommandCatalogue({
    version: 1,
    commands: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`command_${i}`, fixture]))
  }));
  for (const definition of [
    { ...fixture, executable: "../shell" },
    { ...fixture, args: ["a\0b"] },
    { ...fixture, cwd: "/tmp" },
    { ...fixture, env: { SECRET: "value" } },
    { ...fixture, timeoutMs: 0 },
    { ...fixture, concurrency: "unbounded" }
  ]) {
    assert.throws(() =>
      parseCommandCatalogue({ version: 1, commands: { fixture: definition } })
    );
  }
  assert.throws(() =>
    parseCommandCatalogue({ version: 1, commands: { "invalid name": fixture } })
  );
  // A placeholder that names no parameter, and a parameter nothing uses, are
  // both configuration errors rather than silently ignored.
  assert.throws(() =>
    parseCommandCatalogue({
      version: 1,
      commands: {
        broken: { ...fixture, args: ["--message", "{missing}"] }
      }
    })
  );
  assert.throws(() =>
    parseCommandCatalogue({
      version: 1,
      commands: {
        broken: {
          ...fixture,
          parameters: {
            unused: { description: "unused", minLength: 1, maxLength: 10 }
          }
        }
      }
    })
  );
  assert.throws(() =>
    parseCommandCatalogue({
      version: 1,
      commands: {
        broken: {
          ...fixture,
          parameters: {
            message: { description: "bad", minLength: 10, maxLength: 1 }
          },
          args: ["--message", "{message}"]
        }
      }
    })
  );
});

test("parameters are validated, substituted literally, and never interpolated", () => {
  const definition = {
    ...fixture,
    executable: "sh",
    args: ["-c", 'printf "%s" "$1"', "sh", "{message}"],
    parameters: {
      message: { description: "the message", minLength: 1, maxLength: 32 }
    }
  } satisfies CommandDefinition;
  // A value that would be catastrophic in a shell is one literal argument.
  const schema = commandInputSchema(definition);
  assert.equal(schema.safeParse({ message: "a\0b" }).success, false);
  assert.equal(schema.safeParse({ message: "ok", extra: "no" }).success, false);
  const argv = resolveCommandArguments(definition, {
    message: "; rm -rf / #$(whoami)`id`"
  });
  assert.equal(argv.length, 4);
  assert.equal(argv[3], "; rm -rf / #$(whoami)`id`");
  assert.throws(
    () => resolveCommandArguments(definition, { message: "" }),
    CommandCatalogueError
  );
  assert.throws(
    () => resolveCommandArguments(definition, { message: "x".repeat(33) }),
    CommandCatalogueError
  );
  assert.throws(
    () => resolveCommandArguments(definition, { message: "a\0b" }),
    CommandCatalogueError
  );
  assert.throws(
    () => resolveCommandArguments(definition, {}),
    CommandCatalogueError
  );
  // An undeclared parameter is rejected, not ignored.
  assert.throws(
    () => resolveCommandArguments(definition, { message: "ok", extra: "no" }),
    CommandCatalogueError
  );
});

test("a role's grant decides the effective command set, and a read-only role gets none", () => {
  const worker = effectiveCommands({
    role: "worker",
    workspaceId: null,
    catalogue: parseCommandCatalogue({
      version: 1,
      commands: {
        typecheck: {
          ...fixture,
          description: "typecheck",
          executable: "pnpm"
        }
      }
    })
  });
  assert.deepEqual(worker.keys().toArray(), ["typecheck"]);
  // A read-only role is refused outright, not merely given a smaller set.
  assert.throws(
    () =>
      createCommandsMcpServer({
        role: "explorer",
        workspaceId: null,
        catalogue: parseCommandCatalogue(catalogue),
        scope: scopeFixture("/tmp"),
        isAuthorized: () => true,
        tryAcquireWorkspace: () => null
      }),
    /not authorized/u
  );
  // A revoked grant is refused before anything is served.
  assert.throws(
    () =>
      createCommandsMcpServer({
        role: "orchestrator",
        workspaceId: null,
        catalogue: parseCommandCatalogue(catalogue),
        scope: scopeFixture("/tmp"),
        isAuthorized: () => false,
        tryAcquireWorkspace: () => null
      }),
    /revoked/u
  );
});

test("registered commands match discovery, and request cancellation and revocation stop execution", {
  skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-revoke-active-"));
  const scope = scopeFixture(root);
  let authorized = true;
  let held = false;
  const created = createCommandsMcpServer({
    role: "worker",
    workspaceId: null,
    catalogue: parseCommandCatalogue({
      version: 1,
      commands: {
        typecheck: {
          ...fixture,
          executable: "sh",
          args: ["-c", "printf ready > ready; sleep 10; printf late > late"],
          timeoutMs: 15_000
        },
        test: { ...fixture, executable: "unapproved" }
      }
    }),
    scope,
    isAuthorized: () => authorized,
    tryAcquireWorkspace: () => {
      if (held) return null;
      held = true;
      return () => { held = false; };
    }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "revocation-test", version: "1.0.0" });
  try {
    await created.server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual(created.commandIds, ["typecheck"]);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), created.commandIds);
    assert.equal(tools[0]?.annotations?.readOnlyHint, false);
    const ready = path.join(scope.workspace, "ready");
    const late = path.join(scope.workspace, "late");
    async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
      for (let i = 0; i < 200 && !predicate(); i += 1) {
        await delay(25);
      }
      assert.ok(predicate(), message);
    }

    const controller = new AbortController();
    const ordinary = client.callTool(
      { name: "typecheck", arguments: {} },
      undefined,
      { signal: controller.signal }
    );
    const cancelled = assert.rejects(ordinary);
    await waitUntil(() => existsSync(ready), "ordinary command actually started");
    controller.abort();
    await cancelled;
    await waitUntil(() => !held, "ordinary request cancellation stops execution");
    assert.equal(existsSync(late), false);
    rmSync(ready);

    await client.request(
      {
        method: "tools/call",
        params: { name: "typecheck", arguments: {}, task: { ttl: 30_000 } }
      },
      z.object({ task: z.object({ taskId: z.string() }).passthrough() }).passthrough()
    );
    await waitUntil(() => existsSync(ready), "native command actually started");
    assert.equal(held, true);
    authorized = false;
    await waitUntil(() => !held, "revocation cancels active execution before its normal completion");
    assert.equal(existsSync(late), false);
    authorized = true;
    const rejected = await client.callTool({ name: "typecheck", arguments: {} });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /revoked/u);
  } finally {
    await created.close();
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command may be restricted to the workspaces it names", () => {
  const definition = {
    ...fixture,
    workspaces: ["SimulatorLife/AutoDev"]
  } satisfies CommandDefinition;
  assert.equal(isCommandEligibleInWorkspace(definition, "SimulatorLife/AutoDev"), true);
  assert.equal(isCommandEligibleInWorkspace(definition, "SimulatorLife/Other"), false);
  assert.equal(isCommandEligibleInWorkspace(definition, null), false);
  assert.equal(isCommandEligibleInWorkspace(fixture, null), true);
});

test("the approved catalogue may not live inside the workspace it authorizes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-policy-"));
  try {
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { mode: 0o700 });
    // The Runtime's own configuration root, outside every workspace.
    const outside = path.join(root, "runtime-root");
    mkdirSync(path.join(outside, "config"), { recursive: true });
    const moduleDirectory = path.join(outside, "src", "mcp");
    mkdirSync(moduleDirectory, { recursive: true });
    const cataloguePath = path.join(outside, "config", "commands.json");
    writeFileSync(cataloguePath, JSON.stringify(catalogue));
    const resolved = approvedCataloguePath(moduleDirectory, workspace);
    const expected = path.join(realpathSync(path.join(outside, "config")), "commands.json");
    assert.equal(resolved, expected);
    const editable = path.join(workspace, "commands.json");
    writeFileSync(editable, JSON.stringify(catalogue));
    rmSync(cataloguePath);
    symlinkSync(editable, cataloguePath);
    assert.throws(
      () => approvedCataloguePath(moduleDirectory, workspace),
      /inside the authorized workspace/u
    );
    // A catalogue inside the workspace is refused: an agent that can edit it
    // would be editing its own authority.
    const insideRoot = path.join(root, "inside-root");
    mkdirSync(path.join(insideRoot, "config"), { recursive: true });
    const insideModule = path.join(insideRoot, "src", "mcp");
    mkdirSync(insideModule, { recursive: true });
    writeFileSync(
      path.join(insideRoot, "config", "commands.json"),
      JSON.stringify(catalogue)
    );
    assert.throws(
      () => approvedCataloguePath(insideModule, insideRoot),
      /inside the authorized workspace/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native task store isolates explicit and absent transport sessions", async () => {
  const store = new CommandTaskStore(() => {}, new Map());
  const request = { method: "tools/call", params: { name: "test", arguments: {} } };
  try {
    const stdio = await store.createTask({ ttl: 10_000 }, 1, request);
    const explicit = await store.createTask({ ttl: 10_000 }, 2, request, "stdio");
    assert.equal((await store.getTask(stdio.taskId))?.taskId, stdio.taskId);
    assert.equal(await store.getTask(stdio.taskId, "stdio"), null);
    assert.equal(await store.getTask(explicit.taskId), null);
    assert.equal(await store.getTask(explicit.taskId, "other"), null);
    assert.deepEqual((await store.listTasks()).tasks.map((task) => task.taskId), [stdio.taskId]);
    assert.deepEqual((await store.listTasks(undefined, "stdio")).tasks.map((task) => task.taskId), [explicit.taskId]);
    const result = { content: [{ type: "text", text: "fixture" }] };
    await assert.rejects(store.storeTaskResult(explicit.taskId, "completed", result), /not found/u);
    await assert.rejects(store.updateTaskStatus(explicit.taskId, "cancelled"), /not found/u);
    assert.equal((await store.getTask(explicit.taskId, "stdio"))?.status, "working");
    await store.storeTaskResult(explicit.taskId, "completed", result, "stdio");
    await assert.rejects(store.getTaskResult(explicit.taskId), /not found/u);
    assert.deepEqual(await store.getTaskResult(explicit.taskId, "stdio"), result);
  } finally {
    store.cleanup();
  }
});

test("replacing the approved catalogue revokes the grant", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-revoke-"));
  try {
    const cataloguePath = path.join(root, "commands.json");
    writeFileSync(cataloguePath, JSON.stringify(catalogue));
    const grant = createApprovedCatalogueGrant(cataloguePath);
    assert.equal(grant.isAuthorized(), true);
    assert.equal(grant.digest, catalogueDigest(readFileSync(cataloguePath, "utf8")));
    writeFileSync(
      cataloguePath,
      JSON.stringify({
        version: 1,
        commands: {
          fixture: { ...fixture, executable: "sh" }
        }
      })
    );
    assert.equal(grant.isAuthorized(), false);
    // A revoked revision cannot regain authority even if restored.
    writeFileSync(cataloguePath, JSON.stringify(catalogue));
    assert.equal(grant.isAuthorized(), false);
    rmSync(cataloguePath);
    assert.equal(grant.isAuthorized(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved catalogue reads reject symlinks, shared hard links and writable modes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-file-"));
  try {
    const original = path.join(root, "original.json");
    const approved = path.join(root, "commands.json");
    writeFileSync(original, JSON.stringify(catalogue), { mode: 0o600 });
    symlinkSync(original, approved);
    assert.throws(() => createApprovedCatalogueGrant(approved));
    rmSync(approved);
    linkSync(original, approved);
    assert.throws(() => createApprovedCatalogueGrant(approved), /protected regular file/u);
    rmSync(original);
    const grant = createApprovedCatalogueGrant(approved);
    chmodSync(approved, 0o666);
    assert.equal(grant.isAuthorized(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved catalogue reads are bounded and private state directories cannot redirect", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-state-"));
  try {
    const approved = path.join(root, "commands.json");
    writeFileSync(approved, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => createApprovedCatalogueGrant(approved), /size limit/u);

    const workspaceKey = commandWorkspaceKey(root);
    const run = path.join(root, "run");
    const scratch = commandScratchRoot(run, workspaceKey);
    assert.equal(scratch, path.join(realpathSync(run), "command-scratch", workspaceKey));
    assert.throws(() => commandCacheRoot(run, ".."), /workspace key/u);
    const outside = path.join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, path.join(run, "command-cache"));
    assert.throws(() => commandCacheRoot(run, workspaceKey), /must not redirect/u);
    rmSync(scratch, { recursive: true });
    symlinkSync(outside, scratch);
    assert.throws(() => commandScratchRoot(run, workspaceKey), /must not redirect/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace lease is exclusive across sessions and released on completion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, "workspace-key");
    const release = lease.tryAcquire();
    assert.ok(release);
    assert.equal(lease.tryAcquire(), null);
    release!();
    const second = lease.tryAcquire();
    assert.ok(second);
    second();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old lease is not proof that its command stopped", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, "workspace-key");
    const release = lease.tryAcquire();
    assert.ok(release);
    const lock = path.join(root, "command-workspace-key.lock");
    const old = new Date(0);
    utimesSync(lock, old, old);
    assert.equal(lease.tryAcquire(), null);
    // Even an operator-replaced lock is not ours to release.
    rmSync(lock);
    writeFileSync(lock, "replacement");
    release();
    assert.equal(readFileSync(lock, "utf8"), "replacement");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command profile denies the network, the host and the credentials", () => {
  const profile = commandSandboxProfile("/workspace", "/scratch", "/cache", [
    "/toolchain"
  ]);
  assert.match(profile, /\(deny default\)/u);
  assert.match(profile, /\(subpath "\/workspace"\)/u);
  assert.match(profile, /\(subpath "\/scratch"\)/u);
  assert.match(profile, /\(subpath "\/cache"\)/u);
  assert.doesNotMatch(profile, /\(allow (?:network|mach-lookup|ipc)/u);
  assert.doesNotMatch(profile, /\(allow file-read\*\)/u);
  assert.match(profile, /\\\.env/u);
  assert.match(profile, /\\\.ssh/u);
  assert.match(profile, /\\\.codex/u);
  assert.match(profile, /\\\.autodev/u);
  // The only writable roots are the workspace and the Runtime's own roots.
  const writeRule = profile
    .split("\n")
    .find((line) => line.startsWith("(allow file-write*"))!;
  assert.match(writeRule, /\(subpath "\/workspace"\)/u);
  assert.match(writeRule, /\(subpath "\/scratch"\)/u);
  assert.match(writeRule, /\(subpath "\/cache"\)/u);
});

test("only a dependency install may reach the network, and only the registry proxy", () => {
  const profile = commandSandboxProfile(
    "/workspace",
    "/scratch",
    "/cache",
    ["/toolchain"],
    { registryPort: 4321 }
  );
  // Seatbelt accepts only `*` or `localhost` as a remote host ("host must be
  // * or localhost in network address"), so loopback is spelled `localhost`.
  assert.match(profile, /\(allow network-outbound \(remote ip "localhost:4321"\)\)/u);
  assert.doesNotMatch(profile, /\(allow network-outbound \(remote ip "\*"/u);
  assert.doesNotMatch(profile, /\(allow network\*/u);
});

test("a command's environment carries no operator credentials and no host paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-env-"));
  try {
    const scope = scopeFixture(root);
    const prepared = prepareCommand(scope, fixture);
    assert.equal(prepared.cwd, realpathSync(scope.workspace));
    const scratch = realpathSync(scope.scratch);
    const cache = realpathSync(scope.cache);
    assert.equal(prepared.env.HOME, scratch);
    assert.equal(prepared.env.TMPDIR, scratch);
    assert.equal(prepared.env.XDG_CACHE_HOME, path.join(cache, "xdg"));
    assert.equal(prepared.env.CI, "1");
    // No operator secret, tunnel token or provider credential is inherited.
    for (const forbidden of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CODEX_ROUTER_OPENCLI_API_KEY",
      "SSH_AUTH_SOCK",
      "AWS_ACCESS_KEY_ID",
      "NPM_TOKEN"
    ]) {
      assert.equal(prepared.env[forbidden], undefined);
    }
    assert.equal(prepared.env.npm_config_update_notifier, "false");
    assert.equal(prepared.env.npm_config_audit, "false");
    // The workspace root is not on the PATH of the confined process; only
    // the project's own tool directory is, so a project script can resolve
    // the tools it declares.
    const pathEntries = new Set(prepared.env.PATH!.split(path.delimiter));
    const physicalWorkspace = realpathSync(scope.workspace);
    assert.ok(!pathEntries.has(physicalWorkspace));
    assert.ok(
      pathEntries.has(path.join(physicalWorkspace, "node_modules", ".bin"))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scope that overlaps a protected root, or an unapproved executable, is refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-scope-"));
  try {
    const scope = scopeFixture(root);
    assert.throws(
      () => prepareCommand(scope, { ...fixture, executable: "unknown" }),
      /not been approved/u
    );
    // The scratch may not be the workspace, and the workspace may not be the
    // filesystem root.
    assert.throws(
      () => prepareCommand({ ...scope, scratch: scope.workspace }, fixture),
      /overlaps/u
    );
    assert.throws(
      () => prepareCommand({ ...scope, workspace: "/" }, fixture),
      /overlaps|not a directory/u
    );
    // Dependency installation needs an approved egress, and without one it
    // is refused rather than silently allowed.
    assert.throws(
      () => prepareCommand(scope, { ...fixture, executionClass: "dependency_install" }),
      /egress|package-registry/u
    );
    const withRegistry = {
      ...scope,
      registryEndpoint: "http://127.0.0.1:5555"
    };
    const prepared = prepareCommand(withRegistry, {
      ...fixture,
      executionClass: "dependency_install"
    });
    assert.equal(prepared.env.npm_config_registry, "http://127.0.0.1:5555");
    for (const registryEndpoint of [
      "http://example.invalid:5555",
      "https://127.0.0.1:5555",
      "http://user@127.0.0.1:5555",
      "http://127.0.0.1:5555/path",
      "http://127.0.0.1:5555/?token=fixture"
    ]) {
      assert.throws(() => prepareCommand(
        { ...scope, registryEndpoint },
        { ...fixture, executionClass: "dependency_install" }
      ), /loopback registry endpoint/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted executables never resolve out of the workspace", () => {
  const resolved = resolveTrustedExecutables(["git"]);
  assert.ok(path.isAbsolute(resolved.executables.git!));
  assert.ok(resolved.toolchainRoots.length > 0);
  const filesystemRoot = path.parse(path.resolve("/")).root;
  assert.ok(!resolved.toolchainRoots.includes(filesystemRoot));
  assert.throws(() => resolveTrustedExecutables(["definitely-not-installed-xyz"]));
});

test("workspace keys are physical, stable and shared across symlink aliases", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-key-"));
  try {
    const one = path.join(root, "one");
    const two = path.join(root, "two");
    const alias = path.join(root, "alias");
    mkdirSync(one);
    mkdirSync(two);
    symlinkSync(one, alias);
    assert.equal(commandWorkspaceKey(one), commandWorkspaceKey(alias));
    assert.notEqual(commandWorkspaceKey(one), commandWorkspaceKey(two));
    assert.throws(() => commandWorkspaceKey(path.join(root, "missing")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the admitted command workspace cannot be redirected after scope resolution", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-workspace-identity-"));
  try {
    const workspace = path.join(root, "workspace");
    const other = path.join(root, "other");
    const runtimeRoot = path.join(root, "runtime");
    const moduleDirectory = path.join(runtimeRoot, "src", "mcp");
    mkdirSync(workspace);
    mkdirSync(other);
    mkdirSync(moduleDirectory, { recursive: true });
    mkdirSync(path.join(runtimeRoot, "config"));
    writeFileSync(path.join(runtimeRoot, "config", "commands.json"), JSON.stringify({
      version: 1,
      commands: { git_status: { ...fixture, executable: "git", args: ["status"] } }
    }));
    const alias = path.join(root, "alias");
    symlinkSync(workspace, alias);
    const resolved = resolveCommandsScope({
      moduleDirectory,
      env: { HOME: root, AUTODEV_HOME: runtimeRoot },
      args: ["--role", "worker", "--workspace", alias]
    });
    assert.equal(resolved.workspace, realpathSync(workspace));
    assert.equal(resolved.isAuthorized(), true);
    // Replacing the caller's alias does not change the pinned workspace.
    rmSync(alias);
    symlinkSync(other, alias);
    assert.equal(resolved.isAuthorized(), true);
    // Replacing the physical root itself revokes admission.
    rmSync(workspace, { recursive: true });
    symlinkSync(other, workspace);
    assert.equal(resolved.isAuthorized(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the registry proxy serves package metadata and tarballs, and nothing else", () => {
  assert.equal(classifyRegistryPath("/pnpm"), "metadata");
  assert.equal(classifyRegistryPath("/@scope%2fname"), "metadata");
  assert.equal(classifyRegistryPath("/@scope%2Fname"), "metadata");
  assert.equal(classifyRegistryPath("/@scope/name"), "metadata");
  assert.equal(classifyRegistryPath("/@scope/name/-/name-1.0.0.tgz"), "tarball");
  for (const path of [
    "https://evil.example/pnpm",
    "/pnpm/../secret",
    "/pnpm/%2e%2e",
    "/pnpm?secret=value",
    "/pnpm/#fragment",
    "/@scope%2f..",
    "/@scope%2fname%2fother",
    "/pnpm/-/foo%2fbar.tgz"
  ]) {
    assert.equal(classifyRegistryPath(path), null, path);
  }
  assert.equal(classifyRegistryPath("/pnpm/-/pnpm-1.0.0.tgz"), "tarball");
  assert.equal(classifyRegistryPath("/-/ping"), null);
  assert.equal(classifyRegistryPath("/-/npm/v1/security/audits"), null);
  assert.equal(classifyRegistryPath("//evil.example/"), null);
  const rewritten = rewriteRegistryUrls(
    '{"dist":{"tarball":"https://registry.npmjs.org/pnpm/-/pnpm-1.0.0.tgz"}}',
    "https://registry.npmjs.org",
    "http://127.0.0.1:9999"
  );
  assert.match(rewritten, /http:\/\/127\.0\.0\.1:9999\/pnpm\/-\/pnpm-1\.0\.0\.tgz/u);
  assert.doesNotMatch(rewritten, /registry\.npmjs\.org/u);
  const registry = "https://registry.npmjs.org";
  const endpoint = "http://127.0.0.1:9999";
  const metadata = {
    description: registry,
    versions: {
      "1.0.0": { dist: { tarball: registry + "/pnpm/-/pnpm-1.0.0.tgz" } },
      "2.0.0": { dist: { tarball: registry + ".example.invalid/pnpm/-/pnpm-2.0.0.tgz" } },
      "3.0.0": { dist: { tarball: registry + "/pnpm/-/pnpm-3.0.0.tgz?token=fixture" } }
    }
  };
  assert.deepEqual(JSON.parse(rewriteRegistryUrls(JSON.stringify(metadata), registry, endpoint)), {
    ...metadata,
    versions: {
      ...metadata.versions,
      "1.0.0": { dist: { tarball: endpoint + "/pnpm/-/pnpm-1.0.0.tgz" } }
    }
  });
});

test("registry proxy relays scoped packages and refuses unapproved request forms", async () => {
  const requests: string[] = [];
  const accepts: (string | undefined)[] = [];
  let origin = "";
  const upstream = createServer((request, response) => {
    requests.push(request.url ?? "");
    accepts.push(request.headers.accept);
    if (request.url === "/invalid") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not json");
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://example.invalid/" });
      response.end();
      return;
    }
    if (request.url?.endsWith(".tgz")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([1, 2, 3]));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ dist: { tarball: origin + "/@scope/name/-/name-1.tgz" } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  try {
    const proxy = await startRegistryProxy({ registry: origin });
    try {
      const metadata = await fetch(proxy.endpoint + "/@scope%2fname", {
        headers: { accept: "private-caller-header" }
      });
      assert.equal(metadata.status, 200);
      const body = await metadata.json() as { dist: { tarball: string } };
      assert.equal(body.dist.tarball, proxy.endpoint + "/@scope/name/-/name-1.tgz");
      const tarball = await fetch(body.dist.tarball);
      assert.equal(tarball.status, 200);
      assert.deepEqual(new Uint8Array(await tarball.arrayBuffer()), new Uint8Array([1, 2, 3]));
      const redirect = await fetch(proxy.endpoint + "/redirect");
      assert.equal(redirect.status, 502);
      const forbidden = await fetch(proxy.endpoint + "/pnpm?secret=fixture");
      assert.equal(forbidden.status, 404);
      const invalid = await fetch(proxy.endpoint + "/invalid");
      assert.equal(invalid.status, 502);
      assert.deepEqual(requests, ["/@scope%2fname", "/@scope/name/-/name-1.tgz", "/redirect", "/invalid"]);
      assert.equal(accepts[0], "application/vnd.npm.install-v1+json, application/json");
      assert.equal(accepts[1], "application/octet-stream");
      assert.ok(!accepts.includes("private-caller-header"));
    } finally {
      await proxy.close();
    }
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test(
  "a confined command keeps literal arguments, cannot write outside the workspace and cannot read secrets",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-fixture-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const result = await runApprovedCommand(
      "fixture",
      fixture,
      fixture.args,
      scope,
      AbortSignal.timeout(10_000)
    );
    assert.equal(result.status, "succeeded", result.stderr);
    assert.equal(result.stdout, "literal; $HOME");
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputTruncated, false);

    // A write outside the workspace is denied.
    const protectedPath = path.join(root, "protected.txt");
    writeFileSync(protectedPath, "original");
    const mutation = {
      ...fixture,
      executable: "sh",
      args: ["-c", 'printf changed > "$1"', "sh", protectedPath],
      executionClass: "workspace_mutation"
    } satisfies CommandDefinition;
    const denied = await runApprovedCommand(
      "denied",
      mutation,
      mutation.args,
      scope,
      AbortSignal.timeout(10_000)
    );
    assert.notEqual(denied.status, "succeeded");
    assert.equal(readFileSync(protectedPath, "utf8"), "original");

    // A workspace secret file is not readable through the command either.
    const secretPath = path.join(scope.workspace, ".env");
    writeFileSync(secretPath, "fixture-secret");
    const secret = await runApprovedCommand(
      "secret",
      { ...mutation, args: ["-c", 'cat "$1"', "sh", secretPath] },
      ["-c", 'cat "$1"', "sh", secretPath],
      scope,
      AbortSignal.timeout(10_000)
    );
    assert.notEqual(secret.status, "succeeded");
    assert.doesNotMatch(secret.stdout, /fixture-secret/u);
  }
);

test("confined commands can use private Runtime roots without reading sibling Runtime state", {
  skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-runtime-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = scopeFixture(root);
  const state = path.join(root, ".autodev");
  const run = path.join(state, "run");
  const key = commandWorkspaceKey(scope.workspace);
  const scratch = commandScratchRoot(run, key);
  const cache = commandCacheRoot(run, key);
  const sibling = path.join(run, "private-token");
  writeFileSync(sibling, "outside-private-state");
  const approvedScope = { ...scope, scratch, cache };
  const command = {
    ...fixture,
    executable: "sh",
    args: ["-c", 'printf ok > "$HOME/probe"; printf ok > "$1/probe"; cat "$HOME/probe" "$1/probe"', "sh", cache]
  } satisfies CommandDefinition;
  const allowed = await runApprovedCommand("fixture", command, command.args, approvedScope, AbortSignal.timeout(10_000));
  assert.equal(allowed.status, "succeeded", allowed.stderr);
  assert.equal(allowed.stdout, "okok");
  const denied = await runApprovedCommand("fixture", command, ["-c", 'cat "$1"', "sh", sibling], approvedScope, AbortSignal.timeout(10_000));
  assert.notEqual(denied.status, "succeeded");
  assert.doesNotMatch(denied.stdout, /outside-private-state/u);
});

test(
  "a symlink in the workspace cannot be used to reach outside it",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-symlink-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "outside-secret");
    const link = path.join(scope.workspace, "link.txt");
    symlinkSync(outside, link);
    const definition = {
      ...fixture,
      executable: "sh",
      args: ["-c", 'cat "$1"', "sh", link],
      executionClass: "validation"
    } satisfies CommandDefinition;
    const result = await runApprovedCommand(
      "symlink",
      definition,
      definition.args,
      scope,
      AbortSignal.timeout(10_000)
    );
    // Reading through the symlink resolves outside the workspace, so the
    // profile's read grant does not cover it.
    assert.doesNotMatch(result.stdout, /outside-secret/u);
  }
);

test(
  "a command that outlives its deadline is stopped and reported as timed out",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-timeout-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const definition = {
      ...fixture,
      executable: "sh",
      args: ["-c", "sleep 30"],
      timeoutMs: 1500
    } satisfies CommandDefinition;
    const result = await runApprovedCommand(
      "slow",
      definition,
      definition.args,
      scope,
      AbortSignal.timeout(20_000)
    );
    assert.equal(result.status, "timed_out");
  }
);

test(
  "a cancelled command is stopped and reported as cancelled",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-cancel-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const definition = {
      ...fixture,
      executable: "sh",
      args: ["-c", "sleep 30"],
      timeoutMs: 30_000
    } satisfies CommandDefinition;
    const controller = new AbortController();
    const pending = runApprovedCommand(
      "cancelled",
      definition,
      definition.args,
      scope,
      controller.signal
    );
    setTimeout(() => controller.abort(), 500);
    const result = await pending;
    assert.equal(result.status, "cancelled");
  }
);

test(
  "output beyond the bound is reported as truncated rather than buffered without limit",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-output-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const definition = {
      ...fixture,
      executable: "sh",
      args: ["-c", "yes abcdefghijklmnopqrstuvwxyz"],
      timeoutMs: 20_000
    } satisfies CommandDefinition;
    const result = await runApprovedCommand(
      "noisy",
      definition,
      definition.args,
      scope,
      AbortSignal.timeout(20_000)
    );
    assert.equal(result.outputTruncated, true);
    assert.equal(result.status, "output_limit");
    assert.ok(result.stdout.length <= 256 * 1024);
  }
);

test("the installed catalogue is a valid, generic catalogue", () => {
  const cataloguePath = path.join(
    import.meta.dirname,
    "..",
    "..",
    "config",
    "commands.json"
  );
  const parsed = parseCommandCatalogue(
    JSON.parse(readFileSync(cataloguePath, "utf8"))
  );
  const ids = Object.keys(parsed.commands);
  for (const required of [
    "install_dependencies",
    "typecheck",
    "test",
    "lint_fix",
    "git_status",
    "git_diff",
    "git_stage",
    "git_commit"
  ]) {
    assert.ok(ids.includes(required), `missing ${required}`);
  }
  // The Git capabilities are exactly the ones the migration names: no push,
  // no reset, no configuration change.
  const gitArguments = new Set(Object.entries(parsed.commands)
    .filter(([, definition]) => definition.executable === "git")
    .flatMap(([, definition]) => definition.args));
  for (const forbidden of ["push", "reset", "config", "rebase", "clean"]) {
    assert.ok(!gitArguments.has(forbidden), `git ${forbidden} is not granted`);
  }
  // The commit message is a validated parameter, not free-form argv.
  assert.deepEqual(parsed.commands.git_commit!.parameters.message, {
    description: "The commit message for the staged changes.",
    minLength: 1,
    maxLength: 500
  });
  assert.deepEqual(parsed.commands.git_commit!.args, ["commit", "-m", "{message}"]);
});

test("the host's sandbox tooling really confines, so the negative tests mean something", () => {
  // A profile that denies everything must actually stop the process; if it
  // did not, every negative confinement test above would be vacuous.
  const denied = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(deny default)", "/usr/bin/true"],
    { stdio: "ignore" }
  );
  assert.notEqual(denied.status, 0);
  const allowed = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(allow default)", "/usr/bin/true"],
    { stdio: "ignore" }
  );
  assert.equal(allowed.status, 0);
});

test("the command scratch and cache are private", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-private-"));
  try {
    const scope = scopeFixture(root);
    for (const directory of [scope.scratch, scope.cache]) {
      const mode = spawnSync("/usr/bin/stat", ["-f", "%Lp", directory], {
        encoding: "utf8"
      }).stdout.trim();
      assert.equal(mode, "700");
    }
    chmodSync(scope.scratch, 0o755);
    assert.throws(() => prepareCommand(scope, fixture), /private/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
