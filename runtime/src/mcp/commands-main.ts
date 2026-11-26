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
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
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

/**
How long a workspace lease may be held before it is considered abandoned.
*/
const LEASE_STALE_MS = 30 * 60 * 1000;

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
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(workspace);
  } catch {
    workspaceRoot = path.resolve(workspace);
  }
  if (isWithin(catalogue, workspaceRoot)) {
    throw new CommandsAdmissionError(
      "The approved command catalogue resolves inside the authorized workspace; an agent that can edit it would be editing its own authority. Install the Runtime and run the command surface from the installed configuration."
    );
  }
  return catalogue;
}

/**
The digest of the approved catalogue, which is what revocation is judged on.
*/
export function catalogueDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
A revocation check bound to one approved catalogue revision.

The approved catalogue is re-read on every check, so an operator who
replaces or removes it revokes the grant immediately -- including for a
command that is already running, whose next lifecycle operation fails.
*/
export function createApprovedCatalogueGrant(cataloguePath: string): {
  readonly digest: string;
  readonly catalogue: CommandCatalogue;
  isAuthorized(): boolean;
} {
  const content = readFileSync(cataloguePath, "utf8");
  const digest = catalogueDigest(content);
  const catalogue = parseCommandCatalogue(JSON.parse(content));
  return {
    digest,
    catalogue,
    isAuthorized(): boolean {
      try {
        return catalogueDigest(readFileSync(cataloguePath, "utf8")) === digest;
      } catch {
        return false;
      }
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
      if (existsSync(lockPath)) {
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > LEASE_STALE_MS) unlinkSync(lockPath);
          else return null;
        } catch {
          return null;
        }
      }
      let descriptor: number;
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
      } catch {
        return null;
      }
      try {
        writeSync(descriptor, `${process.pid}\n`);
      } finally {
        closeSync(descriptor);
      }
      let isReleased = false;
      return () => {
        if (isReleased) return;
        isReleased = true;
        try {
          unlinkSync(lockPath);
        } catch {
          // The lock is already gone.
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
  const root = path.join(
    runDirectory,
    "command-scratch",
    workspaceKey.replaceAll(/[^A-Za-z0-9._-]/gu, "_")
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/**
The private, per-workspace cache root one scope's commands may write.
*/
export function commandCacheRoot(
  runDirectory: string,
  workspaceKey: string
): string {
  const root = path.join(
    runDirectory,
    "command-cache",
    workspaceKey.replaceAll(/[^A-Za-z0-9._-]/gu, "_")
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
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
  const workspace = (
    commandsArgumentValue(options.args, "--workspace") ??
    environment[COMMANDS_WORKSPACE_ENV] ??
    ""
  ).trim();
  if (!workspace || !path.isAbsolute(workspace)) {
    throw new CommandsAdmissionError(
      `The Commands MCP requires an absolute ${COMMANDS_WORKSPACE_ENV}.`
    );
  }
  if (!existsSync(workspace)) {
    throw new CommandsAdmissionError(
      `The Commands MCP workspace does not exist: ${workspace}`
    );
  }
  const workspaceId =
    commandsArgumentValue(options.args, "--workspace-id")?.trim() ??
    environment[COMMANDS_WORKSPACE_ID_ENV]?.trim() ??
    null;
  const cataloguePath = approvedCataloguePath(options.moduleDirectory, workspace);
  const approved = createApprovedCatalogueGrant(cataloguePath);
  const runDirectory = autodevRunDirectory(environment, home);
  const workspaceKey = commandWorkspaceKey(workspace);
  const executables = resolveTrustedExecutables(
    [...new Set(Object.values(approved.catalogue.commands).map((entry) => entry.executable))],
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
    isAuthorized: approved.isAuthorized,
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
  const effective = effectiveCommands({
    role: resolved.role,
    workspaceId: resolved.workspaceId,
    catalogue: resolved.catalogue,
    scope: resolved.scope,
    isAuthorized: resolved.isAuthorized,
    tryAcquireWorkspace: () => null
  });
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
  const created = createCommandsMcpServer({
    role: resolved.role,
    workspaceId: resolved.workspaceId,
    catalogue: resolved.catalogue,
    scope,
    isAuthorized: resolved.isAuthorized,
    tryAcquireWorkspace: lease.tryAcquire
  });
  const transport = new StdioServerTransport();
  await created.server.connect(transport);
  return {
    server: created,
    async close() {
      await created.close();
      await registry?.close();
    }
  };
}

/**
Start the server for the scope the trusted launcher described.
*/
function runCommandsMain(): number {
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
    void startCommandsServer(resolved, runDirectory).catch((error: unknown) => {
      process.stderr.write(
        `autodev commands mcp: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 2;
    });
    return 0;
  } catch (error) {
    process.stderr.write(
      `autodev commands mcp: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = runCommandsMain();
}
