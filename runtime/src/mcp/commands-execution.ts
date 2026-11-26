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

import {
  commandExecutableNameSchema,
  type CommandDefinition,
  type CommandResult
} from "./commands-catalogue.ts";
import {
  terminateCommandProcessTree,
  terminateDetachedCommandDescendants
} from "./command-process-tree.ts";

const SANDBOX = "/usr/bin/sandbox-exec";
/**
The most output a single command may return, in either stream.
*/
const OUTPUT_LIMIT_BYTES = 256 * 1024;
/**
How often a running command is checked for a descendant that left its process
group. Such a descendant is terminated as soon as it is seen, so it cannot
outlive the command it belongs to.
*/
const STRAY_SWEEP_INTERVAL_MS = 250;

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
  for (const name of new Set(names)) {
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
  if (!path.isAbsolute(value)) throw new Error("Command scope requires absolute paths.");
  const resolved = realpathSync(value);
  if (!statSync(resolved).isDirectory()) throw new Error("Command scope root is not a directory.");
  return resolved;
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
  const systemRoots = ["/System", "/usr/lib", "/usr/share", "/usr/bin", "/bin", "/Library/Apple/System"];
  const readRoots = [workspace, scratch, cache, ...toolchainRoots, ...systemRoots];
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
        ...["/dev/null", "/dev/random", "/dev/urandom", "/private/etc/localtime"].map(literal)
      ].join(" ") +
      ")",
    "(allow file-write* " +
      [subtree(workspace), subtree(scratch), subtree(cache), literal("/dev/null")].join(" ") +
      ")",
    // Workspace files can contain secrets too. Never grant dotenv/registry
    // credentials or agent-private auth directories by virtue of the cwd.
    String.raw`(deny file-read-data file-write* (regex #"/(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.git-credentials)(/|$)"))`,
    String.raw`(deny file-read-data file-write* (regex #"/(\.ssh|\.aws|\.gnupg|\.config/gh)(/|$)"))`,
    // Runtime state is denied except for the two precisely admitted,
    // private writable roots. The credential rules above still apply there.
    String.raw`(deny file-read-data file-write* (require-all (regex #"/(\.codex|\.autodev)(/|$)") ` +
      "(require-not (require-any " + subtree(scratch) + " " + subtree(cache) + "))))",
    "(allow file-read-data (require-all " + subtree(workspace) + String.raw` (regex #"/\.env\.example$")))`
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
    throw new Error("Commands MCP requires qualified macOS process confinement.");
  }
  accessSync(SANDBOX, constants.X_OK);
  if (definition.executionClass === "dependency_install" && !scope.registryEndpoint) {
    throw new Error("Dependency installation requires an approved package-registry boundary.");
  }
  const workspace = directory(scope.workspace);
  const scratch = directory(scope.scratch);
  const cache = directory(scope.cache);
  const roots = scope.toolchainRoots.map(directory);
  for (const root of [scratch, cache]) {
    const rootStat = statSync(root);
    if (
      (rootStat.mode & 0o077) !== 0 ||
      (process.getuid && rootStat.uid !== process.getuid())
    ) {
      throw new Error("Command scratch and cache must be private and owned by the Runtime user.");
    }
  }
  if (
    workspace === path.parse(workspace).root ||
    scratch === path.parse(scratch).root ||
    cache === path.parse(cache).root ||
    pathsOverlap(workspace, scratch) ||
    pathsOverlap(workspace, cache) ||
    pathsOverlap(scratch, cache) ||
    roots.length === 0 ||
    roots.some((root) =>
      root === path.parse(root).root ||
      pathsOverlap(root, workspace) ||
      pathsOverlap(root, scratch) ||
      pathsOverlap(root, cache)
    )
  ) {
    throw new Error("Command scope overlaps a protected toolchain or scratch root.");
  }
  const configured = Object.hasOwn(scope.executables, definition.executable)
    ? scope.executables[definition.executable]
    : undefined;
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error("Command executable has not been approved.");
  }
  const executable = realpathSync(configured);
  if (roots.every((root) => !isPathWithin(root, executable))) {
    throw new Error("Command executable is outside the approved toolchain.");
  }
  if (!statSync(executable).isFile()) throw new Error("Command executable is not a file.");
  accessSync(executable, constants.X_OK);
  // PATH holds only approved executable directories, OS binaries and the
  // workspace's own tool directory. Everything else a child resolves is
  // confined by the profile.
  const binDirectories = Object.values(scope.executables).map((entry) => {
    if (!path.isAbsolute(entry)) throw new Error("Invalid approved executable path.");
    const resolved = realpathSync(entry);
    if (roots.every((root) => !isPathWithin(root, resolved))) {
      throw new Error("Approved executable lies outside its toolchain.");
    }
    return path.dirname(resolved);
  });
  let registryPort: number | undefined;
  if (definition.executionClass === "dependency_install" && scope.registryEndpoint) {
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
      throw new Error("Dependency installation requires a dedicated loopback registry endpoint.");
    }
    registryPort = Number(endpoint.port);
  }
  if (!registryPort && definition.executionClass === "dependency_install") {
    throw new Error("Dependency installation requires an approved package-registry boundary.");
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
    LANG: "C",
    LC_ALL: "C",
    CI: "1",
    // The package manager must not phone home for anything but the packages.
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_store_dir: path.join(cache, "pnpm-store"),
    // Git must never read the host's configuration. The operator's global
    // file names credential helpers, commit templates and aliases that point
    // outside the workspace, and the system file is host configuration. An
    // empty global configuration leaves Git with no identity of its own, so
    // the Runtime's own identity is the only one a commit can carry.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    // A confined command has no terminal to answer a credential prompt on.
    GIT_TERMINAL_PROMPT: "0",
    // The Runtime's own commit identity, and nothing else from the operator's
    // Git configuration.
    ...scope.commitIdentityEnv
  };
  if (scope.registryEndpoint && definition.executionClass === "dependency_install") {
    environment.npm_config_registry = scope.registryEndpoint;
  }
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
    env: environment
  };
}

