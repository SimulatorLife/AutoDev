/**
 * Executable lookup shared by the MCP launcher and platform lifecycle code,
 * so every caller resolves a tool's binary the same way.
 *
 * The Codex CLI follows one rule here, because a machine usually holds more
 * than one copy of it: an explicit `CODEX_BIN` wins, and otherwise the
 * newest CLI installed is the one every surface runs.
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLED_MARKETPLACE } from "./bundled-plugins.ts";

const NUMERIC_COLLATOR = new Intl.Collator(undefined, { numeric: true });
const OPENCLI_PACKAGE = "@jackwener/opencli";

export function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(
  name: string,
  pathValue = process.env.PATH ?? ""
): string | null {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Find a CLI installed globally by pnpm even under launchd's minimal PATH.
 * PNPM_HOME can override the platform default without depending on a shell profile.
 */
export function findPnpmGlobalBinary(
  name: string,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const pnpmHome =
    env.PNPM_HOME?.trim() ||
    path.join(
      home,
      process.platform === "darwin" ? "Library/pnpm" : ".local/share/pnpm"
    );
  const candidate = path.join(pnpmHome, "bin", name);
  return isExecutable(candidate) ? candidate : null;
}

const CODEX_VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/u;

/** The versions this process has read, keyed by the binary they came from. */
const codexVersionCache = new Map<
  string,
  {
    readonly mtimeMs: number;
    readonly size: number;
    readonly version: string | null;
  }
>();

function defaultCodexVersionRunner(
  file: string,
  args: readonly string[]
): string {
  return execFileSync(file, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000
  });
}

function probeCodexCliVersion(
  binary: string,
  run: (file: string, args: readonly string[]) => string
): string | null {
  let output: string;
  try {
    output = run(binary, ["--version"]);
  } catch {
    return null;
  }
  return CODEX_VERSION_PATTERN.exec(output)?.[0] ?? null;
}

/**
 * The version a Codex CLI reports, or null when it does not report one.
 *
 * The reading is cached against the binary's size and modification time, so
 * the cost is paid once per install rather than once per lookup.
 */
export function codexCliVersion(
  binary: string,
  run?: (file: string, args: readonly string[]) => string
): string | null {
  if (run) return probeCodexCliVersion(binary, run);
  let stat: { mtimeMs: number; size: number } | null = null;
  try {
    stat = statSync(binary);
  } catch {
    /* unavailable */
  }
  const cached = stat ? codexVersionCache.get(binary) : undefined;
  if (
    stat &&
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.version;
  }
  const version = probeCodexCliVersion(binary, defaultCodexVersionRunner);
  if (stat) {
    codexVersionCache.set(binary, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      version
    });
  }
  return version;
}

/**
 * Order two Codex versions, newest first.
 *
 * A version that could not be read is the oldest one: a CLI that does not say
 * which release it is cannot claim to be newer than one that does.
 */
function compareCodexVersions(
  left: string | null,
  right: string | null
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The Codex CLI installs this machine has.
 *
 * Three places hold one: the standalone install under the local bin
 * directory, the first `codex` on PATH, and pnpm's global bin directory,
 * which is the one a launchd service's minimal PATH still names.
 */
function codexCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  return [
    ...new Set(
      [
        path.join(home, ".local", "bin", "codex"),
        findExecutable("codex", env.PATH ?? ""),
        findPnpmGlobalBinary("codex", home, env)
      ].filter(
        (candidate): candidate is string =>
          candidate !== null && isExecutable(candidate)
      )
    )
  ];
}

/**
 * The Codex CLI to use: the operator's explicit setting, else the newest CLI
 * this machine has.
 *
 * The newest CLI wins because the first one on PATH is often the wrong one:
 * a stale install under the system bin directory predates the subcommands the
 * role bridge and the command rules depend on, and a CLI that rejects them
 * breaks both at once. An explicit `CODEX_BIN` is the operator's decision
 * and always wins.
 *
 * The answer is null when this machine has no Codex CLI at all. A
 * `CODEX_BIN` that names something unusable is a misconfiguration rather
 * than an absence, and is reported as one instead of being quietly ignored.
 */
