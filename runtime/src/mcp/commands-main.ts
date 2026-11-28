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
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isPathWithin,
  pathsOverlap,
  resolvePathWithExistingAncestor
} from "@simulatorlife/autodev-data/files";
import { autodevRunDirectory } from "@simulatorlife/autodev-runtime/shared/autodev-home";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import { gitCommitIdentityEnv } from "@simulatorlife/autodev-runtime/telemetry";

import {
  type CommandCatalogue,
  parseCommandCatalogueText
} from "./commands-catalogue.ts";
import {
  type ApprovedCommandScope,
  commandWorkspaceKey,
  resolveTrustedExecutables
} from "./commands-execution.ts";
import { startRegistryProxy } from "./commands-registry-proxy.ts";
import {
  type CommandWorkspaceLease,
  createCommandsMcpServer,
  effectiveCommands
} from "./commands-server.ts";
import {
  configureCommandExecutionTelemetry,
  shutdownTelemetry
} from "./mcp-telemetry.ts";

/**
The environment variable that names the role this server serves.
*/
const COMMANDS_ROLE_ENV = "AUTODEV_MCP_ROLE";
/**
The environment variable that names the canonical workspace id.
*/
const COMMANDS_WORKSPACE_ID_ENV = "AUTODEV_MCP_WORKSPACE_ID";
/**
The environment variable that names the workspace root.
*/
const COMMANDS_WORKSPACE_ENV = "AUTODEV_MCP_WORKSPACE";
/**
The registry dependency installation is pointed at.
*/
const COMMANDS_REGISTRY_ENV = "AUTODEV_COMMAND_REGISTRY";

/**
The approved catalogue's file name inside the Runtime's config directory.
*/
export const APPROVED_CATALOGUE_FILE = "commands.json";

class CommandsAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandsAdmissionError";
  }
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
  if (lstatSync(configDirectory).isSymbolicLink()) {
    throw new CommandsAdmissionError(
      "The approved command catalogue directory must not be a symbolic link."
    );
  }
  const catalogueDirectory = realpathSync(configDirectory);
  const catalogue = path.join(catalogueDirectory, APPROVED_CATALOGUE_FILE);
  // Resolve the file too, not just its parent. A link to an editable
  // catalogue must never be treated as an approved installed revision.
  let resolvedCatalogue: string;
  try {
    resolvedCatalogue = realpathSync(catalogue);
  } catch {
    throw new CommandsAdmissionError(
      "The approved command catalogue is unavailable."
    );
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(workspace);
  } catch {
    workspaceRoot = path.resolve(workspace);
  }
  if (
    isPathWithin(workspaceRoot, catalogue) ||
    isPathWithin(workspaceRoot, resolvedCatalogue)
  ) {
    throw new CommandsAdmissionError(
      "The approved command catalogue resolves inside the authorized workspace; an agent that can edit it would be editing its own authority. Install the Runtime and run the command surface from the installed configuration."
    );
  }
  if (resolvedCatalogue !== catalogue) {
    throw new CommandsAdmissionError(
      "The approved command catalogue must not be a symbolic link."
    );
  }
  return catalogue;
}

/**
Read one protected revision through a descriptor, refusing symbolic links,
shared hard links and files writable by another user. The installed parent
directory must also be protected by the Runtime admission boundary.
*/
const MAX_CATALOGUE_BYTES = 1024 * 1024;