/**
Run one approved command and report what actually happened.

The exit status is the one the process reported. A failed test is a
completed command with a nonzero status, not a transport failure, and the
result never claims a status that was not observed.

Cancellation and the command's own deadline are handled here rather than by
the executor's process-group signal, because a group signal does not reach a
descendant that detached into its own session. The tree is terminated while
the parent-child relationship still identifies every descendant.
*/
export async function runApprovedCommand(
  commandId: string,
  definition: CommandDefinition,
  arguments_: readonly string[],
  scope: ApprovedCommandScope,
  signal: AbortSignal
): Promise<CommandResult> {
  const started = performance.now();
  const prepared = prepareCommand(scope, definition, arguments_);
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
  let termination: "cancelled" | "timed_out" | null = null;
  const terminate = async (
    reason: "cancelled" | "timed_out"
  ): Promise<void> => {
    if (termination !== null) return;
    termination = reason;
    await terminateCommandProcessTree(child.pid);
    // The group's own signal is the backstop for anything the walk did not
    // reach, such as a descendant that started between two walks.
    child.kill("SIGKILL");
  };
  const deadline = setTimeout(() => {
    void terminate("timed_out");
  }, definition.timeoutMs);
  const onAbort = (): void => {
    void terminate("cancelled");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  // A descendant that detached while the command was running is terminated as
  // soon as it is seen, so it cannot outlive the command it belongs to.
  const strays = setInterval(() => {
    terminateDetachedCommandDescendants(child.pid);
  }, STRAY_SWEEP_INTERVAL_MS);
  strays.unref();
  let result: Awaited<typeof child>;
  try {
    result = await child;
  } finally {
    clearTimeout(deadline);
    clearInterval(strays);
    signal.removeEventListener("abort", onAbort);
  }
  const status: CommandResult["status"] = result.isMaxBuffer
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
    stderr: (result.stderr ?? "").slice(0, OUTPUT_LIMIT_BYTES),
    outputTruncated: result.isMaxBuffer
  };
}
