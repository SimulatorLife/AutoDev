/**
Execute an operator-approved command under a closed macOS Seatbelt profile.

This module owns two things and refuses to own a third: the confinement
profile a command runs under, and the process that runs it. It never
decides *whether* a command may run -- that is the Runtime's admission, the
execution contract and the catalogue's business -- and it never grants a
command an authority the catalogue did not declare.

A fixed command allowlist is not a sandbox. `pnpm test` runs repository
code and `pnpm install` runs package lifecycle scripts, so every descendant
is constrained independently of the command's own text.
*/
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { isPathWithin, pathsOverlap } from "@simulatorlife/autodev-data/files";
import {
  findExecutable,
  findPnpmGlobalBinary
} from "@simulatorlife/autodev-runtime/shared/executables";
import { execa } from "execa";

import { CommandProcessTree } from "./command-process-tree.ts";
import {
  type CommandDefinition,
  commandExecutableNameSchema,
  type CommandResult
} from "./commands-catalogue.ts";

const SANDBOX = "/usr/bin/sandbox-exec";
/**
The most output a single command may return, in either stream.
*/
const OUTPUT_LIMIT_BYTES = 256 * 1024;
/**
How often the command's live descendant identities are recorded. A new
process group is valid during execution; cleanup belongs to the command's
lifetime, not its process group.
*/
const PROCESS_OBSERVATION_INTERVAL_MS = 250;

/**
The stable key one workspace's command scope is named by.

It is derived from the workspace's own path so that every process that
serves that workspace -- the launcher, the gateway backend, the session's
server -- agrees on the same scratch root, cache root and lease without
exchanging any identity.
*/
export function commandWorkspaceKey(workspace: string): string {
  return createHash("sha256")
    .update(directory(workspace))
    .digest("hex")
    .slice(0, 16);
}

export interface ApprovedCommandScope {
  /**
  Canonical, independently authorized workspace.
  */
  readonly workspace: string;
  /**
  Private scratch root provisioned by the trusted Runtime, not a caller.
  */
  readonly scratch: string;
  /**
  A private, per-workspace cache root (the package store, the tool caches).
  It lives outside the workspace so a command cannot poison another
  workspace's cache, and it is writable only by this workspace's commands.
  */
  readonly cache: string;
  /**
  Only reviewed, protected toolchain roots, never agent-writable paths.
  */
  readonly toolchainRoots: readonly string[];
  /**
  Executable name to reviewed absolute executable, resolved by the operator.
  */
  readonly executables: Readonly<Record<string, string>>;
  /**
  The loopback registry proxy endpoint dependency installation is pointed
  at. Absent means dependency installation is not available at all.
  */
  readonly registryEndpoint?: string;
  /**
  The environment a command's Git commits are attributed through.

  A confined command runs with a private HOME, so Git finds no identity of
  its own and refuses to commit at all. The identity is the Runtime's own
  bounded agent identity -- the same one every other AutoDev agent path
  commits under -- so a commit made through this surface is attributable in
  exactly the same way. It travels in the environment rather than by granting
  the command read access to the operator's Git configuration, which also
  names credential helpers no confined command may reach.
  */
  readonly commitIdentityEnv?: Readonly<Record<string, string>>;
}

/**
The directories a command's executable may be resolved from.

The workspace is deliberately absent: an executable resolved out of the
workspace is a file the agent controls, and a command that runs it runs
whatever the agent last wrote there.
*/
const TRUSTED_EXECUTABLE_PATH = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin"
].join(path.delimiter);

export interface TrustedExecutables {
  /**
  Executable name to the absolute path it was resolved at.
  */
  readonly executables: Readonly<Record<string, string>>;
  /**
  The directories the resolved executables and their runtime live in.
  */
  readonly toolchainRoots: readonly string[];
}

