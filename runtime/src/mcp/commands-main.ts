/**
The Commands MCP server's stdio entry point.

The server runs as one process per admitted role/workspace scope. It reads
the *approved* catalogue -- the operator's copy, materialized outside every
workspace -- and never the workspace's own declaration, because an agent
that can edit the declaration could otherwise widen its own grants. When
the approved catalogue cannot be established, the server refuses to start.
*/
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { autodevRunDirectory } from "@simulatorlife/autodev-runtime/shared/autodev-home";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import {
  type CommandCatalogue,
  parseCommandCatalogue
} from "./commands-catalogue.ts";
import {
  type ApprovedCommandScope,
  commandWorkspaceKey,
  resolveTrustedExecutables
} from "./commands-execution.ts";
import { startRegistryProxy } from "./commands-registry-proxy.ts";
import { createCommandsMcpServer, effectiveCommands } from "./commands-server.ts";
import {
  configureCommandExecutionTelemetry,
  shutdownTelemetry
} from "./mcp-telemetry.ts";

/**
The environment variable that names the role this server serves.
*/
export const COMMANDS_ROLE_ENV = "AUTODEV_MCP_ROLE";
/**
The environment variable that names the canonical workspace id.
*/
export const COMMANDS_WORKSPACE_ID_ENV = "AUTODEV_MCP_WORKSPACE_ID";
/**
The environment variable that names the workspace root.
*/
export const COMMANDS_WORKSPACE_ENV = "AUTODEV_MCP_WORKSPACE";
/**
The registry dependency installation is pointed at.
*/
export const COMMANDS_REGISTRY_ENV = "AUTODEV_COMMAND_REGISTRY";

/**
The approved catalogue's file name inside the Runtime's config directory.
*/
export const APPROVED_CATALOGUE_FILE = "commands.json";

export class CommandsAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandsAdmissionError";
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
  );
}

/**
The path the approved catalogue is read from.

It lives with the Runtime's own configuration -- the installed tree's
config directory -- and never inside a workspace. The check is explicit
rather than implied: when AutoDev itself is the workspace, the checkout's
copy of the catalogue is editable by the very agent it authorizes, and the
only safe answer is to refuse.
*/
export function approvedCataloguePath(
  moduleDirectory: string,
  workspace: string
): string {
  const root = resolveRuntimeSourceRoot(moduleDirectory);
  const configDirectory = path.join(root, "config");
  // Both paths are compared in their physical form: a symlinked spelling of
  // the same directory is the same directory, and a spelling that hides it
  // must not be able to slip past the check.
  let catalogueDirectory: string;
  try {
    catalogueDirectory = realpathSync(configDirectory);
  } catch {
    catalogueDirectory = path.resolve(configDirectory);
  }
  const catalogue = path.join(catalogueDirectory, APPROVED_CATALOGUE_FILE);
  // Resolve the file too, not just its parent. A link to an editable
  // catalogue must never be treated as an approved installed revision.
  let resolvedCatalogue: string;
  try {
    resolvedCatalogue = realpathSync(catalogue);
  } catch {
    throw new CommandsAdmissionError("The approved command catalogue is unavailable.");
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(workspace);
  } catch {
    workspaceRoot = path.resolve(workspace);
  }
  if (
    isWithin(catalogue, workspaceRoot) ||
    isWithin(resolvedCatalogue, workspaceRoot)
  ) {
    throw new CommandsAdmissionError(
      "The approved command catalogue resolves inside the authorized workspace; an agent that can edit it would be editing its own authority. Install the Runtime and run the command surface from the installed configuration."
    );
  }
  if (resolvedCatalogue !== catalogue) {
    throw new CommandsAdmissionError("The approved command catalogue must not be a symbolic link.");
  }
  return catalogue;
}

/**
Read one protected revision through a descriptor, refusing symbolic links,
shared hard links and files writable by another user. The installed parent
directory must also be protected by the Runtime admission boundary.
*/
const MAX_CATALOGUE_BYTES = 1024 * 1024;

function readApprovedCatalogue(cataloguePath: string): string {
  const descriptor = openSync(
    cataloguePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new CommandsAdmissionError("The approved command catalogue is not a protected regular file.");
    }
    if (stat.size > MAX_CATALOGUE_BYTES) {
      throw new CommandsAdmissionError("The approved command catalogue exceeds its size limit.");
    }
    // Bound reads even if the file grows between fstat and read.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_CATALOGUE_BYTES + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes !== stat.size) {
      throw new CommandsAdmissionError("The approved command catalogue changed during read.");
    }
    return buffer.toString("utf8", 0, bytes);
  } finally {
    closeSync(descriptor);
  }
}

/**
The digest of the approved catalogue, which is what revocation is judged on.
*/
export function catalogueDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
A revocation check bound to one approved catalogue revision.