export function findCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string | null {
  const configured = env.CODEX_BIN?.trim();
  if (configured) {
    const resolved = configured.includes(path.sep)
      ? configured
      : findExecutable(configured, env.PATH ?? "");
    if (resolved && isExecutable(resolved)) return resolved;
    throw new Error(`Codex CLI is not executable: ${configured}`);
  }
  const candidates = codexCandidates(env, home);
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map((candidate) => ({ candidate, version: codexCliVersion(candidate) }))
    .sort((left, right) => compareCodexVersions(left.version, right.version));
  return ranked[0]?.candidate ?? null;
}

/**
 * The same lookup, reported as a failure: where the Codex CLI is, or why it
 * is not usable.
 */
export function resolveCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string {
  const binary = findCodexBinary(env, home);
  if (binary) return binary;
  throw new Error(
    "Codex CLI not found; set CODEX_BIN to the current codex executable."
  );
}

/**
 * The Copilot CLI: `COPILOT_BIN` as given, else the first executable on PATH,
 * else the pnpm global bin directory.
 *
 * A launchd bridge may lack PNPM_HOME in PATH, so the pnpm-managed global
 * executable is checked explicitly after the requested PATH.
 */
export function resolveCopilotBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string {
  const configured = env.COPILOT_BIN?.trim();
  if (configured) {
    // `COPILOT_BIN` named a command, not only a path, so a bare name is
    // still resolved against PATH before it is called missing.
    const resolved = configured.includes(path.sep)
      ? configured
      : findExecutable(configured, env.PATH ?? "");
    if (resolved && isExecutable(resolved)) return resolved;
    throw new Error(`Copilot CLI is not executable: ${configured}`);
  }
  const fromPath = findExecutable("copilot", env.PATH ?? "");
  if (fromPath) return fromPath;

  const fromPnpm = findPnpmGlobalBinary("copilot", home, env);
  if (fromPnpm) return fromPnpm;
  const local = path.join(home, ".local", "bin", "copilot");
  if (isExecutable(local)) return local;
  throw new Error(
    "Copilot CLI not found; set COPILOT_BIN to the current copilot executable."
  );
}

/**
 * The same lookup without the failure: where the Copilot CLI is, or null when
 * it is not installed. The callers that only need to know whether it exists
 * ask this, so "is the Copilot CLI installed" has one answer everywhere.
 */
export function findCopilotBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string | null {
  try {
    return resolveCopilotBinary(env, home);
  } catch {
    return null;
  }
}

/**
 * How to run opencli: `OPENCLI_BIN` as given, else the `@jackwener/opencli`
 * entry point this Runtime depends on, run with the current Node.
 *
 * opencli is a package dependency of the Runtime rather than a global install,
 * so the bridge and the installer resolve the exact version the lockfile pins.
 * Its daemon is shared machine-wide on one port, and a second opencli version
 * started beside it reports the daemon as stale; pinning one version keeps the
 * bridge's CLI and the daemon it talks to in step. The launchd PATH names no
 * version manager's bin directory, so resolving through the module graph is
 * also what keeps the supervised bridge from depending on the login shell.
 *
 * The package is found by walking the `node_modules` directories above this
 * module on every call, not through `import.meta.resolve`: Node's ESM resolver
 * caches what it resolved, so a long-lived bridge would keep launching the
 * pre-install version after `pnpm install` swaps the package symlink.
 */
export interface OpencliCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function resolveOpencliCommand(
  env: NodeJS.ProcessEnv = process.env
): OpencliCommand {
  const configured = env.OPENCLI_BIN?.trim();
  if (configured) {
    const resolved = configured.includes(path.sep)
      ? configured
      : findExecutable(configured, env.PATH ?? "");
    if (resolved && isExecutable(resolved))
      return { command: resolved, args: [] };
    throw new Error(`opencli is not executable: ${configured}`);
  }
  const entry = findOpencliPackageEntry();
  if (!entry)
    throw new Error(
      "opencli is not installed; run pnpm install --frozen-lockfile in the AutoDev checkout."
    );
  if (!existsSync(entry))
    throw new Error(`opencli entry point is missing: ${entry}`);
  return { command: process.execPath, args: [entry] };
}