/**
The binary a macOS developer-tool stub runs.

`/usr/bin/git` and its siblings are `xcrun` trampolines: at run time they
load `libxcrun` from the selected developer directory and re-exec the real
tool there. Under a confined profile that directory is unreadable, so the
stub fails before the tool starts ("unable to load libxcrun"). The real
binary is resolved here, outside the sandbox, so the confined command runs
it directly and its toolchain root is the developer directory -- not the
stub's `/usr/bin`. A name `xcrun` does not resolve inside the selected
developer directory is not a stub and stays as resolved.
*/
function developerToolBinary(name: string, resolved: string): string {
  if (process.platform !== "darwin" || path.dirname(resolved) !== "/usr/bin")
    return resolved;
  try {
    const options = {
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
      timeout: 5000
    };
    const developer = realpathSync(
      execFileSync("/usr/bin/xcode-select", ["-p"], options).trim()
    );
    const found = realpathSync(
      execFileSync("/usr/bin/xcrun", ["--find", name], options).trim()
    );
    return isPathWithin(developer, found) ? found : resolved;
  } catch {
    return resolved;
  }
}

/**
Resolve the executables a catalogue names, from trusted locations only.

The resolution never consults the workspace and never trusts a PATH the
workspace could influence. Missing or invalid executables are omitted, so
the affected commands fail closed at registration without preventing
independent commands from being discovered. Never substitute a different
executable for an unavailable definition.
*/
export function resolveTrustedExecutables(
  names: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  home: string = environment.HOME?.trim() || ""
): TrustedExecutables {
  const entries: Array<[string, string]> = [];
  const roots = new Set<string>();
  const uniqueNames = new Set(names);
  for (const name of uniqueNames) {
    try {
      if (!commandExecutableNameSchema.safeParse(name).success) continue;
      const resolved =
        findPnpmGlobalBinary(name, home, environment) ??
        findExecutable(name, TRUSTED_EXECUTABLE_PATH);
      if (!resolved || !path.isAbsolute(resolved)) {
        throw new Error("Executable is unavailable.");
      }
      const executable = developerToolBinary(name, realpathSync(resolved));
      if (!statSync(executable).isFile()) {
        throw new Error("Executable is not a regular file.");
      }
      accessSync(executable, constants.X_OK);
      entries.push([name, executable]);
    } catch {
      // Omit an unavailable executable, not the entire role's command surface.
    }
  }
  const executables = Object.fromEntries(entries);
  for (const entry of Object.values(executables)) {
    roots.add(path.dirname(entry));
    const parent = path.dirname(path.dirname(entry));
    // The filesystem root is never a toolchain root: a profile that grants
    // it would grant the whole disk.
    if (parent !== path.parse(parent).root) roots.add(parent);
  }
  // A package manager is a script that runs the Node binary, and the Node
  // binary a version manager installed is reached through a shim that re-execs
  // the real one. The real binary's directory has to be readable and
  // executable, or the confined command cannot start at all.
  try {
    roots.add(path.dirname(realpathSync(process.execPath)));
  } catch {
    // The running Node binary is always resolvable; a failure here only means
    // the extra root is missing.
  }
  return { executables, toolchainRoots: [...roots] };
}

function directory(value: string): string {
  if (!path.isAbsolute(value))
    throw new Error("Command scope requires absolute paths.");
  const resolved = realpathSync(value);
  if (!statSync(resolved).isDirectory())
    throw new Error("Command scope root is not a directory.");
  return resolved;
}

/**
Require a private root the Runtime's own commands write into.

0o077 rejects any group or other access at all. 0o300 requires that the owner
can still write and search it: a private root nobody can write into is
useless, and it is not a usable lock directory for the package manager
either, which insists on owning a directory it can create files in.
*/
function assertPrivateCommandRoot(root: string): void {
  const stat = statSync(root);
  if (
    (stat.mode & 0o077) !== 0 ||
    (stat.mode & 0o300) !== 0o300 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "Command scratch and cache must be private and owned by the Runtime user."
    );
  }
}

function subtree(value: string): string {
  return "(subpath " + JSON.stringify(value) + ")";
}