The approved catalogue is re-read on every check. Replacement or removal
revokes this grant permanently once observed. The command server checks
active executions periodically as well as at lifecycle requests.
*/
export function createApprovedCatalogueGrant(cataloguePath: string): {
  readonly digest: string;
  readonly catalogue: CommandCatalogue;
  isAuthorized(): boolean;
} {
  const content = readApprovedCatalogue(cataloguePath);
  const digest = catalogueDigest(content);
  const catalogue = parseCommandCatalogue(JSON.parse(content));
  let revoked = false;
  return {
    digest,
    catalogue,
    isAuthorized(): boolean {
      if (!revoked) {
        try {
          revoked =
            catalogueDigest(readApprovedCatalogue(cataloguePath)) !== digest;
        } catch {
          revoked = true;
        }
      }
      return !revoked;
    }
  };
}

/**
A workspace-wide exclusive lease.

Two sessions in one workspace must not run commands against it at the same
time: an install and a test would race over the same build outputs. The
lease is a file in the Runtime's own run directory, so it is shared by
every session's server process and never by the workspace itself.
*/
export function createWorkspaceLease(
  runDirectory: string,
  workspaceKey: string
): {
  tryAcquire(): (() => void) | null;
} {
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(
    runDirectory,
    `command-${workspaceKey.replaceAll(/[^A-Za-z0-9._-]/gu, "_")}.lock`
  );
  return {
    tryAcquire(): (() => void) | null {
      // A timestamp cannot prove that a command or detached descendant
      // has stopped. An abandoned lease stays closed until the Runtime
      // can prove recovery (or the operator verifies it and removes it).
      let descriptor: number;
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
      } catch {
        return null;
      }
      let identity;
      try {
        identity = fstatSync(descriptor);
        writeSync(descriptor, `${process.pid}\n`);
      } catch {
        closeSync(descriptor);
        // Preserve the lease on an uncertain acquisition failure.
        return null;
      }
      let isReleased = false;
      return () => {
        if (isReleased) return;
        isReleased = true;
        try {
          const current = lstatSync(lockPath);
          if (current.dev === identity.dev && current.ino === identity.ino) {
            unlinkSync(lockPath);
          }
        } catch {
          // The lock is already gone or cannot safely be inspected.
        } finally {
          // Retain the descriptor until release to prevent inode reuse
          // from making a replacement lock look like our original.
          closeSync(descriptor);
        }
      };
    }
  };
}

/**
The private scratch root one scope's commands run in.
*/
export function commandScratchRoot(
  runDirectory: string,
  workspaceKey: string
): string {
  return privateCommandRoot(runDirectory, "command-scratch", workspaceKey);
}

/**
The private, per-workspace cache root one scope's commands may write.
*/
export function commandCacheRoot(
  runDirectory: string,
  workspaceKey: string
): string {
  return privateCommandRoot(runDirectory, "command-cache", workspaceKey);
}

function privateCommandRoot(
  runDirectory: string,
  kind: "command-scratch" | "command-cache",
  workspaceKey: string
): string {
  if (!/^[a-f0-9]{16}$/u.test(workspaceKey)) {
    throw new CommandsAdmissionError("Invalid command workspace key.");
  }
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const physicalRun = realpathSync(runDirectory);
  const parent = path.join(physicalRun, kind);
  const root = path.join(parent, workspaceKey);
  for (const directory of [parent, root]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      realpathSync(directory) !== directory
    ) {
      throw new CommandsAdmissionError("Command state directory must be private and must not redirect.");
    }
  }
  return root;
}

export interface CommandsServerOptions {
  readonly moduleDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /**
  The trusted launcher's arguments. The Runtime that starts the server
  knows the role and the workspace, and passes them here; the agent never
  sees or supplies them.
  */
  readonly args?: readonly string[];
}

/**
One value of a trusted command-line option.

Only the options the Runtime itself passes are read; an unknown option is
ignored rather than treated as a request.
*/
export function commandsArgumentValue(
  arguments_: readonly string[] | undefined,
  name: string
): string | null {
  const index = arguments_ ? arguments_.indexOf(name) : -1;
  if (index === -1) return null;
  return arguments_![index + 1] ?? null;
}

export interface ResolvedCommandsScope {
  readonly role: string;
  readonly workspace: string;
  readonly workspaceId: string | null;
  readonly scope: ApprovedCommandScope;
  readonly catalogue: CommandCatalogue;
  readonly digest: string;
  readonly isAuthorized: () => boolean;
  readonly workspaceKey: string;
}