/** The package's `opencli` bin, read from the installed manifest as it is now. */
function findOpencliPackageEntry(): string | null {
  return findRuntimePackageBin(OPENCLI_PACKAGE, "opencli");
}

/**
 * The directory of a package this Runtime depends on, as the `node_modules`
 * walk-up from this module reaches it (`<node_modules>/<packageName>`, not its
 * realpath).
 *
 * Resolution starts at the Runtime's own module and never at a configured
 * repository root. An installed Runtime therefore resolves the protected
 * dependency closure its source generation links to, and no environment value
 * -- `AUTODEV_REPO_ROOT` included -- can redirect a Runtime-launched tool into
 * an editable checkout.
 */
export function findRuntimePackageDirectory(
  packageName: string,
  moduleDirectory: string = path.dirname(fileURLToPath(import.meta.url))
): string | null {
  let directory = moduleDirectory;
  for (;;) {
    const packageDirectory = path.join(directory, "node_modules", packageName);
    if (existsSync(path.join(packageDirectory, "package.json")))
      return packageDirectory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * The physical entry script of a Runtime dependency's bin, read from its
 * installed manifest as it is now. Callers run it with the current Node, so no
 * package-manager shim or caller PATH entry chooses what executes.
 */
export function findRuntimePackageBin(
  packageName: string,
  binName: string,
  moduleDirectory?: string
): string | null {
  const packageDirectory = findRuntimePackageDirectory(
    packageName,
    moduleDirectory
  );
  if (!packageDirectory) return null;
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(packageDirectory, "package.json"), "utf8")
    ) as { bin?: string | Record<string, string> };
    const bin =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
    if (!bin) return null;
    const entry = path.resolve(realpathSync(packageDirectory), bin);
    return existsSync(entry) ? realpathSync(entry) : null;
  } catch {
    return null;
  }
}

/** {@link findRuntimePackageBin}, failing with the package that is missing. */
export function resolveRuntimePackageBin(
  packageName: string,
  binName: string,
  moduleDirectory?: string
): string {
  const entry = findRuntimePackageBin(packageName, binName, moduleDirectory);
  if (!entry)
    throw new Error(
      `Runtime dependency ${packageName} (bin ${binName}) is not installed; reinstall AutoDev.`
    );
  return entry;
}

/**
 * The `node_modules/.bin` directory of the dependency tree that holds
 * `packageName`, for a tool that spawns a sibling executable by bare name.
 */
export function runtimeBinDirectory(
  packageName: string,
  moduleDirectory?: string
): string | null {
  const packageDirectory = findRuntimePackageDirectory(
    packageName,
    moduleDirectory
  );
  if (!packageDirectory) return null;
  const segments = packageName.split("/").length;
  let nodeModules = packageDirectory;
  for (let index = 0; index < segments; index++)
    nodeModules = path.dirname(nodeModules);
  return path.join(nodeModules, ".bin");
}

/** The same lookup without the failure, for callers that only ask whether it exists. */
export function findOpencliCommand(
  env: NodeJS.ProcessEnv = process.env
): OpencliCommand | null {
  try {
    return resolveOpencliCommand(env);
  } catch {
    return null;
  }
}

export interface CodexAppMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * The Claude Code CLI: `CLAUDE_BIN` as given, else the install under
 * `~/.local/bin`.
 *
 * The bridge that spawns it and the Runtime's reading of its version must
 * name the same file, so both resolve it here. A version read from a
 * different installation than the one serving turns would be a number the
 * operator cannot act on.
 */
export function resolveClaudeBinary(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env.CLAUDE_BIN?.trim();
  if (configured) return configured;
  return path.join(env.HOME ?? homedir(), ".local", "bin", "claude");
}

/** The same lookup without the failure: where the CLI is, or null when it is not there. */
export function findClaudeBinary(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const resolved = resolveClaudeBinary(env);
  return isExecutable(resolved) ? resolved : null;
}

/**
 * The Antigravity CLI (`agy`): `AGY_CLI_PATH` as given, else the install under
 * `~/.local/bin`.
 *
 * Resolved here for the same reason as the Claude CLI: the bridge that
 * spawns it and the reading of its version have to name the same file.
 */