function literal(value: string): string {
  return "(literal " + JSON.stringify(value) + ")";
}

/**
The Seatbelt profile one command runs under.

Intentionally narrower than the language-server profile: no blanket host
file reads, no Mach services, no host IPC and no general network. Every
descendant inherits the profile, so a command's own children cannot widen
it. The only network entitlement is a single loopback port -- the registry
proxy -- and only for the execution class that needs it.
*/
export function commandSandboxProfile(
  workspace: string,
  scratch: string,
  cache: string,
  toolchainRoots: readonly string[],
  options: { readonly registryPort?: number } = {}
): string {
  const systemRoots = [
    "/System",
    "/usr/lib",
    "/usr/share",
    "/usr/bin",
    "/bin",
    "/Library/Apple/System"
  ];
  const readRoots = [
    workspace,
    scratch,
    cache,
    ...toolchainRoots,
    ...systemRoots
  ];
  const rules = [
    "(version 1)",
    "(deny default)",
    '(import "dyld-support.sb")',
    "(allow file-read-metadata)",
    "(allow sysctl-read)",
    "(allow process-fork)",
    "(allow process-exec " + readRoots.map(subtree).join(" ") + ")",
    "(allow signal (target same-sandbox))",
    "(allow file-read* " +
      [
        ...readRoots.map(subtree),
        ...[
          "/dev/null",
          "/dev/random",
          "/dev/urandom",
          "/private/etc/localtime"
        ].map(literal)
      ].join(" ") +
      ")",
    "(allow file-write* " +
      [
        subtree(workspace),
        subtree(scratch),
        subtree(cache),
        literal("/dev/null")
      ].join(" ") +
      ")",
    // Workspace files can contain secrets too. Never grant dotenv/registry
    // credentials or agent-private auth directories by virtue of the cwd.
    String.raw`(deny file-read-data file-write* (regex #"/(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.git-credentials)(/|$)"))`,
    String.raw`(deny file-read-data file-write* (regex #"/(\.ssh|\.aws|\.gnupg|\.config/gh)(/|$)"))`,
    // Runtime state is denied except for the two precisely admitted,
    // private writable roots. The credential rules above still apply there.
    String.raw`(deny file-read-data file-write* (require-all (regex #"/(\.codex|\.autodev)(/|$)") ` +
      "(require-not (require-any " +
      subtree(scratch) +
      " " +
      subtree(cache) +
      "))))",
    "(allow file-read-data (require-all " +
      subtree(workspace) +
      String.raw` (regex #"/\.env\.example$")))`
  ];
  if (options.registryPort !== undefined) {
    // The only reachable network peer is the trusted registry proxy, on one
    // known loopback port. Seatbelt cannot express "this host", so the
    // restriction is expressed as "this port", and the proxy is what
    // restricts the host. Seatbelt's `remote ip` filter accepts only `*` or
    // `localhost` as the host, so the loopback name is the only spelling
    // that parses.
    rules.push(
      `(allow network-outbound (remote ip "localhost:${options.registryPort}"))`,
      `(allow network-inbound (remote ip "localhost:${options.registryPort}"))`
    );
  }
  return rules.join("\n");
}

/**
The approved executable is no longer present or runnable where it was
resolved when the scope was admitted. Nothing was started, so the command has
no exit status, and the caller reports a startup failure rather than an
infrastructure fault or a command that ran and failed.
*/
class CommandExecutableUnavailableError extends Error {
  constructor() {
    super("The command's approved executable is unavailable.");
    this.name = "CommandExecutableUnavailableError";
  }
}

export interface PreparedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
Resolve a fixed invocation, using only the independently supplied scope.