export function readApprovedCatalogue(cataloguePath: string): string {
  if (lstatSync(path.dirname(cataloguePath)).isSymbolicLink()) {
    throw new CommandsAdmissionError(
      "The approved command catalogue directory must not be a symbolic link."
    );
  }
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
      throw new CommandsAdmissionError(
        "The approved command catalogue is not a protected regular file."
      );
    }
    if (stat.size > MAX_CATALOGUE_BYTES) {
      throw new CommandsAdmissionError(
        "The approved command catalogue exceeds its size limit."
      );
    }
    // Bound reads even if the file grows between fstat and read.
    const buffer = Buffer.alloc(
      Math.min(stat.size + 1, MAX_CATALOGUE_BYTES + 1)
    );
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        bytes,
        buffer.length - bytes,
        null
      );
      if (count === 0) break;
      bytes += count;
    }
    if (bytes !== stat.size) {
      throw new CommandsAdmissionError(
        "The approved command catalogue changed during read."
      );
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
  const catalogue = parseCommandCatalogueText(content);
  let isRevoked = false;
  return {
    digest,
    catalogue,
    isAuthorized(): boolean {
      if (!isRevoked) {
        try {
          isRevoked =
            catalogueDigest(readApprovedCatalogue(cataloguePath)) !== digest;
        } catch {
          isRevoked = true;
        }
      }
      return !isRevoked;
    }
  };
}

/**
Validate state directories using the same ownership and physical-path rules
for leases, scratch and cache. A Runtime run directory may be readable by
other users, but never writable by them; command-private children are 0700.
*/
function commandDirectoryIdentity(
  directory: string,
  privateDirectory: boolean
) {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    (stat.mode & (privateDirectory ? 0o077 : 0o022)) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new CommandsAdmissionError(
      "Command state directory must be private and must not redirect."
    );
  }
  return stat;
}

function ensureCommandRunDirectory(
  runDirectory: string,
  workspace?: string
): string {
  if (!path.isAbsolute(runDirectory)) {
    throw new CommandsAdmissionError(
      "Command state directory must be absolute."
    );
  }
  const absolute = path.resolve(runDirectory);
  // A not-yet-created run directory has no realpath. Resolve its nearest
  // existing ancestor first, so even /tmp aliases and redirected parents
  // cannot cause us to create command state inside an admitted workspace.
  const physicalRun = resolvePathWithExistingAncestor(absolute);
  if (workspace && pathsOverlap(physicalRun, workspace)) {
    throw new CommandsAdmissionError(
      "Command state directory overlaps the authorized workspace."
    );
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  commandDirectoryIdentity(absolute, false);
  if (realpathSync(absolute) !== physicalRun) {
    throw new CommandsAdmissionError(
      "Command state directory changed during admission."
    );
  }
  return physicalRun;
}

function sameDirectory(
  directory: string,
  identity: ReturnType<typeof commandDirectoryIdentity>,
  privateDirectory = false
): boolean {
  try {
    const current = commandDirectoryIdentity(directory, privateDirectory);
    return (
      realpathSync(directory) === directory &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    );
  } catch {
    return false;
  }
}

/**
Who holds a lease, and which command it was taken for.

The holder is the server process that took the lease; the command is the
root process recorded after launch. Only an explicit settlement record
establishes that the executor finished its descendant cleanup.
*/
interface CommandLeaseRecord {
  readonly holder: number;
  readonly command: number | null;
  readonly settled: boolean;
}

/**
What a lease's record says about the workspace it protects.

`held` is a lease whose holder is alive. `abandoned` is one whose holder is
gone, whose command is no longer alive and whose settlement was recorded.
Without that proof, the lease is `unverifiable`: a root PID disappearing
does not establish that its detached descendants have exited.
*/
type CommandLeaseState = "held" | "abandoned" | "unverifiable";

export interface CommandLeaseReport {
  readonly workspaceKey: string;
  readonly state: CommandLeaseState;
  readonly holder: number | null;
  readonly command: number | null;
  /*
  Whether the holder is still running, as the operating system reports it.
  */
  readonly isHolderAlive: boolean;
  /*
  Whether the command is still running, as the operating system reports it.
  */
  readonly isCommandAlive: boolean;
}

const LEASE_PROCESS_ID = /^[0-9]+$/u;
const LEASE_KEY_ORDER = new Intl.Collator();
const LEASE_FILE_PREFIX = "command-";
const LEASE_FILE_SUFFIX = ".lock";
const LEASE_HOLDER_KEY = "holder";
const LEASE_COMMAND_KEY = "command";
const LEASE_SETTLED_KEY = "settled";

/**
Whether a process is still running.

`kill(pid, 0)` asks the operating system without signalling anything:
`ESRCH` means there is no such process, and `EPERM` means there is one this
process may not signal. A process id that has been reused names a different,
live process, which keeps a lease closed -- the direction that is safe.
*/
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
Read a lease's record.

A record this cannot read is one whose provenance is unknown, and a lease
whose provenance is unknown is never reclaimed.
*/
function readLeaseRecord(content: string): CommandLeaseRecord | null {
  let holder: number | null = null;
  let command: number | null = null;
  let settled = false;
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return null;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (settled) return null;
    if (key === LEASE_SETTLED_KEY) {
      if (value !== "1" || holder === null) return null;
      settled = true;
      continue;
    }
    if (!LEASE_PROCESS_ID.test(value)) return null;
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (key === LEASE_HOLDER_KEY) {
      if (holder !== null) return null;
      holder = pid;
    } else if (key === LEASE_COMMAND_KEY) {
      if (command !== null) return null;
      command = pid;
    } else {
      return null;
    }
  }
  if (holder === null) return null;
  return { holder, command, settled };
}