export function resolveAgyBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGY_CLI_PATH?.trim();
  if (configured) return configured;
  return `${env.HOME ?? process.cwd()}/.local/bin/agy`;
}

/** The same lookup without the failure: where the CLI is, or null when it is not there. */
export function findAgyBinary(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const resolved = resolveAgyBinary(env);
  return isExecutable(resolved) ? resolved : null;
}

/**
 * The MiniMax CLI (`mmx`): the first executable on PATH, else the install
 * under `~/.local/bin`. The CLI version check uses this to inspect the same
 * executable a login shell would find, including the local-bin fallback.
 *
 * Every branch reads the environment it was handed, and the lookup answers
 * about *that* environment: a caller that asks about a machine with no CLI
 * installed must not be handed a path on this one. The last branch is the
 * one that could break that rule -- the Node that runs this process keeps its
 * own bin directory, and `mmx` installed beside it is found there -- so it is
 * consulted only for this machine's home, and never for another one.
 */
export function findMcodeBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string | null {
  const configured = env.MCODE_BIN?.trim() || env.MINIMAX_BIN?.trim();
  if (configured) {
    const resolved = configured.includes(path.sep)
      ? configured
      : findExecutable(configured, env.PATH ?? "");
    if (resolved && isExecutable(resolved)) return resolved;
  }
  const fromPath = findExecutable("mcode", env.PATH ?? "");
  if (fromPath) return fromPath;
  const fromPnpm = findPnpmGlobalBinary("mcode", home, env);
  if (fromPnpm) return fromPnpm;
  if (home === homedir()) {
    const nodeDirCandidate = path.join(path.dirname(process.execPath), "mcode");
    if (isExecutable(nodeDirCandidate)) return nodeDirCandidate;
  }
  const local = path.join(home, ".local", "bin", "mcode");
  return isExecutable(local) ? local : null;
}

/**
 * The Codex App tools plugin, without depending on a version that Codex
 * Desktop may replace on its next startup.
 */
export function findCodexAppMcpServer(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): CodexAppMcpServer | null {
  const codeHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const cacheRoot = path.join(
    codeHome,
    "plugins",
    "cache",
    BUNDLED_MARKETPLACE,
    "codex-app-tools"
  );
  if (!existsSync(cacheRoot)) return null;
  const versions = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => NUMERIC_COLLATOR.compare(right, left));
  for (const version of versions) {
    const cwd = path.join(cacheRoot, version);
    const command = path.join(cwd, "scripts", "launch_codex_app_tools_mcp");
    if (isExecutable(command) && existsSync(path.join(cwd, "server.mjs"))) {
      return { command, args: ["./server.mjs"], cwd };
    }
  }
  return null;
}

/**
 * The CodeGraphContext CLI: `AUTODEV_CODEGRAPHCONTEXT_BIN` as given, else the
 * first executable on PATH, else pipx's `~/.local/bin` install.
 */
export function resolveCodeGraphContextBinary(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const configured = env.AUTODEV_CODEGRAPHCONTEXT_BIN;
  if (configured) return configured;
  const candidate =
    findExecutable("codegraphcontext", env.PATH) ??
    (env.HOME ? path.join(env.HOME, ".local/bin/codegraphcontext") : null);
  return candidate && isExecutable(candidate) ? candidate : null;
}

/**
 * The CocoIndex Code CLI (`ccc`): `AUTODEV_COCOINDEX_BIN` as given, else
 * pipx's `~/.local/bin` install, else the first executable on PATH.
 *
 * The install is looked for before PATH because pipx's is the copy AutoDev
 * installed, and it is looked for at all because the home it lives in is not
 * necessarily the process's own. Under a home that holds no install that path
 * names a file that is not there, and answering with it would report an
 * installed tool as missing while a working copy sits on PATH.
 */
export function resolveCocoIndexBinary(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const configured = env.AUTODEV_COCOINDEX_BIN;
  if (configured) return configured;
  const installed = env.HOME ? path.join(env.HOME, ".local/bin/ccc") : null;
  if (installed && isExecutable(installed)) return installed;
  return findExecutable("ccc", env.PATH);
}