/**
Resolve everything the server needs from trusted context alone.

Every value here comes from the Runtime's own configuration, the Runtime's
own environment and the operator's approved catalogue. Nothing is taken
from the workspace, and nothing is taken from the MCP request.
*/
export function resolveCommandsScope(
  options: CommandsServerOptions
): ResolvedCommandsScope {
  const environment = options.env ?? process.env;
  const home = options.home ?? (environment.HOME?.trim() || homedir());
  const role = (
    commandsArgumentValue(options.args, "--role") ?? environment[COMMANDS_ROLE_ENV] ?? ""
  )
    .trim()
    .toLowerCase();
  if (!role) {
    throw new CommandsAdmissionError(
      `The Commands MCP requires ${COMMANDS_ROLE_ENV}; it serves one admitted role scope.`
    );
  }
  const requestedWorkspace = (
    commandsArgumentValue(options.args, "--workspace") ??
    environment[COMMANDS_WORKSPACE_ENV] ??
    ""
  ).trim();
  if (!requestedWorkspace || !path.isAbsolute(requestedWorkspace)) {
    throw new CommandsAdmissionError(
      `The Commands MCP requires an absolute ${COMMANDS_WORKSPACE_ENV}.`
    );
  }
  const workspace = realpathSync(requestedWorkspace);
  const workspaceIdentity = statSync(workspace);
  if (!workspaceIdentity.isDirectory()) {
    throw new CommandsAdmissionError("The Commands MCP workspace is not a directory.");
  }
  const workspaceId =
    commandsArgumentValue(options.args, "--workspace-id")?.trim() ??
    environment[COMMANDS_WORKSPACE_ID_ENV]?.trim() ??
    null;
  const cataloguePath = approvedCataloguePath(options.moduleDirectory, workspace);
  const approved = createApprovedCatalogueGrant(cataloguePath);
  const runDirectory = autodevRunDirectory(environment, home);
  const workspaceKey = commandWorkspaceKey(workspace);
  const effective = effectiveCommands({
    role,
    workspaceId,
    catalogue: approved.catalogue
  });
  const executables = resolveTrustedExecutables(
    [...new Set(effective.values().map((entry) => entry.executable))],
    environment,
    home
  );
  const scope: ApprovedCommandScope = {
    workspace,
    scratch: commandScratchRoot(runDirectory, workspaceKey),
    cache: commandCacheRoot(runDirectory, workspaceKey),
    toolchainRoots: executables.toolchainRoots,
    executables: executables.executables
  };
  return {
    role,
    workspace,
    workspaceId,
    scope,
    catalogue: approved.catalogue,
    digest: approved.digest,
    isAuthorized() {
      if (!approved.isAuthorized()) return false;
      try {
        const current = statSync(workspace);
        return (
          realpathSync(workspace) === workspace &&
          current.dev === workspaceIdentity.dev &&
          current.ino === workspaceIdentity.ino
        );
      } catch {
        return false;
      }
    },
    workspaceKey
  };
}

/**
Start the server for one admitted scope.

The registry proxy is only started when the effective grant actually
contains a dependency install, so a scope that may not install packages
never opens a network path at all.
*/
export async function startCommandsServer(
  resolved: ResolvedCommandsScope,
  runDirectory: string
): Promise<{
  readonly server: Awaited<ReturnType<typeof createCommandsMcpServer>>;
  close(): Promise<void>;
}> {
  const lease = createWorkspaceLease(runDirectory, resolved.workspaceKey);
  const effective = effectiveCommands(resolved);
  const isNeedsRegistry = effective
    .values()
    .some((definition) => definition.executionClass === "dependency_install");
  const registry = isNeedsRegistry
    ? await startRegistryProxy({
        registry:
          process.env[COMMANDS_REGISTRY_ENV]?.trim() || "https://registry.npmjs.org"
      })
    : null;
  const scope: ApprovedCommandScope = registry
    ? { ...resolved.scope, registryEndpoint: registry.endpoint }
    : resolved.scope;
  let created: ReturnType<typeof createCommandsMcpServer> | undefined;
  try {
    created = createCommandsMcpServer({
      role: resolved.role,
      workspaceId: resolved.workspaceId,
      catalogue: resolved.catalogue,
      scope,
      isAuthorized: resolved.isAuthorized,
      tryAcquireWorkspace: lease.tryAcquire
    });
    await created.server.connect(new StdioServerTransport());
  } catch (error) {
    try {
      await created?.close();
    } finally {
      await registry?.close();
    }
    throw error;
  }
  const server = created;
  let closing: Promise<void> | undefined;
  return {
    server,
    close() {
      closing ??= Promise.resolve().then(async () => {
        try {
          await server.close();
        } finally {
          await registry?.close();
        }
      });
      return closing;
    }
  };
}

/**
Start the server for the scope the trusted launcher described.
*/
async function runCommandsMain(): Promise<void> {
  const environment = process.env;
  const home = environment.HOME?.trim() || homedir();
  try {
    const resolved = resolveCommandsScope({
      moduleDirectory: import.meta.dirname,
      env: environment,
      home,
      args: process.argv.slice(2)
    });
    const runDirectory = autodevRunDirectory(environment, home);
    configureCommandExecutionTelemetry(resolved.role, resolved.workspaceId);
    const running = await startCommandsServer(resolved, runDirectory);
    // The SDK's stdio transport does not close on stdin EOF by itself.
    // Do not leave active commands and a listening registry proxy behind
    // when the trusted gateway closes or stops this backend.
    const shutdown = (): void => {
      void running.close().finally(shutdownTelemetry).catch(() => {
        process.stderr.write("autodev commands mcp: shutdown failed\n");
        process.exitCode = 2;
      }).finally(() => {
        process.stdin.off("end", shutdown);
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      });
    };
    running.server.server.server.onclose = shutdown;
    process.stdin.once("end", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    if (process.stdin.readableEnded) shutdown();
  } catch (error) {
    process.stderr.write(
      `autodev commands mcp: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 2;
  }
}

if (isEntryPoint(import.meta.url)) {
  void runCommandsMain();
}