Nothing here consults the caller's environment or working directory: the
workspace, the executables and the toolchain all come from the scope the
Runtime established.
*/
export function prepareCommand(
  scope: ApprovedCommandScope,
  definition: CommandDefinition,
  arguments_: readonly string[] = definition.args
): PreparedCommand {
  if (process.platform !== "darwin") {
    throw new Error(
      "Commands MCP requires qualified macOS process confinement."
    );
  }
  accessSync(SANDBOX, constants.X_OK);
  if (
    definition.executionClass === "dependency_install" &&
    !scope.registryEndpoint
  ) {
    throw new Error(
      "Dependency installation requires an approved package-registry boundary."
    );
  }
  const workspace = directory(scope.workspace);
  const scratch = directory(scope.scratch);
  const cache = directory(scope.cache);
  const roots = scope.toolchainRoots.map(directory);
  for (const root of [scratch, cache]) {
    assertPrivateCommandRoot(root);
  }
  if (
    workspace === path.parse(workspace).root ||
    scratch === path.parse(scratch).root ||
    cache === path.parse(cache).root ||
    pathsOverlap(workspace, scratch) ||
    pathsOverlap(workspace, cache) ||
    pathsOverlap(scratch, cache) ||
    roots.length === 0 ||
    roots.some(
      (root) =>
        root === path.parse(root).root ||
        pathsOverlap(root, workspace) ||
        pathsOverlap(root, scratch) ||
        pathsOverlap(root, cache)
    )
  ) {
    throw new Error(
      "Command scope overlaps a protected toolchain or scratch root."
    );
  }
  const configured = Object.hasOwn(scope.executables, definition.executable)
    ? scope.executables[definition.executable]
    : undefined;
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error("Command executable has not been approved.");
  }
  let executable: string;
  try {
    executable = realpathSync(configured);
    if (!statSync(executable).isFile())
      throw new Error("Command executable is not a file.");
    accessSync(executable, constants.X_OK);
  } catch {
    throw new CommandExecutableUnavailableError();
  }
  if (roots.every((root) => !isPathWithin(root, executable))) {
    throw new Error("Command executable is outside the approved toolchain.");
  }
  // PATH holds only approved executable directories, OS binaries and the
  // workspace's own tool directory. Everything else a child resolves is
  // confined by the profile.
  const binDirectories = Object.values(scope.executables).map((entry) => {
    if (!path.isAbsolute(entry))
      throw new Error("Invalid approved executable path.");
    const resolved = realpathSync(entry);
    if (roots.every((root) => !isPathWithin(root, resolved))) {
      throw new Error("Approved executable lies outside its toolchain.");
    }
    return path.dirname(resolved);
  });
  let registryPort: number | undefined;
  if (
    definition.executionClass === "dependency_install" &&
    scope.registryEndpoint
  ) {
    const endpoint = new URL(scope.registryEndpoint);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.port
    ) {
      throw new Error(
        "Dependency installation requires a dedicated loopback registry endpoint."
      );
    }
    registryPort = Number(endpoint.port);
  }
  if (!registryPort && definition.executionClass === "dependency_install") {
    throw new Error(
      "Dependency installation requires an approved package-registry boundary."
    );
  }
  // pnpm and other installed scripts may use /usr/bin/env node. Include
  // the running Runtime's Node directory when it is already admitted,
  // before workspace shims. Do not broaden the profile to discover Node.
  const nodeDirectory = path.dirname(realpathSync(process.execPath));
  const runtimeNode = roots.some((root) => isPathWithin(root, nodeDirectory))
    ? [nodeDirectory]
    : [];
  const environment: Record<string, string> = {
    PATH: [
      ...new Set([
        ...runtimeNode,
        ...binDirectories,
        "/usr/bin",
        "/bin",
        path.join(workspace, "node_modules", ".bin")
      ])
    ].join(path.delimiter),
    HOME: scratch,
    TMPDIR: scratch,
    XDG_CACHE_HOME: path.join(cache, "xdg"),
    /**
    Where the package manager keeps the locks that coordinate the processes
    sharing a store.

    pnpm keeps those locks outside the store, in a per-user directory. On
    Unix that directory is `$XDG_RUNTIME_DIR` when the variable holds an
    absolute path to a directory the current user owns, can write to and
    search, and no other user can write to; otherwise it is `/tmp`. The
    confined command cannot write to `/tmp` -- the profile grants writes only
    inside the workspace, the scratch and the cache -- so without this the
    store lock lands in `/tmp` and every store-touching command fails with
    "Operation not permitted". The private cache satisfies the upstream
    conditions exactly, and it is the same directory that holds the store the
    lock coordinates.
    */
    XDG_RUNTIME_DIR: cache,
    LANG: "C",
    LC_ALL: "C",
    CI: "1",
    // The package manager's own settings are written separately, in the
    // namespace the package manager actually reads.
    // Git must never read the host's configuration. The operator's global
    // file names credential helpers, commit templates and aliases that point
    // outside the workspace, and the system file is host configuration. An
    // empty global configuration leaves Git with no identity of its own, so
    // the Runtime's own identity is the only one a commit can carry.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    // A host fsmonitor daemon is outside the command sandbox. Use Git's
    // ordinary index/worktree scan instead of attempting its IPC or hook.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    // A confined command has no terminal to answer a credential prompt on.
    GIT_TERMINAL_PROMPT: "0",
    // The Runtime's own commit identity, and nothing else from the operator's
    // Git configuration.
    ...scope.commitIdentityEnv
  };
  return {
    executable: SANDBOX,
    args: [
      "-p",
      commandSandboxProfile(workspace, scratch, cache, roots, {
        ...(registryPort && { registryPort })
      }),
      executable,
      ...arguments_
    ],
    cwd: workspace,
    env: {
      ...environment,
      ...packageManagerEnvironment(
        definition.executable,
        cache,
        scope.registryEndpoint &&
          definition.executionClass === "dependency_install"
          ? scope.registryEndpoint
          : undefined
      )
    }
  };
}