/**
Read the lease file, if it is a readable regular file with a readable record.
*/
function readLeaseFile(lockPath: string): CommandLeaseRecord | null {
  try {
    if (!lstatSync(lockPath).isFile()) return null;
    return readLeaseRecord(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

/**
What a lease's record says about the workspace it protects.
*/
interface CommandLeaseAssessment {
  readonly state: CommandLeaseState;
  readonly holder: number | null;
  readonly command: number | null;
  readonly isHolderAlive: boolean;
  readonly isCommandAlive: boolean;
}

/**
The state of a lease, from its record and the operating system's own view.
*/
function assessLease(
  record: CommandLeaseRecord | null
): CommandLeaseAssessment {
  if (!record) {
    return {
      state: "unverifiable",
      holder: null,
      command: null,
      isHolderAlive: false,
      isCommandAlive: false
    };
  }
  const isHolderAlive = isProcessAlive(record.holder);
  const isCommandAlive =
    record.command !== null && isProcessAlive(record.command);
  return {
    state: isHolderAlive
      ? "held"
      : record.settled && !isCommandAlive
        ? "abandoned"
        : "unverifiable",
    holder: record.holder,
    command: record.command,
    isHolderAlive,
    isCommandAlive
  };
}

/**
Where one workspace's lease lives.
*/
function commandWorkspaceLeasePath(
  runDirectory: string,
  workspaceKey: string
): string {
  return path.join(
    runDirectory,
    `${LEASE_FILE_PREFIX}${workspaceKey.replaceAll(/[^A-Za-z0-9._-]/gu, "_")}${LEASE_FILE_SUFFIX}`
  );
}

/**
Open the lease file, or report that it is already held.

`wx` creates the file only when it does not exist, so exactly one server can
take the lease for a workspace.
*/
function openLease(lockPath: string): number | null {
  try {
    return openSync(lockPath, "wx", 0o600);
  } catch {
    return null;
  }
}

/**
Reclaim a settled lease whose holder and command are no longer alive.

The lock file is removed only when the record proves the workspace is idle.
Anything unproven leaves the lease in place: an uncertain overlap between two
commands is worse than a workspace that stays closed until the operator has
looked at it.
*/
function reclaimAbandonedLease(lockPath: string): void {
  let identity: ReturnType<typeof lstatSync>;
  try {
    identity = lstatSync(lockPath);
  } catch {
    return;
  }
  // A record that cannot be read leaves the lease unverifiable, which is not
  // the same as abandoned.
  if (
    !identity.isFile() ||
    assessLease(readLeaseFile(lockPath)).state !== "abandoned"
  ) {
    return;
  }
  try {
    const current = lstatSync(lockPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return;
    unlinkSync(lockPath);
  } catch {
    // The lease could not be removed, so it stays held.
  }
}

/**
A workspace-wide exclusive lease.

Two sessions in one workspace must not run commands against it at the same
time: an install and a test would race over the same build outputs. The
lease is a file in the Runtime's own run directory, so it is shared by every
session's server process and never by the workspace itself.
*/
export function createWorkspaceLease(
  runDirectory: string,
  workspaceKey: string
): {
  tryAcquire(): CommandWorkspaceLease | null;
} {
  const physicalRun = ensureCommandRunDirectory(runDirectory);
  const runIdentity = commandDirectoryIdentity(physicalRun, false);
  const lockPath = commandWorkspaceLeasePath(physicalRun, workspaceKey);
  return {
    tryAcquire(): CommandWorkspaceLease | null {
      if (!sameDirectory(physicalRun, runIdentity)) return null;
      let descriptor = openLease(lockPath);
      if (descriptor === null) {
        // The lease exists. Only recorded settlement and dead holder/root
        // permit automatic reclaim. Root exit alone proves nothing about
        // descendants. Opening again succeeds only after actual removal.
        reclaimAbandonedLease(lockPath);
        descriptor = openLease(lockPath);
        if (descriptor === null) return null;
      }
      let identity: ReturnType<typeof fstatSync>;
      try {
        identity = fstatSync(descriptor);
        writeSync(descriptor, `${LEASE_HOLDER_KEY}=${process.pid}\n`);
      } catch {
        closeSync(descriptor);
        // Preserve the lease on an uncertain acquisition failure.
        return null;
      }
      let isReleased = false;
      return {
        noteCommand(pid: number): void {
          if (isReleased || !Number.isSafeInteger(pid) || pid <= 0)
            throw new Error("Cannot record the command process.");
          writeSync(descriptor, `${LEASE_COMMAND_KEY}=${pid}\n`);
        },
        release(cleanupVerified = true): void {
          if (isReleased) return;
          isReleased = true;
          try {
            // Never mark uncertain cleanup as settled, even when the root
            // has already exited. Close the descriptor but retain the lock.
            if (!cleanupVerified) return;
            if (!sameDirectory(physicalRun, runIdentity)) return;
            const current = lstatSync(lockPath);
            if (current.dev === identity.dev && current.ino === identity.ino) {
              writeSync(descriptor, `${LEASE_SETTLED_KEY}=1\n`);
              unlinkSync(lockPath);
            }
          } catch {
            // The lock is already gone or cannot safely be inspected.
          } finally {
            // Retain the descriptor until release to prevent inode reuse
            // from making a replacement lock look like our original.
            closeSync(descriptor);
          }
        }
      };
    }
  };
}

/**
The leases the run directory holds, and what can be said about each.
*/
export function inspectCommandLeases(
  runDirectory: string
): CommandLeaseReport[] {
  const physicalRun = ensureCommandRunDirectory(runDirectory);
  const reports: CommandLeaseReport[] = [];
  const entries = readdirSync(physicalRun, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(LEASE_FILE_PREFIX) ||
      !entry.name.endsWith(LEASE_FILE_SUFFIX)
    ) {
      continue;
    }
    const workspaceKey = entry.name.slice(
      LEASE_FILE_PREFIX.length,
      entry.name.length - LEASE_FILE_SUFFIX.length
    );
    const assessment = assessLease(
      readLeaseFile(path.join(physicalRun, entry.name))
    );
    reports.push({ workspaceKey, ...assessment });
  }
  return reports.sort((left, right) =>
    LEASE_KEY_ORDER.compare(left.workspaceKey, right.workspaceKey)
  );
}

/**
Release one lease, when the operator has decided it may be released.

A settled lease whose holder and command are gone is released on that
evidence. A readable lease without proof of settlement requires explicit
operator confirmation after the holder has stopped.
*/
export function releaseCommandLease(
  runDirectory: string,
  workspaceKey: string,
  options: { readonly force: boolean }
): { readonly released: boolean; readonly reason: string } {
  const physicalRun = ensureCommandRunDirectory(runDirectory);
  const lockPath = commandWorkspaceLeasePath(physicalRun, workspaceKey);
  const record = readLeaseFile(lockPath);
  if (!record) {
    return {
      released: false,
      reason: "there is no readable lease for that workspace"
    };
  }
  const assessment = assessLease(record);
  if (assessment.state === "held") {
    return {
      released: false,
      reason: "the lease is held by a running server"
    };
  }
  if (assessment.state === "abandoned") {
    reclaimAbandonedLease(lockPath);
    if (existsSync(lockPath)) {
      return {
        released: false,
        reason: "the lease changed while it was being released"
      };
    }
    return {
      released: true,
      reason: "the lease was settled and its holder and command are gone"
    };
  }
  if (!options.force) {
    return {
      released: false,
      reason:
        "the lease cannot be verified as abandoned; release it with --force once you have checked the workspace"
    };
  }
  try {
    unlinkSync(lockPath);
  } catch {
    return { released: false, reason: "the lease could not be removed" };
  }
  return {
    released: true,
    reason: "the lease was released on the operator's authority"
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

/**
The key one scope's durable task records are named by.

A task belongs to a role and a workspace, so its records live in their own
directory: one role's tasks are never readable by another role's, even when
both serve the same workspace.
*/
function commandScopeKey(role: string, workspaceKey: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(role)) {
    throw new CommandsAdmissionError("Invalid command role.");
  }
  if (!/^[a-f0-9]{16}$/u.test(workspaceKey)) {
    throw new CommandsAdmissionError("Invalid command workspace key.");
  }
  return `${role}-${workspaceKey}`;
}

/**
The private directory one scope's durable task records live in.

The records outlive the backend process, so they are kept in the Runtime's
own run directory, never in the workspace and never in a shared cache.
*/
export function commandTaskRoot(
  runDirectory: string,
  role: string,
  workspaceKey: string
): string {
  return privateCommandRoot(
    runDirectory,
    "command-tasks",
    commandScopeKey(role, workspaceKey)
  );
}

function privateCommandRoot(
  runDirectory: string,
  kind: "command-scratch" | "command-cache" | "command-tasks",
  scopeKey: string
): string {
  if (
    !/^(?:[a-f0-9]{16}|[a-z0-9][a-z0-9_-]{0,63}-[a-f0-9]{16})$/u.test(scopeKey)
  ) {
    throw new CommandsAdmissionError("Invalid command workspace key.");
  }
  const physicalRun = ensureCommandRunDirectory(runDirectory);
  const parent = path.join(physicalRun, kind);
  const root = path.join(parent, scopeKey);
  for (const directory of [parent, root]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    commandDirectoryIdentity(directory, true);
    if (realpathSync(directory) !== directory) {
      throw new CommandsAdmissionError(
        "Command state directory must be private and must not redirect."
      );
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
function commandsArgumentValue(
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
  readonly runDirectory: string;
  /**
  The private directory this scope's durable task records live in.
  */
  readonly taskDirectory: string;
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
    commandsArgumentValue(options.args, "--role") ??
    environment[COMMANDS_ROLE_ENV] ??
    ""
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
    throw new CommandsAdmissionError(
      "The Commands MCP workspace is not a directory."
    );
  }
  const workspaceId =
    commandsArgumentValue(options.args, "--workspace-id")?.trim() ??
    environment[COMMANDS_WORKSPACE_ID_ENV]?.trim() ??
    null;
  const cataloguePath = approvedCataloguePath(
    options.moduleDirectory,
    workspace
  );
  const approved = createApprovedCatalogueGrant(cataloguePath);
  const runDirectory = ensureCommandRunDirectory(
    autodevRunDirectory(environment, home),
    workspace
  );
  const runIdentity = commandDirectoryIdentity(runDirectory, false);
  const workspaceKey = commandWorkspaceKey(workspace);
  const effective = effectiveCommands({
    role,
    workspaceId,
    catalogue: approved.catalogue
  });
  const executables = resolveTrustedExecutables(
    [...effective.values().map((entry) => entry.executable)],
    environment,
    home
  );
  const scope: ApprovedCommandScope = {
    workspace,
    scratch: commandScratchRoot(runDirectory, workspaceKey),
    cache: commandCacheRoot(runDirectory, workspaceKey),
    toolchainRoots: executables.toolchainRoots,
    executables: executables.executables,
    // A command that commits must attribute the commit to the agent that
    // made it, exactly as the Runtime's other agent paths do. The provider
    // is not part of a gateway scope, so the identity records the role and
    // reports the provider as unknown.
    commitIdentityEnv: gitCommitIdentityEnv({ role })
  };
  const scratchIdentity = commandDirectoryIdentity(scope.scratch, true);
  const cacheIdentity = commandDirectoryIdentity(scope.cache, true);
  const taskDirectory = commandTaskRoot(runDirectory, role, workspaceKey);
  const taskIdentity = commandDirectoryIdentity(taskDirectory, true);
  return {
    role,
    workspace,
    workspaceId,
    scope,
    catalogue: approved.catalogue,
    digest: approved.digest,
    isAuthorized() {
      if (
        !approved.isAuthorized() ||
        !sameDirectory(runDirectory, runIdentity) ||
        !sameDirectory(scope.scratch, scratchIdentity, true) ||
        !sameDirectory(scope.cache, cacheIdentity, true) ||
        !sameDirectory(taskDirectory, taskIdentity, true)
      ) {
        return false;
      }
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
    workspaceKey,
    runDirectory,
    taskDirectory
  };
}

/**
Start the server for one admitted scope.

The registry proxy is only started when the effective grant actually
contains a dependency install, so a scope that may not install packages
never opens a network path at all.
*/
async function startCommandsServer(resolved: ResolvedCommandsScope): Promise<{
  readonly server: Awaited<ReturnType<typeof createCommandsMcpServer>>;
  close(): Promise<void>;
}> {
  if (!resolved.isAuthorized()) {
    throw new CommandsAdmissionError(
      "Command execution grant is unavailable or revoked."
    );
  }
  const lease = createWorkspaceLease(
    resolved.runDirectory,
    resolved.workspaceKey
  );
  const effective = effectiveCommands(resolved);
  const needsRegistry = effective
    .values()
    .some(
      (definition) =>
        definition.executionClass === "dependency_install" &&
        Object.hasOwn(resolved.scope.executables, definition.executable)
    );
  const registry = needsRegistry
    ? await startRegistryProxy({
        registry:
          process.env[COMMANDS_REGISTRY_ENV]?.trim() ||
          "https://registry.npmjs.org"
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
      taskDirectory: resolved.taskDirectory,
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
    configureCommandExecutionTelemetry(resolved.role, resolved.workspaceId);
    const running = await startCommandsServer(resolved);
    const registered = new Set(running.server.commandIds);
    const unavailable = [...effectiveCommands(resolved).keys()].filter(
      (id) => !registered.has(id)
    );
    if (unavailable.length > 0) {
      process.stderr.write(
        `autodev commands mcp: unavailable command tools: ${unavailable.join(", ")}\n`
      );
    }
    // The SDK's stdio transport does not close on stdin EOF by itself.
    // Do not leave active commands and a listening registry proxy behind
    // when the trusted gateway closes or stops this backend.
    const shutdown = (): void => {
      void running
        .close()
        .finally(shutdownTelemetry)
        .catch(() => {
          process.stderr.write("autodev commands mcp: shutdown failed\n");
          process.exitCode = 2;
        })
        .finally(() => {
          process.stdin.off("end", shutdown);
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
        });
    };
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP SDK Server exposes an onclose callback property, not EventTarget.
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