/**
The environment a Node package manager reads its own settings from.

A package manager reads its own settings from its own namespace: pnpm reads
`pnpm_config_*` and ignores npm's `npm_config_*` entirely. Written only in
npm's namespace, the registry stays the public one and the store stays in the
operator's home, so the confined install reaches neither the approved proxy
nor the private cache. The approved executable names the namespace the
program that runs certainly reads, and npm's is written alongside it because
it is the convention the other Node package managers follow.

The package manager must also not phone home for anything but the packages:
its store and the lock it takes beside it stay inside the private cache
rather than in the operator's home. And the package manager that runs is the
approved one -- a workspace that pins a different version must not make the
install download that version and run it instead, because the operator
approved an executable, not whatever it fetches at install time. That is
pnpm's own setting, so it is written in the executable's namespace alone.
*/
function packageManagerEnvironment(
  executable: string,
  cache: string,
  registry: string | undefined
): Record<string, string> {
  const namespaces = [...new Set(["npm_config_", `${executable}_config_`])];
  const settings: Record<string, string> = {
    update_notifier: "false",
    fund: "false",
    audit: "false",
    store_dir: path.join(cache, "pnpm-store")
  };
  if (registry) settings.registry = registry;
  const environment: Record<string, string> = {};
  for (const [setting, value] of Object.entries(settings)) {
    for (const namespace of namespaces) {
      environment[`${namespace}${setting}`] = value;
    }
  }
  if (executable !== "npm") {
    environment[`${executable}_config_manage_package_manager_versions`] =
      "false";
  }
  return environment;
}

/**
Run one approved command and report what actually happened.

The exit status is the one the process reported. A failed test is a
completed command with a nonzero status, not a transport failure, and the
result never claims a status that was not observed.

Cancellation, deadline and normal completion share descendant cleanup.
The observer retains known descendants across reparenting; an independent
process group does not itself imply an escape. The Seatbelt profile remains
inherited by every descendant.

`onStarted` receives the command's process id once it exists. The workspace
lease records it for diagnostics. `onCleanupUncertain` tells the admission
owner to retain its lease rather than claim the workspace is idle.
*/
export async function runApprovedCommand(
  commandId: string,
  definition: CommandDefinition,
  arguments_: readonly string[],
  scope: ApprovedCommandScope,
  signal: AbortSignal,
  onStarted?: (pid: number) => void,
  onCleanupUncertain?: () => void
): Promise<CommandResult> {
  const started = performance.now();
  if (signal.aborted) {
    return {
      commandId,
      status: "cancelled",
      exitCode: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      outputTruncated: false
    };
  }
  let prepared: PreparedCommand;
  try {
    prepared = prepareCommand(scope, definition, arguments_);
  } catch (error) {
    if (!(error instanceof CommandExecutableUnavailableError)) throw error;
    return {
      commandId,
      status: "startup_failure",
      exitCode: null,
      durationMs: Math.round(performance.now() - started),
      stdout: "",
      stderr: error.message,
      outputTruncated: false
    };
  }
  const child = execa(prepared.executable, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    extendEnv: false,
    shell: false,
    stdin: "ignore",
    reject: false,
    maxBuffer: OUTPUT_LIMIT_BYTES,
    killDescendants: true
  });
  const tree = new CommandProcessTree(child.pid);
  let termination: "cancelled" | "timed_out" | null = null;
  let cleanupFailed = false;
  let recordingFailed = false;
  let cleanup: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    cleanup ??= tree.terminate().catch(() => {
      cleanupFailed = true;
      // A failed host process inspection must not leave the root running.
      try {
        child.kill("SIGKILL");
      } catch {
        // Cleanup is already uncertain; the caller must retain its lease.
      }
    });
    return cleanup;
  };
  const requestTermination = (reason: "cancelled" | "timed_out"): void => {
    if (termination !== null) return;
    termination = reason;
    void terminate();
  };
  const observe = (): void => {
    if (cleanup) return;
    try {
      tree.observe();
    } catch {
      cleanupFailed = true;
      void terminate();
    }
  };
  // The exit event precedes stream settlement. Reap known descendants
  // immediately, including those holding the command's output pipes open.
  child.nodeChildProcess.once("exit", () => {
    tree.markRootExited();
    void terminate();
  });
  observe();
  const deadline = setTimeout(() => {
    requestTermination("timed_out");
  }, definition.timeoutMs);
  const onAbort = (): void => {
    requestTermination("cancelled");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const observations = setInterval(observe, PROCESS_OBSERVATION_INTERVAL_MS);
  observations.unref();
  let result: Awaited<typeof child>;
  try {
    try {
      if (onStarted && child.pid !== undefined) onStarted(child.pid);
    } catch {
      // Admission bookkeeping is part of execution. Never leave a spawned
      // command running when the workspace lease could not record it.
      recordingFailed = true;
      void terminate();
    }
    result = await child;
  } finally {
    clearTimeout(deadline);
    clearInterval(observations);
    signal.removeEventListener("abort", onAbort);
    // The exit listener, not promise settlement, proves root exit.
    await terminate();
    if (cleanupFailed) onCleanupUncertain?.();
  }
  const status: CommandResult["status"] = cleanupFailed || recordingFailed
    ? "infrastructure_error"
    : result.isMaxBuffer
      ? "output_limit"
      : termination === "timed_out"
        ? "timed_out"
        : termination === "cancelled"
          ? "cancelled"
          : result.exitCode === 0 && !result.failed
            ? "succeeded"
            : result.exitCode === undefined
              ? "infrastructure_error"
              : "failed";
  return {
    commandId,
    status,
    exitCode: result.exitCode ?? null,
    durationMs: Math.round(performance.now() - started),
    stdout: (result.stdout ?? "").slice(0, OUTPUT_LIMIT_BYTES),
    stderr: (
      cleanupFailed
        ? "Command descendant cleanup could not be verified."
        : recordingFailed
          ? "Command process could not be recorded in the workspace lease."
          : (result.stderr ?? "")
    ).slice(0, OUTPUT_LIMIT_BYTES),
    outputTruncated: result.isMaxBuffer
  };
}
